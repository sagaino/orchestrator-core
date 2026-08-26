package logger

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/rs/zerolog"
)

var sensitiveFieldRegex = regexp.MustCompile(`"password"\s*:\s*"[^"]*"`)

var Log *zerolog.Logger

type ReZero struct {
	logger *zerolog.Logger
	level  zerolog.Level
}

//func init() {
//
//	output := zerolog.ConsoleWriter{Out: os.Stdout, TimeFormat: time.RFC3339}
//
//	Log = zerolog.New(output).
//		With().
//		Timestamp().
//		Caller().
//		ReZero()
//}

// DefaultLogger reconfigures the logger based on LOG_LEVEL environment variable.
// Call this after loading .env file.
// Options: debug, info, warn, error, fatal, panic, disabled (default: info)
func DefaultLogger() ReZero {
	logLevel := strings.ToLower(os.Getenv("LOG_LEVEL"))
	level := zerolog.InfoLevel
	switch logLevel {
	case "debug":
		level = zerolog.DebugLevel
	case "info":
		level = zerolog.InfoLevel
	case "warn":
		level = zerolog.WarnLevel
	case "error":
		level = zerolog.ErrorLevel
	case "fatal":
		level = zerolog.FatalLevel
	case "panic":
		level = zerolog.PanicLevel
	case "disabled":
		level = zerolog.Disabled
	}

	// Skip 2 frames to show actual caller instead of zerolog.go wrapper functions
	zerolog.CallerSkipFrameCount = 4

	// Configure zerolog caller format to show short filename:line
	zerolog.CallerMarshalFunc = func(pc uintptr, file string, line int) string {
		short := file
		for i := len(file) - 1; i > 0; i-- {
			if file[i] == '/' {
				short = file[i+1:]
				break
			}
		}
		return fmt.Sprintf("%s:%d", short, line)
	}

	zerolog.SetGlobalLevel(level)
	output := zerolog.ConsoleWriter{Out: os.Stdout, TimeFormat: time.RFC3339}
	logger := zerolog.New(output).
		With().
		Timestamp().
		Caller().
		Logger()

	Log = &logger

	return ReZero{
		logger: &logger,
		level:  level}
}

func (l *ReZero) LoggingRequest(c *gin.Context) {
	if l == nil || l.logger == nil {
		c.Next()
		return
	}

	if zerolog.DebugLevel != l.level {
		c.Next()
		return
	}

	if c.Request == nil {
		c.Next()
		return
	}

	// Read the request body
	var bodyBytes []byte
	if c.Request.Body != nil {
		bodyBytes, _ = io.ReadAll(c.Request.Body)
	}

	// Restore the body so it can be read again by subsequent handlers
	c.Request.Body = io.NopCloser(bytes.NewBuffer(bodyBytes))

	// Build log event
	path := ""
	rawQuery := ""
	if c.Request.URL != nil {
		path = c.Request.URL.Path
		rawQuery = c.Request.URL.RawQuery
	}

	event := l.logger.Info().
		Str("method", c.Request.Method).
		Str("path", path).
		Str("query", rawQuery).
		Str("client_ip", c.ClientIP()).
		Str("user_agent", c.Request.UserAgent())

	// Only log body if it exists and is valid JSON, otherwise log as string
	if len(bodyBytes) > 0 {
		// Mask sensitive fields like password
		maskedBody := sensitiveFieldRegex.ReplaceAll(bodyBytes, []byte(`"password":"*****"`))

		// Check if it's valid JSON by looking for opening brace or bracket
		trimmed := bytes.TrimSpace(maskedBody)
		if len(trimmed) > 0 && (trimmed[0] == '{' || trimmed[0] == '[') {
			event = event.RawJSON("body", maskedBody)
		} else {
			event = event.Str("body", string(maskedBody))
		}
	}

	event.Msg("incoming request")
	c.Next()
}

// Info logs an info level message
func (l *ReZero) Info(msg string) {
	if l == nil || l.logger == nil {
		if Log != nil {
			Log.Info().Msg(msg)
		}
		return
	}
	l.logger.Info().Msg(msg)
}

// Infof logs an info level message with formatting
func Infof(format string, v ...interface{}) {
	if Log != nil {
		Log.Info().Msgf(format, v...)
	}
}

