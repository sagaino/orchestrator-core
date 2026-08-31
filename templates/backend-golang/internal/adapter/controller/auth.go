package controller

import (
	"base-be-golang/internal/core/domain"
	authUsecase "base-be-golang/internal/core/usecase/auth"
	"base-be-golang/pkg/localerror"
	"base-be-golang/shared/base"
	"base-be-golang/shared/payload"
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

type AuthController struct {
	base.BaseController
	port         base.Port
	usecase      authUsecase.Usecase
	tokenService domain.TokenService
}

func NewAuthController(dbConn *gorm.DB, port base.Port, ctrl base.BaseController) *AuthController {
	repo := domain.NewUserRepository(dbConn)
	hasher := domain.NewBcryptPasswordHasher()
	secret := "change-this-jwt-secret"
	expiredMinutes := 3
	if port.Env != nil {
		if s := port.Env.Get("SECRET"); s != "" {
			secret = s
		}
		if m := port.Env.GetInt("EXPIRED_TOKEN_JWT_MINUTES", 0); m > 0 {
			expiredMinutes = m
		} else if m := port.Env.GetInt("EXPIRED_TOKEN_JWT", 3); m > 0 {
			expiredMinutes = m
		}
	}
	tokenService := domain.NewJWTTokenService(secret, expiredMinutes)
	uc := authUsecase.NewUsecase(repo, hasher, tokenService, port.Cache)
	return &AuthController{
		BaseController: ctrl,
		port:           port,
		usecase:        uc,
		tokenService:   tokenService,
	}
}

func NewAuthControllerWithUsecase(port base.Port, ctrl base.BaseController, uc authUsecase.Usecase, tokenService ...domain.TokenService) *AuthController {
	var ts domain.TokenService
	if len(tokenService) > 0 {
		ts = tokenService[0]
	}
	return &AuthController{
		BaseController: ctrl,
		port:           port,
		usecase:        uc,
		tokenService:   ts,
	}
}

func (ctrl *AuthController) AuthMiddleware() gin.HandlerFunc {
	ts := ctrl.tokenService
	if ts == nil {
		ts = NewTokenServiceFromPort(ctrl.port)
	}
	return NewJWTAuthMiddleware(ts, ctrl.port.Cache)
}

func (ctrl *AuthController) Register(c *gin.Context) {
	var req authUsecase.RegisterRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, payload.DefaultErrorInvalidDataWithMessage(err.Error()))
		return
	}

	res, err := ctrl.usecase.Register(c.Request.Context(), req)
	if err != nil {
		if localerror.IsInvalidData(err) {
			c.JSON(http.StatusBadRequest, payload.DefaultErrorInvalidDataWithMessage(err.Error()))
			return
		}
		c.JSON(http.StatusInternalServerError, payload.ErrorResponse{
			Code:    http.StatusInternalServerError,
			Message: err.Error(),
		})
		return
	}

	c.JSON(http.StatusCreated, payload.NewSuccessResponse(res, "User registered successfully"))
}

func (ctrl *AuthController) Login(c *gin.Context) {
	var req authUsecase.LoginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, payload.DefaultErrorInvalidDataWithMessage(err.Error()))
		return
	}

	res, err := ctrl.usecase.Login(c.Request.Context(), req)
	if err != nil {
		if localerror.IsInvalidData(err) {
			c.JSON(http.StatusBadRequest, payload.DefaultErrorInvalidDataWithMessage(err.Error()))
			return
		}
		c.JSON(http.StatusInternalServerError, payload.ErrorResponse{
			Code:    http.StatusInternalServerError,
			Message: err.Error(),
		})
		return
	}

	c.JSON(http.StatusOK, payload.NewSuccessResponse(res, "Login successful"))
}

