//go:generate mockery --all --inpackage --case snake

package middleware

import (
	"base-be-golang/shared/payload"
	"encoding/json"
	"fmt"
	"mime/multipart"

	"github.com/gin-gonic/gin"
	en2 "github.com/go-playground/locales/en"
	ut "github.com/go-playground/universal-translator"
	"github.com/go-playground/validator/v10"
	translations_en "github.com/go-playground/validator/v10/translations/en"
	"github.com/google/uuid"

	"regexp"
	"strconv"
	"time"

	"reflect"
	"strings"

	"github.com/pkg/errors"
)

type Enigma struct {
	engine *validator.Validate
	trans  ut.Translator
}

func NewEnigma() Enigma {
	engine := validator.New()
	engine.RegisterTagNameFunc(func(field reflect.StructField) string {
		name := strings.SplitN(field.Tag.Get("json"), ",", 2)[0]

		if name == "-" {
			return ""
		}

		return name
	})
	err := engine.RegisterValidation("enum", validateEnumValue)
	if err != nil {

		return Enigma{}
	}

	err = engine.RegisterValidation("monthyearformat", validateMonthYearFormat)
	if err != nil {

		return Enigma{}
	}

	en := en2.New()
	uni := ut.New(en, en)
	trans, _ := uni.GetTranslator("en")
	err = translations_en.RegisterDefaultTranslations(engine, trans)
	if err != nil {

		fmt.Println("new validator: ", err)
		return Enigma{}
	}

	err = OverrideTranslation(engine, trans)
	if err != nil {

		fmt.Println("new validator: ", err)
		return Enigma{}
	}

	return Enigma{
		engine: engine,
		trans:  trans,
	}
}

func (v Enigma) Validate(c *gin.Context, payload any) map[string][]string {
	errs := make(map[string][]string)
	err := v.engine.StructCtx(c.Request.Context(), payload)
	if err != nil {

		var errVals validator.ValidationErrors
		if errors.As(err, &errVals) {
			for i, _ := range errVals {
				errs[errVals[i].Field()] = []string{errVals[i].Translate(v.trans)}
			}

			return errs
		}
		return errs
	}

	return nil
}

func (v Enigma) BindAndValidate(c *gin.Context, payload any) map[string][]string {
	var err error
	if c.ContentType() == gin.MIMEMultipartPOSTForm {
		err = c.ShouldBind(payload)
	} else {
		err = c.Bind(payload)
	}
	if err != nil {

		var errJSON *json.UnmarshalTypeError
		if errors.As(err, &errJSON) {
			field := errJSON.Field
			errVal := errJSON.Error()
			return map[string][]string{
				field: {errVal},
			}
		}
		return map[string][]string{
			"error": {err.Error()},
		}
	}
	return v.Validate(c, payload)
}

func (v Enigma) BindQueryToFilter(c *gin.Context, payload interface{}) error {
	return v.queryToFilter(c, payload, false)
}

func (v Enigma) validate(payload any) map[string][]string {
	errs := make(map[string][]string)
	err := v.engine.Struct(payload)
	if err != nil {
		var errVals validator.ValidationErrors
		if errors.As(err, &errVals) {
			for i, _ := range errVals {
				errs[errVals[i].Field()] = []string{errVals[i].Translate(v.trans)}
			}

			return errs
		}
		return errs
	}

	return errs
}

func (v Enigma) BindQueryToFilterAndValidate(c *gin.Context, payload interface{}) map[string][]string {
	err := v.BindQueryToFilter(c, payload)
	if err != nil {
		return map[string][]string{
			"error": {err.Error()},
		}
	}

	return v.validate(payload)
}

func (v Enigma) queryToFilter(c *gin.Context, payload interface{}, isDive bool) error {
	pVal, pType, vals, err := v.preparingReflection(payload, isDive)
	if err != nil {
		return err
	}

	for i := 0; i < vals.NumField(); i++ {
		tagKeyVal := strings.Split(pType.Elem().Field(i).Tag.Get("bindQuery"), ";")

		var tags = map[string]string{}
		for j := 0; j < len(tagKeyVal); j += 1 {
			if tagKeyVal[j] == "" {
				continue
			}
			keyVals := strings.Split(tagKeyVal[j], "=")
			if len(keyVals) < 2 {
				return fmt.Errorf("there is invalid tags")
			}
			tags[keyVals[0]] = keyVals[1]
		}

		var reqField = pType.Elem().Field(i).Tag.Get("json")
		if rn, ok := tags[reqName]; ok {
			reqField = rn
		}

		if _, ok := tags["ignore"]; ok {
			continue
		}

		if _, ok := tags["dive"]; ok {
			child := pVal.Elem().Field(i).Interface()
			err := v.queryToFilter(c, child, true)
			if err != nil {
				return err
			}

			vals.Field(i).Set(reflect.ValueOf(child))
			continue
		}

		reqVal := getFromRequest(c, tags[reqPlace], reqField)
		var (
			finalVal interface{}
			err      error
		)
		if binder, ok := bindingRules[tags["dataType"]]; ok {
			finalVal, err = binder(c, reqVal, tags)
			if err != nil {
				return err
			}
			vals.Field(i).Set(reflect.ValueOf(finalVal))
			continue
		}
		vals.Field(i).Set(reflect.ValueOf(reqVal))

	}

	return nil
}

