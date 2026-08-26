package mapper

import (
	"fmt"
	"math"
	"reflect"
	"strconv"
	"strings"
	"time"
)

type SortingDirection string

const (
	SortingAscending  = SortingDirection("ASC")
	SortingDescending = SortingDirection("DESC")
	KindIsTime        = reflect.Kind(27)
)

var (
	stringAsc = func(prev reflect.Value, next reflect.Value, fieldName string) (interface{}, interface{}) {
		prevStr := strings.ToLower(prev.FieldByName(fieldName).String())
		nextStr := strings.ToLower(next.FieldByName(fieldName).String())

		var baseRange int
		if len(prevStr) > len(nextStr) {
			baseRange = len(nextStr)
		} else {
			baseRange = len(prevStr)
		}

		for i := 0; i < baseRange; i++ {
			switch {
			case prevStr[i] < nextStr[i]:
				return prev.Interface(), next.Interface()
			case prevStr[i] > nextStr[i]:
				return next.Interface(), prev.Interface()
			case prevStr[i] == nextStr[i]:
				continue
			}
		}

		if len(prevStr) > len(nextStr) {
			return next.Interface(), prev.Interface()
		} else {
			return next.Interface(), prev.Interface()
		}
	}

	stringDesc = func(prev reflect.Value, next reflect.Value, fieldName string) (interface{}, interface{}) {
		newPrev, newNext := stringAsc(prev, next, fieldName)
		return newNext, newPrev
	}

	sortingFunc = map[SortingDirection]map[reflect.Kind]func(prev reflect.Value, next reflect.Value, fieldName string) (interface{}, interface{}){
		SortingAscending: {
			reflect.String: stringAsc,
			reflect.Int: func(prev, next reflect.Value, fieldName string) (interface{}, interface{}) {
				prevNum := prev.FieldByName(fieldName).Int()
				nextNum := next.FieldByName(fieldName).Int()
				if prevNum > nextNum {
					return next.Interface(), prev.Interface()
				}
				return prev.Interface(), next.Interface()
			},
			reflect.Uint: func(prev, next reflect.Value, fieldName string) (interface{}, interface{}) {
				prevNum := prev.FieldByName(fieldName).Uint()
				nextNum := next.FieldByName(fieldName).Uint()
				if prevNum > nextNum {
					return next.Interface(), prev.Interface()
				}
				return prev.Interface(), next.Interface()
			},
			KindIsTime: func(prev, next reflect.Value, fieldName string) (interface{}, interface{}) {
				prevDate := prev.FieldByName(fieldName).Interface().(time.Time)
				nextDate := next.FieldByName(fieldName).Interface().(time.Time)
				if prevDate.After(nextDate) {
					return next.Interface(), prev.Interface()
				}
				return prev.Interface(), next.Interface()
			},
		},
		SortingDescending: {
			reflect.String: stringDesc,
			KindIsTime: func(prev reflect.Value, next reflect.Value, fieldName string) (interface{}, interface{}) {
				prevDate := prev.FieldByName(fieldName).Interface().(time.Time)
				nextDate := next.FieldByName(fieldName).Interface().(time.Time)
				if prevDate.Before(nextDate) {
					return next.Interface(), prev.Interface()
				}
				return prev.Interface(), next.Interface()
			},
		},
	}
)

func (m Mapper) typeIsArray(vals interface{}) bool {
	pVal := reflect.ValueOf(vals)
	if pVal.Kind() != reflect.Slice && pVal.Kind() != reflect.Array {
		return false
	}

	return true
}

func (m Mapper) ContainByStructField(target interface{}, fieldName string, val interface{}) bool {
	pVal := reflect.ValueOf(target)
	if !m.typeIsArray(target) {
		return false
	}

	for i := 0; i < pVal.Len(); i++ {
		tr := pVal.Index(i).Interface()
		v := reflect.ValueOf(tr).FieldByName(fieldName).Interface()
		if reflect.DeepEqual(v, val) {
			return true
		}
	}

	return false
}

func (m Mapper) UniqueByStructField(vals interface{}, fieldName string) interface{} {
	var newArr = make([]interface{}, 0)
	pVal := reflect.ValueOf(vals)
	if !m.typeIsArray(vals) || pVal.Len() == 0 {
		return newArr
	}

	newArr = append(newArr, pVal.Index(0).Interface())
	for i := 1; i < pVal.Len(); i++ {
		val := pVal.Index(i).FieldByName(fieldName).Interface()
		if !m.ContainByStructField(newArr, fieldName, val) {
			newArr = append(newArr, pVal.Index(i).Interface())
		}
	}

	return newArr
}

func (m Mapper) SortingByStructField(vals interface{}, fieldName string, sorting SortingDirection) interface{} {
	pVal := reflect.ValueOf(vals)
	if !m.typeIsArray(vals) {
		fmt.Println("SortingByStructField: val type should array")
		return vals
	}

	var newArr = make([]interface{}, pVal.Len())
	for i := 0; i < pVal.Len(); i++ {
		newArr[i] = pVal.Index(i).Interface()
	}

	for i := 0; i < len(newArr)-1; i++ {
		currentVal := pVal.Index(i).FieldByName(fieldName)
		kind := currentVal.Kind()
		if currentVal.Kind() == reflect.Struct {
			pType := reflect.TypeOf(currentVal.Interface())
			if pType.Name() == "Time" {
				kind = KindIsTime
			}
		}
		fn := sortingFunc[sorting][kind]
		prev, next := fn(reflect.ValueOf(newArr[i]), reflect.ValueOf(newArr[i+1]), fieldName)
		newArr[i] = prev
		newArr[i+1] = next
	}

	return newArr
}

func (m Mapper) ParseServiceDurationFormat(d string) (string, error) {
	ds := strings.Split(d, ":")

	var digits = make([]int, len(ds))
	for i, _ := range ds {
		d, err := strconv.ParseInt(ds[i], 10, 64)
		if err != nil {

			return "", err
		}
		digits[i] = int(d)
	}

	duration, err := time.ParseDuration(fmt.Sprintf(
		"%dh%dm%ds",
		digits[0],
		digits[1],
		digits[2],
	))
	if err != nil {

		return "", err
	}
	inHours := duration.Hours()

	inDay := inHours / 24
	inHours = math.Mod(inHours, float64(24))

	var durationStr string
	if inDay >= 1 {
		durationStr = durationStr + fmt.Sprintf("%d Hari ", int(inDay))
	}
	durationStr = durationStr + fmt.Sprintf("%.1f Jam", inHours)

	return durationStr, nil
}
