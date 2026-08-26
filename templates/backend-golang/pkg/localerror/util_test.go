package localerror

import (
	"base-be-golang/pkg/logger"
	"errors"
	"testing"

	"gorm.io/gorm"
)

func TestHandleError_NilLogger(t *testing.T) {
	h := NewHandlerError(nil)

	t.Run("ErrorPrint does not panic", func(t *testing.T) {
		h.ErrorPrint(errors.New("some error"))
		h.ErrorPrint(nil)
	})

	t.Run("DebugPrint does not panic", func(t *testing.T) {
		h.DebugPrint("debug message: %s", "arg")
	})

	t.Run("ErrorReturn with nil error", func(t *testing.T) {
		err := h.ErrorReturn(nil)
		if err != nil {
			t.Errorf("expected nil, got %v", err)
		}
	})

	t.Run("ErrorReturn with regular error", func(t *testing.T) {
		inputErr := errors.New("db connection lost")
		err := h.ErrorReturn(inputErr)
		if err == nil {
			t.Fatal("expected error, got nil")
		}
		var internalErr InternalError
		if !errors.As(err, &internalErr) {
			t.Errorf("expected InternalError, got %T: %v", err, err)
		}
		if internalErr.Error() != inputErr.Error() {
			t.Errorf("expected '%s', got '%s'", inputErr.Error(), internalErr.Error())
		}
	})

	t.Run("ErrorReturn preserves InvalidDataError", func(t *testing.T) {
		invErr := InvalidData("invalid input")
		err := h.ErrorReturn(invErr)
		if !IsInvalidData(err) {
			t.Errorf("expected InvalidDataError, got %v", err)
		}
	})

	t.Run("ErrorReturn preserves AccessControlError", func(t *testing.T) {
		accErr := AccessControlError{Msg: "SessionExpired"}
		err := h.ErrorReturn(accErr)
		if !IsAccessNotAllowedUserNotFound(err) {
			t.Errorf("expected AccessControlError, got %v", err)
		}
	})
}

func TestHandleError_UninitializedReZeroPointer(t *testing.T) {
	// ReZero pointer with nil internal logger
	emptyReZero := &logger.ReZero{}
	h := NewHandlerError(emptyReZero)

	t.Run("ErrorPrint does not panic", func(t *testing.T) {
		h.ErrorPrint(errors.New("some error"))
	})

	t.Run("DebugPrint does not panic", func(t *testing.T) {
		h.DebugPrint("debug message")
	})

	t.Run("ErrorReturn does not panic", func(t *testing.T) {
		err := h.ErrorReturn(errors.New("internal failure"))
		if err == nil {
			t.Fatal("expected error, got nil")
		}
		var internalErr InternalError
		if !errors.As(err, &internalErr) {
			t.Errorf("expected InternalError, got %T", err)
		}
	})
}

func TestHandleError_InitializedLogger(t *testing.T) {
	l := logger.DefaultLogger()
	h := NewHandlerError(&l)

	t.Run("ErrorPrint does not panic", func(t *testing.T) {
		h.ErrorPrint(errors.New("logged error"))
	})

	t.Run("DebugPrint does not panic", func(t *testing.T) {
		h.DebugPrint("logged debug: %d", 42)
	})

	t.Run("ErrorReturn wraps error in InternalError", func(t *testing.T) {
		err := h.ErrorReturn(errors.New("db failure"))
		if err == nil {
			t.Fatal("expected error, got nil")
		}
		var internalErr InternalError
		if !errors.As(err, &internalErr) {
			t.Errorf("expected InternalError, got %T", err)
		}
	})
}

func TestHelperFunctions_NilSafety(t *testing.T) {
	t.Run("IsNotFound with nil", func(t *testing.T) {
		if IsNotFound(nil) {
			t.Error("expected false for IsNotFound(nil)")
		}
	})

	t.Run("IsNotFound with InvalidDataError", func(t *testing.T) {
		err := InvalidData("not found item")
		if !IsNotFound(err) {
			t.Error("expected true for IsNotFound(InvalidDataError)")
		}
	})

	t.Run("IsNotFoundStr with nil", func(t *testing.T) {
		if IsNotFoundStr("target", nil) {
			t.Error("expected false for IsNotFoundStr(target, nil)")
		}
	})

	t.Run("IsNotFoundStr with match and mismatch", func(t *testing.T) {
		err := InvalidData("match")
		if !IsNotFoundStr("match", err) {
			t.Error("expected true for match")
		}
		if IsNotFoundStr("other", err) {
			t.Error("expected false for other")
		}
	})

	t.Run("IsInvalidData with nil and non-nil", func(t *testing.T) {
		if IsInvalidData(nil) {
			t.Error("expected false for nil")
		}
		if !IsInvalidData(InvalidData("invalid")) {
			t.Error("expected true for InvalidData")
		}
		if IsInvalidData(errors.New("standard error")) {
			t.Error("expected false for standard error")
		}
	})

	t.Run("AccessNotAllowedUserNotFound", func(t *testing.T) {
		if AccessNotAllowedUserNotFound(nil) != nil {
			t.Error("expected nil for nil input")
		}
		err := AccessNotAllowedUserNotFound(gorm.ErrRecordNotFound)
		if !IsAccessNotAllowedUserNotFound(err) {
			t.Error("expected AccessControlError for gorm.ErrRecordNotFound")
		}
		otherErr := errors.New("other")
		if AccessNotAllowedUserNotFound(otherErr) != otherErr {
			t.Error("expected other error to pass through")
		}
	})

	t.Run("NotFound helper", func(t *testing.T) {
		if NotFound(nil, "item missing") != nil {
			t.Error("expected nil for nil input")
		}
		err := NotFound(gorm.ErrRecordNotFound, "item missing")
		if err == nil || err.Error() != "item missing" {
			t.Errorf("expected 'item missing', got %v", err)
		}
	})

	t.Run("InvalidDataWithData", func(t *testing.T) {
		data := map[string]string{"field": "required"}
		err := InvalidDataWithData("bad input", data)
		invErr, ok := err.(InvalidDataError)
		if !ok {
			t.Fatalf("expected InvalidDataError, got %T", err)
		}
		if invErr.DataToTemplated["field"] != "required" {
			t.Errorf("expected data field 'required', got %v", invErr.DataToTemplated)
		}
	})
}