func (v Enigma) preparingReflection(payload interface{}, isDive bool) (reflect.Value, reflect.Type, reflect.Value, error) {
	pVal := reflect.ValueOf(payload)
	pType := reflect.TypeOf(payload)
	if
	//pVal.Kind() != reflect.Pointer||
	pVal.IsNil() {
		return reflect.Value{}, nil, reflect.Value{}, fmt.Errorf("payload is nil")
	}

	vals := pVal.Elem()
	if vals.Kind() != reflect.Struct && !isDive {
		return reflect.Value{}, nil, reflect.Value{}, fmt.Errorf("payload should be struct")
	}
	return pVal, pType, vals, nil
}

/*
*
============ OWNERSHIP TO QUERY BINDING ===============
*/
const (
	dataType = "dataType"
	format   = "format"
	reqPlace = "reqPlace" // pathVariable | queryParams
	reqName  = "reqName"

	DataIsTime    = "timestamp"
	DataIsInteger = "integer"
	DataIsLong    = "bigint"
	DataIsFloat   = "float"
	DataIsString  = "string"
	DataIsBoolean = "boolean"
	DataIsUUID    = "uuid"
)

type BindingFunc func(gCtx *gin.Context, val string, rules map[string]string) (interface{}, error)

var (
	bindingRules = map[string]BindingFunc{
		DataIsTime: func(gCtx *gin.Context, val string, rules map[string]string) (interface{}, error) {
			var format = time.RFC3339
			if _, ok := rules["notNull"]; !ok && val == "" {
				return time.Time{}, nil
			}

			if f, ok := rules["format"]; ok {
				format = f
			}

			var tz *time.Location
			if dt, ok := gCtx.Get(string(payload.AuthCodeContext)); ok {
				d, ok := dt.(payload.UserData)
				if !ok {
					return time.Time{}, fmt.Errorf("clock location not found")
				}
				if d.Tz != nil {
					tz = d.Tz
				}
			}

			date, err := time.ParseInLocation(format, val, tz)
			if err != nil {
				return time.Time{}, err
			}

			return date, nil
		},
		DataIsInteger: func(gCtx *gin.Context, val string, rules map[string]string) (interface{}, error) {
			if _, ok := rules["notNull"]; !ok && val == "" {
				return 0, nil
			}

			num, err := strconv.ParseInt(val, 10, 64)
			if err != nil {
				return 0, err
			}

			return int(num), nil
		},
		DataIsLong: func(gCtx *gin.Context, val string, rules map[string]string) (interface{}, error) {
			if _, ok := rules["notNull"]; !ok && val == "" {
				return uint(0), nil
			}

			num, err := strconv.ParseUint(val, 10, 64)
			if err != nil {
				return uint(0), err
			}

			return uint(num), nil
		},
		DataIsString: func(gCtx *gin.Context, val string, rules map[string]string) (interface{}, error) {
			if pattern, ok := rules["regex"]; ok {
				regx, err := regexp.Compile(pattern)
				if err != nil {
					return "", err
				}

				if !regx.MatchString(val) {
					return "", fmt.Errorf("format regex not match with: " + val)
				}
			}
			return val, nil
		},
		DataIsBoolean: func(gCtx *gin.Context, val string, rules map[string]string) (interface{}, error) {
			if _, ok := rules["notNull"]; !ok && val == "" {
				return false, nil
			}

			num, err := strconv.ParseBool(val)
			if err != nil {
				return false, err
			}

			return num, nil
		},
		DataIsFloat: func(gCtx *gin.Context, val string, rules map[string]string) (interface{}, error) {
			if _, ok := rules["notNull"]; !ok && val == "" {
				return float64(0), nil
			}

			num, err := strconv.ParseFloat(val, 64)
			if err != nil {
				return float64(0), err
			}

			return num, nil
		},
		DataIsUUID: func(gCtx *gin.Context, val string, rules map[string]string) (interface{}, error) {
			if _, ok := rules["notNull"]; !ok && val == "" {
				return uuid.UUID{}, nil
			}

			id, err := uuid.Parse(val)
			if err != nil {
				return uuid.UUID{}, err
			}

			return id, nil
		},
	}
	getFromRequest = func(c *gin.Context, place string, fieldName string) string {
		switch place {
		case "pathVariable":
			return c.Param(fieldName)
		case "queryParams":
			return c.Query(fieldName)
		default:
			return c.Query(fieldName)
		}
	}
)

/*
*
============ OWNERSHIP TO MULTIPART BINDING ===============
*/
const (
	FormFile     = "file"
	FormText     = "text"
	FormUint     = "uint"
	FormInt      = "int"
	FormFloat    = "float"
	FormBool     = "bool"
	FormArray    = "array"
	ArrayCounter = "arrayNaming"
)

type FileCompacted struct {
	File     multipart.File
	FileInfo *multipart.FileHeader
}