func (ctrl *AuthController) RefreshToken(c *gin.Context) {
	var req authUsecase.RefreshTokenRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, payload.DefaultErrorInvalidDataWithMessage(err.Error()))
		return
	}

	if refreshUc, ok := ctrl.usecase.(interface {
		RefreshToken(ctx context.Context, req authUsecase.RefreshTokenRequest) (*authUsecase.RefreshTokenResponse, error)
	}); ok {
		res, err := refreshUc.RefreshToken(c.Request.Context(), req)
		if err != nil {
			var accessControlErr localerror.AccessControlError
			if errors.As(err, &accessControlErr) {
				c.JSON(http.StatusUnauthorized, payload.ErrorResponse{
					Code:    http.StatusUnauthorized,
					Message: err.Error(),
				})
				return
			}
			if localerror.IsInvalidData(err) {
				c.JSON(http.StatusBadRequest, payload.DefaultErrorInvalidDataWithMessage(err.Error()))
				return
			}
			c.JSON(http.StatusInternalServerError, payload.ErrorResponse{
				Code:    http.StatusInternalServerError,
				Message: err.Error(),
			})
			return
		}

		c.JSON(http.StatusOK, payload.NewSuccessResponse(res, "Token refreshed successfully"))
		return
	}

	c.JSON(http.StatusInternalServerError, payload.ErrorResponse{
		Code:    http.StatusInternalServerError,
		Message: "Refresh token service not available",
	})
}

func (ctrl *AuthController) Logout(c *gin.Context) {
	var userID string
	if val, exists := c.Get("userId"); exists {
		if s, ok := val.(string); ok {
			userID = s
		}
	}
	if userID == "" {
		if val, exists := c.Get("user_id"); exists {
			if s, ok := val.(string); ok {
				userID = s
			}
		}
	}

	if userID == "" {
		c.JSON(http.StatusUnauthorized, payload.ErrorResponse{
			Code:    http.StatusUnauthorized,
			Message: "Unauthorized",
		})
		return
	}

	var req authUsecase.LogoutRequest
	if c.Request.Body != nil {
		_ = c.ShouldBindJSON(&req)
	}
	refreshToken := strings.TrimSpace(req.RefreshToken)
	if refreshToken == "" {
		if rt := c.Query("refreshToken"); rt != "" {
			refreshToken = strings.TrimSpace(rt)
		} else if rt := c.Query("refresh_token"); rt != "" {
			refreshToken = strings.TrimSpace(rt)
		} else if rt := c.GetHeader("X-Refresh-Token"); rt != "" {
			refreshToken = strings.TrimSpace(rt)
		}
	}

	if logoutUc, ok := ctrl.usecase.(interface {
		Logout(ctx context.Context, userID string) error
	}); ok {
		if err := logoutUc.Logout(c.Request.Context(), userID); err != nil {
			if localerror.IsInvalidData(err) {
				c.JSON(http.StatusBadRequest, payload.DefaultErrorInvalidDataWithMessage(err.Error()))
				return
			}
			c.JSON(http.StatusInternalServerError, payload.ErrorResponse{
				Code:    http.StatusInternalServerError,
				Message: err.Error(),
			})
			return
		}
	} else if ctrl.port.Cache != nil {
		keysToDelete := []string{"session:user:" + userID}
		if refreshToken != "" {
			keysToDelete = append(keysToDelete, "refresh:token:"+refreshToken)
		}
		if err := ctrl.port.Cache.Delete(c.Request.Context(), keysToDelete...); err != nil {
			c.JSON(http.StatusInternalServerError, payload.ErrorResponse{
				Code:    http.StatusInternalServerError,
				Message: err.Error(),
			})
			return
		}
	}

	if refreshToken != "" && ctrl.port.Cache != nil {
		_ = ctrl.port.Cache.Delete(c.Request.Context(), "refresh:token:"+refreshToken)
	}

	c.JSON(http.StatusOK, payload.NewSuccessResponse(nil, "Logout successful"))
}

func (ctrl *AuthController) Route(router *gin.RouterGroup) {
	group := router.Group("/auth")
	{
		group.POST("/register", ctrl.Register)
		group.POST("/login", ctrl.Login)
		group.POST("/refresh", ctrl.RefreshToken)
		group.POST("/logout", ctrl.AuthMiddleware(), ctrl.Logout)
	}
}

func RegisterAuthRoutes(router gin.IRoutes, uc authUsecase.Usecase, tokenService ...domain.TokenService) {
	var ts domain.TokenService
	if len(tokenService) > 0 {
		ts = tokenService[0]
	}
	ctrl := NewAuthControllerWithUsecase(base.Port{}, base.BaseController{}, uc, ts)
	router.POST("/auth/register", ctrl.Register)
	router.POST("/auth/login", ctrl.Login)
	router.POST("/auth/refresh", ctrl.RefreshToken)
	router.POST("/auth/logout", ctrl.AuthMiddleware(), ctrl.Logout)
}
