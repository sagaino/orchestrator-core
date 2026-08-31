package controller

import (
	"base-be-golang/internal/core/domain"
	authUsecase "base-be-golang/internal/core/usecase/auth"
	"base-be-golang/pkg/localerror"
	"base-be-golang/shared/api"
	"base-be-golang/shared/base"
	"base-be-golang/shared/payload"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// ProtectedRouter wraps an api.Router to apply JWT authentication middleware to its routes.
type ProtectedRouter struct {
	router       api.Router
	tokenService domain.TokenService
	sessionCache base.Cache
	middleware   gin.HandlerFunc
}

// NewProtectedRouter creates a new ProtectedRouter wrapping an api.Router with JWT middleware.
func NewProtectedRouter(router api.Router, tokenService domain.TokenService, sessionCache ...base.Cache) *ProtectedRouter {
	var cache base.Cache
	if len(sessionCache) > 0 {
		cache = sessionCache[0]
	}
	return &ProtectedRouter{
		router:       router,
		tokenService: tokenService,
		sessionCache: cache,
		middleware:   NewJWTAuthMiddleware(tokenService, cache),
	}
}

// NewProtectedRouterWithMiddleware creates a new ProtectedRouter with a custom middleware handler.
func NewProtectedRouterWithMiddleware(router api.Router, mw gin.HandlerFunc) *ProtectedRouter {
	return &ProtectedRouter{
		router:     router,
		middleware: mw,
	}
}

// Route implements the api.Router interface with JWT authentication middleware applied.
func (p *ProtectedRouter) Route(handler *gin.RouterGroup) {
	if p.router == nil {
		return
	}
	if p.middleware != nil {
		group := handler.Group("")
		group.Use(p.middleware)
		p.router.Route(group)
		return
	}
	p.router.Route(handler)
}

// ProtectRoute wraps an api.Router with JWT protection.
func ProtectRoute(router api.Router, tokenService domain.TokenService, sessionCache ...base.Cache) api.Router {
	return NewProtectedRouter(router, tokenService, sessionCache...)
}

// NewTokenServiceFromPort constructs a domain.TokenService using configuration from base.Port.
func NewTokenServiceFromPort(port base.Port) domain.TokenService {
	secret := "change-this-jwt-secret"
	expiredMinutes := 60
	if port.Env != nil {
		if s := port.Env.Get("SECRET"); s != "" {
			secret = s
		}
		if m := port.Env.GetInt("EXPIRED_TOKEN_JWT_MINUTES", 0); m > 0 {
			expiredMinutes = m
		} else if h := port.Env.GetInt("EXPIRED_TOKEN_JWT", 0); h > 0 {
			expiredMinutes = h * 60
		}
	}
	return domain.NewJWTTokenService(secret, expiredMinutes)
}

// NewJWTAuthMiddleware returns a gin.HandlerFunc that validates Bearer JWT tokens and optional Redis session existence.
// It returns HTTP 401 Unauthorized formatted using shared/payload.ErrorResponse and pkg/localerror
// when a token is missing or invalid, or when the Redis session has expired/is invalid.
func NewJWTAuthMiddleware(tokenService domain.TokenService, sessionCache ...base.Cache) gin.HandlerFunc {
	var cache base.Cache
	if len(sessionCache) > 0 {
		cache = sessionCache[0]
	}

	return func(c *gin.Context) {
		authHeader := c.GetHeader("Authorization")
		if authHeader == "" {
			err := localerror.AccessControlError{Msg: "Authorization header is required"}
			c.JSON(http.StatusUnauthorized, payload.ErrorResponse{
				Code:    http.StatusUnauthorized,
				Message: err.Error(),
			})
			c.Abort()
			return
		}

		parts := strings.SplitN(authHeader, " ", 2)
		if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || strings.TrimSpace(parts[1]) == "" {
			err := localerror.AccessControlError{Msg: "Invalid authorization header format"}
			c.JSON(http.StatusUnauthorized, payload.ErrorResponse{
				Code:    http.StatusUnauthorized,
				Message: err.Error(),
			})
			c.Abort()
			return
		}

		tokenString := strings.TrimSpace(parts[1])

		if tokenService == nil {
			err := localerror.InternalError{Msg: "Token service is not configured"}
			c.JSON(http.StatusInternalServerError, payload.ErrorResponse{
				Code:    http.StatusInternalServerError,
				Message: err.Error(),
			})
			c.Abort()
			return
		}

		claims, err := tokenService.ValidateToken(c.Request.Context(), tokenString)
		if err != nil || claims == nil {
			err := localerror.AccessControlError{Msg: "Invalid or expired token"}
			c.JSON(http.StatusUnauthorized, payload.ErrorResponse{
				Code:    http.StatusUnauthorized,
				Message: err.Error(),
			})
			c.Abort()
			return
		}

		if cache != nil {
			sessionKey := "session:user:" + claims.UserID
			sessionData, err := cache.Get(c.Request.Context(), sessionKey)
			if err != nil || strings.TrimSpace(sessionData) == "" {
				err := localerror.AccessControlError{Msg: "Session expired or invalid"}
				c.JSON(http.StatusUnauthorized, payload.ErrorResponse{
					Code:    http.StatusUnauthorized,
					Message: err.Error(),
				})
				c.Abort()
				return
			}

			var user authUsecase.UserSessionSnapshot
			if err := json.Unmarshal([]byte(sessionData), &user); err == nil {
				c.Set("currentUser", user)
			} else {
				var userMap map[string]interface{}
				if err := json.Unmarshal([]byte(sessionData), &userMap); err == nil {
					c.Set("currentUser", userMap)
				} else {
					c.Set("currentUser", sessionData)
				}
			}
		}

		c.Set("userId", claims.UserID)
		c.Set("user_id", claims.UserID)
		c.Set("email", claims.Email)
		c.Set("roleName", claims.RoleName)
		c.Set("claims", claims)
		c.Set("user", claims.Email)

		c.Next()
	}
}
