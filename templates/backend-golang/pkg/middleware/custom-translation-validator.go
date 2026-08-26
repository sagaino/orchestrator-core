package middleware

import (
	"fmt"
	ut "github.com/go-playground/universal-translator"
	"github.com/go-playground/validator/v10"
)

func OverrideTranslation(engine *validator.Validate, trans ut.Translator) error {
	err := engine.RegisterTranslation("trx-status", trans, func(ut ut.Translator) error {
		return ut.Add("trx-status", "{0} bukan status yang valid", true)
	}, func(ut ut.Translator, fe validator.FieldError) string {
		t, _ := ut.T("trx-status", fe.Field())
		return t
	})
	if err != nil {
		fmt.Println(err)
		return err
	}

	err = engine.RegisterTranslation("monthyearformat", trans, func(ut ut.Translator) error {
		return ut.Add("monthyearformat", "{0} format harus mm-yyyy", true)
	}, func(ut ut.Translator, fe validator.FieldError) string {
		t, _ := ut.T("monthyearformat", fe.Field())
		return t
	})
	if err != nil {
		fmt.Println(err)
		return err
	}

	return nil
}
