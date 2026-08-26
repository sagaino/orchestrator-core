package localerror

import (
	"base-be-golang/pkg/logger"
	"errors"

	"gorm.io/gorm"
)

type InvalidDataError struct {
	Msg             string
	DataToTemplated map[string]string
}

func (e InvalidDataError) Error() string {
	return e.Msg
}

func (e InvalidDataError) Is(target error) bool {
	if t, ok := target.(InvalidDataError); ok {
		return e.Msg == t.Msg
	}
	if t, ok := target.(*InvalidDataError); ok && t != nil {
		return e.Msg == t.Msg
	}
	return false
}

type AccessControlError struct {
	Msg string
}

func (e AccessControlError) Error() string {
	return e.Msg
}

func AccessNotAllowedUserNotFound(err error) error {
	if err != nil && errors.Is(err, gorm.ErrRecordNotFound) {
		return AccessControlError{Msg: "SessionExpired"}
	}

	return err
}

func IsAccessNotAllowedUserNotFound(err error) bool {
	return err != nil && errors.Is(err, AccessControlError{Msg: "SessionExpired"})
}

func IsNotFound(err error) bool {
	if err == nil {
		return false
	}
	return errors.Is(err, InvalidDataError{Msg: err.Error()})
}

func IsInvalidData(err error) bool {
	return err != nil && errors.As(err, &InvalidDataError{})
}

func NotFound(err error, msg string) error {
	if err != nil && errors.Is(err, gorm.ErrRecordNotFound) {
		return InvalidDataError{Msg: msg}
	}
	return err
}

func IsNotFoundStr(target string, source error) bool {
	if source == nil {
		return false
	}
	var newErr = InvalidDataError{}
	if errors.As(source, &newErr) {
		return target == newErr.Msg
	}

	return false
}

func InvalidData(msg string) error {
	return InvalidDataError{Msg: msg}
}

func InvalidDataWithData(msg string, data map[string]string) error {
	return InvalidDataError{Msg: msg, DataToTemplated: data}
}

type InternalError struct {
	Msg string
}

func (receiver InternalError) Error() string {
	return receiver.Msg
}

type HandleError struct {
	logger *logger.ReZero
}

func NewHandlerError(lg *logger.ReZero) HandleError {
	return HandleError{
		logger: lg,
	}
}

func (h HandleError) ErrorPrint(err error) {
	if err != nil && h.logger != nil {
		h.logger.Error(err)
	}
}

func (h HandleError) DebugPrint(err string, v ...interface{}) {
	if h.logger != nil {
		h.logger.Debugf(err, v...)
	}
}

func (h HandleError) ErrorReturn(err error) error {
	if err == nil {
		return nil
	}

	if IsAccessNotAllowedUserNotFound(err) ||
		IsNotFound(err) || IsInvalidData(err) {
		return err
	}

	if h.logger != nil {
		h.logger.Error(err)
	}
	return InternalError{err.Error()}
}
