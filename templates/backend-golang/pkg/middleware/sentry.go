package middleware

import (
	"base-be-golang/shared/payload"
	"bytes"
	"context"
	"io"
	"net/http"

	"github.com/getsentry/sentry-go"
	"github.com/gin-gonic/gin"
)

// SentryMiddleware enriches Sentry events with request details and user context
func SentryMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		// Create a new Sentry hub for this request
		hub := sentry.GetHubFromContext(c.Request.Context())
		if hub == nil {
			hub = sentry.CurrentHub().Clone()
		}

		// Set up request context
		ctx := sentry.SetHubOnContext(c.Request.Context(), hub)
		c.Request = c.Request.WithContext(ctx)

		// Capture request body
		var requestBody []byte
		if c.Request.Body != nil {
			requestBody, _ = io.ReadAll(c.Request.Body)
			c.Request.Body = io.NopCloser(bytes.NewBuffer(requestBody))
		}

		// Configure Sentry scope with request details
		hub.ConfigureScope(func(scope *sentry.Scope) {
			// Set request information
			scope.SetRequest(c.Request)

			// Set additional tags
			scope.SetTag("request.path", c.Request.URL.Path)
			scope.SetTag("request.method", c.Request.Method)
			scope.SetTag("request.user_agent", c.Request.UserAgent())
			scope.SetTag("request.remote_addr", c.ClientIP())

			// Set extra context with request details
			scope.SetExtra("request.url", c.Request.URL.String())
			scope.SetExtra("request.headers", convertHeaders(c.Request.Header))
			scope.SetExtra("request.body", string(requestBody))
			scope.SetExtra("request.query_params", c.Request.URL.Query())
			scope.SetExtra("request.content_length", c.Request.ContentLength)
		})

		// Process the request
		c.Next()

		// After request processing, check for user data in context
		enrichSentryWithUserData(hub, c)
	}
}

// enrichSentryWithUserData adds user authentication data to Sentry scope
func enrichSentryWithUserData(hub *sentry.Hub, c *gin.Context) {
	// Try to get user data from Gin context first
	if authData, exists := c.Get("authData"); exists {
		if userData, ok := authData.(UserData); ok {
			hub.ConfigureScope(func(scope *sentry.Scope) {
				// Set user information
				scope.SetUser(sentry.User{
					ID:       userData.UserId,
					Email:    userData.Email,
					Username: userData.Email,
				})

				// Set additional user context
				scope.SetTag("user.role", userData.RoleName)
				scope.SetTag("user.language", userData.Lang)

				// Set user data as extra context
				scope.SetExtra("user_data", map[string]interface{}{
					"userId":   userData.UserId,
					"email":    userData.Email,
					"roleName": userData.RoleName,
					"lang":     userData.Lang,
				})
			})
		}
	}

	getUserFromContext(hub, c.Request.Context())
}

func getUserFromContext(hub *sentry.Hub, c context.Context) {
	// Also try to get user data from request context (authCodeContext)
	if authData := c.Value(payload.AuthCodeContext); authData != nil {
		if userData, ok := authData.(UserData); ok {
			hub.ConfigureScope(func(scope *sentry.Scope) {
				// Set user information
				scope.SetUser(sentry.User{
					ID:       userData.UserId,
					Email:    userData.Email,
					Username: userData.Email,
				})

				// Set additional user context
				scope.SetTag("user.role", userData.RoleName)
				scope.SetTag("user.language", userData.Lang)

				// Set user data as extra context
				scope.SetExtra("user_data", map[string]interface{}{
					"userId":   userData.UserId,
					"email":    userData.Email,
					"roleName": userData.RoleName,
					"lang":     userData.Lang,
				})
			})
		}
	}
}

// convertHeaders converts http.Header to map[string]string for Sentry
func convertHeaders(headers http.Header) map[string]string {
	result := make(map[string]string)
	for key, values := range headers {
		if len(values) > 0 {
			// Skip sensitive headers
			if key == "Authorization" || key == "Cookie" || key == "X-Api-Key" {
				result[key] = "[Filtered]"
			} else {
				result[key] = values[0]
			}
		}
	}
	return result
}

// CaptureError captures an error with enriched context
func CaptureError(c *gin.Context, err error) {
	hub := sentry.GetHubFromContext(c.Request.Context())
	if hub == nil {
		hub = sentry.CurrentHub()
	}

	// Enrich with current user data if available
	enrichSentryWithUserData(hub, c)

	// Capture the error
	hub.CaptureException(err)
}

func CaptureErrorUsecase(ctx context.Context, err error) {
	hub := sentry.GetHubFromContext(ctx)
	if hub == nil {
		hub = sentry.CurrentHub()
	}

	// Enrich with current user data if available
	getUserFromContext(hub, ctx)

	// Capture the error
	hub.CaptureException(err)
}

// CaptureMessage captures a message with enriched context
func CaptureMessage(c *gin.Context, message string, level sentry.Level) {
	hub := sentry.GetHubFromContext(c.Request.Context())
	if hub == nil {
		hub = sentry.CurrentHub()
	}

	// Enrich with current user data if available
	enrichSentryWithUserData(hub, c)

	// Capture the message
	hub.CaptureMessage(message)
}