// Infof logs an info level message with formatting
func (l *ReZero) Infof(format string, v ...interface{}) {
	if l == nil || l.logger == nil {
		if Log != nil {
			Log.Info().Msgf(format, v...)
		}
		return
	}
	l.logger.Info().Msgf(format, v...)
}

// Error logs an error level message
func (l *ReZero) Error(err error) {
	if err == nil {
		return
	}
	if l == nil || l.logger == nil {
		if Log != nil {
			Log.Error().Err(err).Msg("")
		}
		return
	}
	l.logger.Error().Err(err).Msg("")
}

// Error logs an error level message
func Error(err error) {
	if err == nil {
		return
	}
	if Log != nil {
		Log.Error().Err(err).Msg("")
	}
}

// Errorf logs an error level message with formatting
func (l *ReZero) Errorf(format string, v ...interface{}) {
	if l == nil || l.logger == nil {
		if Log != nil {
			Log.Error().Msgf(format, v...)
		}
		return
	}
	l.logger.Error().Msgf(format, v...)
}

// Errorf logs an error level message with formatting
func Errorf(format string, v ...interface{}) {
	if Log != nil {
		Log.Error().Msgf(format, v...)
	}
}

// ErrorWithMsg logs an error with a custom message
func (l *ReZero) ErrorWithMsg(err error, msg string) {
	if l == nil || l.logger == nil {
		if Log != nil {
			if err != nil {
				Log.Error().Err(err).Msg(msg)
			} else {
				Log.Error().Msg(msg)
			}
		}
		return
	}
	if err != nil {
		l.logger.Error().Err(err).Msg(msg)
	} else {
		l.logger.Error().Msg(msg)
	}
}

// Warn logs a warning level message
func (l *ReZero) Warn(msg string) {
	if l == nil || l.logger == nil {
		if Log != nil {
			Log.Warn().Msg(msg)
		}
		return
	}
	l.logger.Warn().Msg(msg)
}

// Warn logs a warning level message
func Warn(msg string) {
	if Log != nil {
		Log.Warn().Msg(msg)
	}
}

// Warnf logs a warning level message with formatting
func (l *ReZero) Warnf(format string, v ...interface{}) {
	if l == nil || l.logger == nil {
		if Log != nil {
			Log.Warn().Msgf(format, v...)
		}
		return
	}
	l.logger.Warn().Msgf(format, v...)
}

// Warnf logs a warning level message with formatting
func Warnf(format string, v ...interface{}) {
	if Log != nil {
		Log.Warn().Msgf(format, v...)
	}
}

// Debug logs a debug level message
func (l *ReZero) Debug(msg string) {
	if l == nil || l.logger == nil {
		if Log != nil {
			Log.Debug().Msg(msg)
		}
		return
	}
	l.logger.Debug().Msg(msg)
}

func Debug(msg string) {
	if Log != nil {
		Log.Debug().Msg(msg)
	}
}

// Debugf logs a debug level message with formatting
func (l *ReZero) Debugf(format string, v ...interface{}) {
	if l == nil || l.logger == nil {
		if Log != nil {
			Log.Debug().Msgf(format, v...)
		}
		return
	}
	l.logger.Debug().Msgf(format, v...)
}

// Fatal logs a fatal level message and exits
func (l *ReZero) Fatal(msg string) {
	if l == nil || l.logger == nil {
		if Log != nil {
			Log.Fatal().Msg(msg)
		} else {
			os.Exit(1)
		}
		return
	}
	l.logger.Fatal().Msg(msg)
}

// Fatalf logs a fatal level message with formatting and exits
func (l *ReZero) Fatalf(format string, v ...interface{}) {
	if l == nil || l.logger == nil {
		if Log != nil {
			Log.Fatal().Msgf(format, v...)
		} else {
			os.Exit(1)
		}
		return
	}
	l.logger.Fatal().Msgf(format, v...)
}

// Println provides compatibility with log.Println
func (l *ReZero) Println(v ...interface{}) {
	if l == nil || l.logger == nil {
		if Log != nil {
			Log.Info().Msgf("%v", v...)
		}
		return
	}
	l.logger.Info().Msgf("%v", v...)
}
