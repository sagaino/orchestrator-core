package logger

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestReZero_NilReceiver(t *testing.T) {
	var l *ReZero = nil

	t.Run("Info does not panic", func(t *testing.T) {
		l.Info("info message")
	})

	t.Run("Infof does not panic", func(t *testing.T) {
		l.Infof("info %s", "formatted")
	})

	t.Run("Error with nil and non-nil error", func(t *testing.T) {
		l.Error(errors.New("test error"))
		l.Error(nil)
	})

	t.Run("Errorf does not panic", func(t *testing.T) {
		l.Errorf("error %d", 500)
	})

	t.Run("ErrorWithMsg with nil and non-nil error", func(t *testing.T) {
		l.ErrorWithMsg(errors.New("test error"), "extra message")
		l.ErrorWithMsg(nil, "extra message")
	})

	t.Run("Warn does not panic", func(t *testing.T) {
		l.Warn("warning message")
	})

	t.Run("Warnf does not panic", func(t *testing.T) {
		l.Warnf("warning %s", "formatted")
	})

	t.Run("Debug does not panic", func(t *testing.T) {
		l.Debug("debug message")
	})

	t.Run("Debugf does not panic", func(t *testing.T) {
		l.Debugf("debug %s", "formatted")
	})

	t.Run("Println does not panic", func(t *testing.T) {
		l.Println("print line message")
	})

	t.Run("LoggingRequest does not panic", func(t *testing.T) {
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		req, _ := http.NewRequest(http.MethodGet, "/test", nil)
		c.Request = req
		l.LoggingRequest(c)
	})
}

func TestReZero_NilInternalLogger(t *testing.T) {
	l := &ReZero{logger: nil}

	t.Run("Info does not panic", func(t *testing.T) {
		l.Info("info message")
	})

	t.Run("Infof does not panic", func(t *testing.T) {
		l.Infof("info %s", "formatted")
	})

	t.Run("Error with nil and non-nil error", func(t *testing.T) {
		l.Error(errors.New("test error"))
		l.Error(nil)
	})

	t.Run("Errorf does not panic", func(t *testing.T) {
		l.Errorf("error %d", 500)
	})

	t.Run("ErrorWithMsg with nil and non-nil error", func(t *testing.T) {
		l.ErrorWithMsg(errors.New("test error"), "extra message")
		l.ErrorWithMsg(nil, "extra message")
	})

	t.Run("Warn does not panic", func(t *testing.T) {
		l.Warn("warning message")
	})

	t.Run("Warnf does not panic", func(t *testing.T) {
		l.Warnf("warning %s", "formatted")
	})

	t.Run("Debug does not panic", func(t *testing.T) {
		l.Debug("debug message")
	})

	t.Run("Debugf does not panic", func(t *testing.T) {
		l.Debugf("debug %s", "formatted")
	})

	t.Run("Println does not panic", func(t *testing.T) {
		l.Println("print line message")
	})

	t.Run("LoggingRequest does not panic", func(t *testing.T) {
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		req, _ := http.NewRequest(http.MethodGet, "/test", nil)
		c.Request = req
		l.LoggingRequest(c)
	})
}

func TestReZero_InitializedLogger(t *testing.T) {
	l := DefaultLogger()

	t.Run("Info logs message", func(t *testing.T) {
		l.Info("info message")
	})

	t.Run("Infof logs formatted message", func(t *testing.T) {
		l.Infof("info: %s", "ok")
	})

	t.Run("Error logs error", func(t *testing.T) {
		l.Error(errors.New("sample error"))
		l.Error(nil)
	})

	t.Run("Errorf logs formatted error", func(t *testing.T) {
		l.Errorf("error: %s", "fatal problem")
	})

	t.Run("ErrorWithMsg logs error and message", func(t *testing.T) {
		l.ErrorWithMsg(errors.New("sample error"), "context msg")
		l.ErrorWithMsg(nil, "context msg only")
	})

	t.Run("Warn and Warnf log warning", func(t *testing.T) {
		l.Warn("warn message")
		l.Warnf("warn: %d", 123)
	})

	t.Run("Debug and Debugf log debug", func(t *testing.T) {
		l.Debug("debug message")
		l.Debugf("debug: %s", "val")
	})

	t.Run("Println logs message", func(t *testing.T) {
		l.Println("println msg")
	})

	t.Run("LoggingRequest with context", func(t *testing.T) {
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		req, _ := http.NewRequest(http.MethodGet, "/api/v1/test", nil)
		c.Request = req
		l.LoggingRequest(c)
	})
}

func TestPackageLevelLogFunctions(t *testing.T) {
	t.Run("Standalone functions do not panic", func(t *testing.T) {
		Infof("package infof %s", "test")
		Error(errors.New("package error"))
		Error(nil)
		Errorf("package errorf %d", 1)
		Warn("package warn")
		Warnf("package warnf %s", "test")
		Debug("package debug")
	})
}
