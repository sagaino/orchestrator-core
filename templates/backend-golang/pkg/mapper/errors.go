package mapper

import (
	localerror2 "base-be-golang/pkg/localerror"
	"base-be-golang/pkg/localize"
	"base-be-golang/pkg/middleware"
	"base-be-golang/shared/payload"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgconn"
)

func (m Mapper) TranslateSQLErr(pgErr *pgconn.PgError, methodName string) error {
	switch pgErr.Code {
	case DuplicateEntryCode:
		if pgErr.ConstraintName != "" {
			switch pgErr.ConstraintName {
			default:
				return pgErr
			}
		}
		return pgErr

	case DataTruncateCode:
		re := regexp.MustCompile(`for column "([^"]+)`)
		msgs := re.FindStringSubmatch(pgErr.Message)
		if len(msgs) > 1 {
			switch msgs[1] {
			case "gender":
			default:
				return pgErr
			}
		}
		return fmt.Errorf("%s: %w", methodName, pgErr)

	case ForeignConstrainFailCode:
		if pgErr.ConstraintName != "" {
			switch pgErr.ConstraintName {
			default:
				return pgErr
			}
		}

	default:
		return pgErr
	}

	return pgErr

}

func (receiver Mapper) GetAuthDataFromContext(c *gin.Context) middleware.UserData {
	authDataStr, ok := c.Get("authData")
	if !ok {
		return middleware.UserData{}
	}
	authData := authDataStr.(middleware.UserData)
	return authData
}

func (m Mapper) NewResponse(c *gin.Context, res *payload.Response, err error) {
	userData := m.GetAuthDataFromContext(c)
	if err != nil {
		if ok, invErr := m.IsInvalidDataError(err); ok {
			var templates = make([]localize.TemplatingData, 0)
			if invErr.DataToTemplated != nil {
				for key, val := range invErr.DataToTemplated {
					templates = append(templates, localize.TemplatingData{
						Name:  key,
						Value: val,
					})
				}
			}
			c.JSON(
				http.StatusBadRequest,
				payload.DefaultErrorInvalidDataWithCode(http.StatusBadRequest, m.localizer.GetLocalized(userData.Lang, err.Error(), templates...)),
			)
			return
		}
		if m.IsAccessControlError(err) {
			c.JSON(
				http.StatusUnauthorized,
				payload.DefaultErrorInvalidDataWithCode(http.StatusUnauthorized, m.localizer.GetLocalized(userData.Lang, err.Error())),
			)
			return
		}
		middleware.CaptureError(c, err)
		fmt.Printf("ERROR: %s \n", err.Error())
		c.JSON(
			http.StatusInternalServerError,
			payload.DefaultErrorResponseWithMessage(m.localizer.GetLocalized(userData.Lang, "InternalError"), err),
		)
		return
	}
	if res != nil {
		if res.Code == 0 {
			res.Code = http.StatusOK
		}
		res.Message = m.localizer.GetLocalized(userData.Lang, res.Message)
		c.JSON(res.Code, res)
		return
	}

	c.Status(http.StatusOK)
}

func (m Mapper) IsInvalidDataError(err error) (bool, localerror2.InvalidDataError) {
	var invalidDataError localerror2.InvalidDataError
	if errors.As(err, &invalidDataError) {
		return true, invalidDataError
	}
	return false, invalidDataError
}

func (m Mapper) IsAccessControlError(err error) bool {
	var invalidDataError localerror2.AccessControlError
	if errors.As(err, &invalidDataError) {
		return true
	}
	return false
}

func (m Mapper) CompareSliceOfErr(errs []error, target error) bool {
	for _, err := range errs {
		if errors.Is(err, target) {
			return true
		}
		if m.ErrorIs(err, target) {
			return true
		}
	}

	return false
}

func (m Mapper) ErrorIs(template error, targer error) bool {
	re := regexp.MustCompile(`\{[0-9]+}`)
	pattern := re.ReplaceAllString(template.Error(), ".+")

	match, err := regexp.MatchString(pattern+"$", targer.Error())
	if err != nil {

		return false
	}

	if match {
		return true
	}

	return false
}

func (m Mapper) ReplaceLabelErr(template error, params ...string) error {
	customeErr := template.Error()
	for i, param := range params {
		customeErr = strings.Replace(
			customeErr,
			fmt.Sprintf("{%d}", i),
			param,
			-1,
		)
	}

	return fmt.Errorf(customeErr)
}
