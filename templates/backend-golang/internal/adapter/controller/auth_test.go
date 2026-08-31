package controller

import (
	"base-be-golang/internal/core/domain"
	authUsecase "base-be-golang/internal/core/usecase/auth"
	"base-be-golang/pkg/localerror"
	"base-be-golang/shared/base"
	"base-be-golang/shared/payload"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

type mockAuthUsecase struct {
	registerFn     func(ctx context.Context, req authUsecase.RegisterRequest) (*authUsecase.RegisterResponse, error)
	loginFn        func(ctx context.Context, req authUsecase.LoginRequest) (*authUsecase.LoginResponse, error)
	logoutFn       func(ctx context.Context, userID string) error
	refreshTokenFn func(ctx context.Context, req authUsecase.RefreshTokenRequest) (*authUsecase.RefreshTokenResponse, error)
}

func (m *mockAuthUsecase) Register(ctx context.Context, req authUsecase.RegisterRequest) (*authUsecase.RegisterResponse, error) {
	if m.registerFn != nil {
		return m.registerFn(ctx, req)
	}
	return nil, nil
}

func (m *mockAuthUsecase) Login(ctx context.Context, req authUsecase.LoginRequest) (*authUsecase.LoginResponse, error) {
	if m.loginFn != nil {
		return m.loginFn(ctx, req)
	}
	return nil, nil
}

func (m *mockAuthUsecase) Logout(ctx context.Context, userID string) error {
	if m.logoutFn != nil {
		return m.logoutFn(ctx, userID)
	}
	return nil
}

func (m *mockAuthUsecase) RefreshToken(ctx context.Context, req authUsecase.RefreshTokenRequest) (*authUsecase.RefreshTokenResponse, error) {
	if m.refreshTokenFn != nil {
		return m.refreshTokenFn(ctx, req)
	}
	return nil, nil
}

type mockAuthUsecaseWithoutLogout struct {
	registerFn func(ctx context.Context, req authUsecase.RegisterRequest) (*authUsecase.RegisterResponse, error)
	loginFn    func(ctx context.Context, req authUsecase.LoginRequest) (*authUsecase.LoginResponse, error)
}

func (m *mockAuthUsecaseWithoutLogout) Register(ctx context.Context, req authUsecase.RegisterRequest) (*authUsecase.RegisterResponse, error) {
	if m.registerFn != nil {
		return m.registerFn(ctx, req)
	}
	return nil, nil
}

func (m *mockAuthUsecaseWithoutLogout) Login(ctx context.Context, req authUsecase.LoginRequest) (*authUsecase.LoginResponse, error) {
	if m.loginFn != nil {
		return m.loginFn(ctx, req)
	}
	return nil, nil
}

type mockControllerCache struct {
	getFn    func(ctx context.Context, key string) (string, error)
	setFn    func(ctx context.Context, key string, value interface{}, exp time.Duration) error
	deleteFn func(ctx context.Context, keys ...string) error

	store        map[string]interface{}
	ttls         map[string]time.Duration
	deletedKeys  []string
	accessedKeys []string
}

func newMockControllerCache() *mockControllerCache {
	return &mockControllerCache{
		store:        make(map[string]interface{}),
		ttls:         make(map[string]time.Duration),
		deletedKeys:  make([]string, 0),
		accessedKeys: make([]string, 0),
	}
}

func (m *mockControllerCache) Get(ctx context.Context, key string) (string, error) {
	m.accessedKeys = append(m.accessedKeys, key)
	if m.getFn != nil {
		return m.getFn(ctx, key)
	}
	if m.store != nil {
		if val, ok := m.store[key]; ok {
			if strVal, ok := val.(string); ok {
				return strVal, nil
			}
		}
	}
	return "", errors.New("key not found")
}

func (m *mockControllerCache) Set(ctx context.Context, key string, value interface{}, exp time.Duration) error {
	if m.setFn != nil {
		return m.setFn(ctx, key, value, exp)
	}
	if m.store != nil {
		m.store[key] = value
		m.ttls[key] = exp
	}
	return nil
}

func (m *mockControllerCache) Delete(ctx context.Context, keys ...string) error {
	m.deletedKeys = append(m.deletedKeys, keys...)
	if m.deleteFn != nil {
		return m.deleteFn(ctx, keys...)
	}
	if m.store != nil {
		for _, k := range keys {
			delete(m.store, k)
			delete(m.ttls, k)
		}
	}
	return nil
}

type mockTokenService struct {
	generateTokenFn func(ctx context.Context, user *domain.User) (string, error)
	validateTokenFn func(ctx context.Context, tokenString string) (*domain.JWTClaims, error)
}

func (m *mockTokenService) GenerateToken(ctx context.Context, user *domain.User) (string, error) {
	if m.generateTokenFn != nil {
		return m.generateTokenFn(ctx, user)
	}
	return "mock-token-" + user.ID, nil
}

func (m *mockTokenService) ValidateToken(ctx context.Context, tokenString string) (*domain.JWTClaims, error) {
	if m.validateTokenFn != nil {
		return m.validateTokenFn(ctx, tokenString)
	}
	if tokenString == "valid-token-123" {
		return &domain.JWTClaims{
			UserID:   "user-123",
			Email:    "user@example.com",
			RoleName: "admin",
		}, nil
	}
	return nil, errors.New("invalid token")
}

func TestAuthController_Register_Success(t *testing.T) {
	now := time.Now().UTC()
	mockUc := &mockAuthUsecase{
		registerFn: func(ctx context.Context, req authUsecase.RegisterRequest) (*authUsecase.RegisterResponse, error) {
			return &authUsecase.RegisterResponse{
				ID:        "usr-100",
				Name:      req.Name,
				Email:     req.Email,
				CreatedAt: now,
				UpdatedAt: now,
			}, nil
		},
	}

	router := gin.New()
	group := router.Group("/api/v1")
	ctrl := NewAuthControllerWithUsecase(base.Port{}, base.BaseController{}, mockUc)
	ctrl.Route(group)

	body, _ := json.Marshal(authUsecase.RegisterRequest{
		Name:     "John Doe",
		Email:    "john@example.com",
		Password: "password123",
	})
	req, err := http.NewRequest(http.MethodPost, "/api/v1/auth/register", bytes.NewBuffer(body))
	if err != nil {
		t.Fatalf("failed to create request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("expected status %d, got %d (body: %s)", http.StatusCreated, w.Code, w.Body.String())
	}

	var resp payload.Response
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	if resp.Code != http.StatusOK {
		t.Errorf("expected code %d, got %d", http.StatusOK, resp.Code)
	}

	resultMap, ok := resp.Result.(map[string]interface{})
	if !ok {
		t.Fatalf("expected result to be map, got %T", resp.Result)
	}
	if resultMap["id"] != "usr-100" {
		t.Errorf("expected id 'usr-100', got %v", resultMap["id"])
	}
	if resultMap["name"] != "John Doe" {
		t.Errorf("expected name 'John Doe', got %v", resultMap["name"])
	}
	if resultMap["email"] != "john@example.com" {
		t.Errorf("expected email 'john@example.com', got %v", resultMap["email"])
	}
}

func TestAuthController_Register_ValidationError(t *testing.T) {
	mockUc := &mockAuthUsecase{}
	router := gin.New()
	group := router.Group("/api/v1")
	ctrl := NewAuthControllerWithUsecase(base.Port{}, base.BaseController{}, mockUc)
	ctrl.Route(group)

	// Missing password
	body := []byte(`{"name":"John","email":"john@example.com"}`)
	req, _ := http.NewRequest(http.MethodPost, "/api/v1/auth/register", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d", http.StatusBadRequest, w.Code)
	}
}

func TestAuthController_Register_InvalidJSON(t *testing.T) {
	mockUc := &mockAuthUsecase{}
	router := gin.New()
	group := router.Group("/api/v1")
	ctrl := NewAuthControllerWithUsecase(base.Port{}, base.BaseController{}, mockUc)
	ctrl.Route(group)

	body := []byte(`{invalid-json}`)
	req, _ := http.NewRequest(http.MethodPost, "/api/v1/auth/register", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d", http.StatusBadRequest, w.Code)
	}
}

func TestAuthController_Register_UsecaseInvalidData(t *testing.T) {
	mockUc := &mockAuthUsecase{
		registerFn: func(ctx context.Context, req authUsecase.RegisterRequest) (*authUsecase.RegisterResponse, error) {
			return nil, localerror.InvalidData("Email is already registered")
		},
	}
	router := gin.New()
	group := router.Group("/api/v1")
	ctrl := NewAuthControllerWithUsecase(base.Port{}, base.BaseController{}, mockUc)
	ctrl.Route(group)

	body, _ := json.Marshal(authUsecase.RegisterRequest{
		Name:     "John Doe",
		Email:    "john@example.com",
		Password: "password123",
	})
	req, _ := http.NewRequest(http.MethodPost, "/api/v1/auth/register", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d", http.StatusBadRequest, w.Code)
	}
}

func TestAuthController_Register_UsecaseInternalError(t *testing.T) {
	mockUc := &mockAuthUsecase{
		registerFn: func(ctx context.Context, req authUsecase.RegisterRequest) (*authUsecase.RegisterResponse, error) {
			return nil, errors.New("database connection failed")
		},
	}
	router := gin.New()
	group := router.Group("/api/v1")
	ctrl := NewAuthControllerWithUsecase(base.Port{}, base.BaseController{}, mockUc)
	ctrl.Route(group)

	body, _ := json.Marshal(authUsecase.RegisterRequest{
		Name:     "John Doe",
		Email:    "john@example.com",
		Password: "password123",
	})
	req, _ := http.NewRequest(http.MethodPost, "/api/v1/auth/register", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("expected status %d, got %d", http.StatusInternalServerError, w.Code)
	}
}

func TestAuthController_Login_Success(t *testing.T) {
	now := time.Now().UTC()
	mockUc := &mockAuthUsecase{
		loginFn: func(ctx context.Context, req authUsecase.LoginRequest) (*authUsecase.LoginResponse, error) {
			return &authUsecase.LoginResponse{
				AccessToken: "mock-access-token-xyz",
				TokenType:   "Bearer",
				User: &authUsecase.RegisterResponse{
					ID:        "usr-100",
					Name:      "John Doe",
					Email:     req.Email,
					CreatedAt: now,
					UpdatedAt: now,
				},
			}, nil
		},
	}

	router := gin.New()
	group := router.Group("/api/v1")
	ctrl := NewAuthControllerWithUsecase(base.Port{}, base.BaseController{}, mockUc)
	ctrl.Route(group)

	body, _ := json.Marshal(authUsecase.LoginRequest{
		Email:    "john@example.com",
		Password: "password123",
	})
	req, err := http.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewBuffer(body))
	if err != nil {
		t.Fatalf("failed to create request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d (body: %s)", http.StatusOK, w.Code, w.Body.String())
	}

	var resp payload.Response
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	if resp.Code != http.StatusOK {
		t.Errorf("expected code %d, got %d", http.StatusOK, resp.Code)
	}

	resultMap, ok := resp.Result.(map[string]interface{})
	if !ok {
		t.Fatalf("expected result to be map, got %T", resp.Result)
	}
	if resultMap["accessToken"] != "mock-access-token-xyz" {
		t.Errorf("expected accessToken 'mock-access-token-xyz', got %v", resultMap["accessToken"])
	}
	if resultMap["tokenType"] != "Bearer" {
		t.Errorf("expected tokenType 'Bearer', got %v", resultMap["tokenType"])
	}
}

func TestAuthController_Login_ValidationError(t *testing.T) {
	mockUc := &mockAuthUsecase{}
	router := gin.New()
	group := router.Group("/api/v1")
	ctrl := NewAuthControllerWithUsecase(base.Port{}, base.BaseController{}, mockUc)
	ctrl.Route(group)

	// Missing password
	body := []byte(`{"email":"john@example.com"}`)
	req, _ := http.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d", http.StatusBadRequest, w.Code)
	}
}

func TestAuthController_Login_InvalidJSON(t *testing.T) {
	mockUc := &mockAuthUsecase{}
	router := gin.New()
	group := router.Group("/api/v1")
	ctrl := NewAuthControllerWithUsecase(base.Port{}, base.BaseController{}, mockUc)
	ctrl.Route(group)

	body := []byte(`{invalid-json}`)
	req, _ := http.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d", http.StatusBadRequest, w.Code)
	}
}

func TestAuthController_Login_UsecaseInvalidData(t *testing.T) {
	mockUc := &mockAuthUsecase{
		loginFn: func(ctx context.Context, req authUsecase.LoginRequest) (*authUsecase.LoginResponse, error) {
			return nil, localerror.InvalidData("Invalid email or password")
		},
	}
	router := gin.New()
	group := router.Group("/api/v1")
	ctrl := NewAuthControllerWithUsecase(base.Port{}, base.BaseController{}, mockUc)
	ctrl.Route(group)

	body, _ := json.Marshal(authUsecase.LoginRequest{
		Email:    "john@example.com",
		Password: "wrongpassword",
	})
	req, _ := http.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d", http.StatusBadRequest, w.Code)
	}
}

func TestAuthController_Login_UsecaseInternalError(t *testing.T) {
	mockUc := &mockAuthUsecase{
		loginFn: func(ctx context.Context, req authUsecase.LoginRequest) (*authUsecase.LoginResponse, error) {
			return nil, errors.New("unexpected auth failure")
		},
	}
	router := gin.New()
	group := router.Group("/api/v1")
	ctrl := NewAuthControllerWithUsecase(base.Port{}, base.BaseController{}, mockUc)
	ctrl.Route(group)

	body, _ := json.Marshal(authUsecase.LoginRequest{
		Email:    "john@example.com",
		Password: "password123",
	})
	req, _ := http.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("expected status %d, got %d", http.StatusInternalServerError, w.Code)
	}
}

func TestAuthController_RegisterAuthRoutes(t *testing.T) {
	mockUc := &mockAuthUsecase{
		loginFn: func(ctx context.Context, req authUsecase.LoginRequest) (*authUsecase.LoginResponse, error) {
			return &authUsecase.LoginResponse{AccessToken: "token-abc"}, nil
		},
	}

	router := gin.New()
	RegisterAuthRoutes(router, mockUc)

	body, _ := json.Marshal(authUsecase.LoginRequest{
		Email:    "test@example.com",
		Password: "password123",
	})
	req, _ := http.NewRequest(http.MethodPost, "/auth/login", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, w.Code)
	}
}

func TestAuthController_Logout_Success_WithUsecase(t *testing.T) {
	var loggedOutUser string
	mockUc := &mockAuthUsecase{
		logoutFn: func(ctx context.Context, userID string) error {
			loggedOutUser = userID
			return nil
		},
	}

	router := gin.New()
	ctrl := NewAuthControllerWithUsecase(base.Port{}, base.BaseController{}, mockUc)
	router.POST("/logout", func(c *gin.Context) {
		c.Set("userId", "user-123")
		ctrl.Logout(c)
	})

	req, _ := http.NewRequest(http.MethodPost, "/logout", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d (body: %s)", http.StatusOK, w.Code, w.Body.String())
	}

	var resp payload.Response
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	if resp.Code != http.StatusOK {
		t.Errorf("expected code %d, got %d", http.StatusOK, resp.Code)
	}
	if resp.Message != "Logout successful" {
		t.Errorf("expected message 'Logout successful', got '%s'", resp.Message)
	}
	if loggedOutUser != "user-123" {
		t.Errorf("expected loggedOutUser 'user-123', got '%s'", loggedOutUser)
	}
}

func TestAuthController_Logout_Success_WithUser_Id(t *testing.T) {
	var loggedOutUser string
	mockUc := &mockAuthUsecase{
		logoutFn: func(ctx context.Context, userID string) error {
			loggedOutUser = userID
			return nil
		},
	}

	router := gin.New()
	ctrl := NewAuthControllerWithUsecase(base.Port{}, base.BaseController{}, mockUc)
	router.POST("/logout", func(c *gin.Context) {
		c.Set("user_id", "user-456")
		ctrl.Logout(c)
	})

	req, _ := http.NewRequest(http.MethodPost, "/logout", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, w.Code)
	}
	if loggedOutUser != "user-456" {
		t.Errorf("expected loggedOutUser 'user-456', got '%s'", loggedOutUser)
	}
}

func TestAuthController_Logout_Success_WithPortCacheFallback(t *testing.T) {
	mockCache := newMockControllerCache()
	mockCache.store["session:user:user-789"] = `{"id":"user-789"}`
	port := base.Port{Cache: mockCache}

	mockUc := &mockAuthUsecaseWithoutLogout{}
	ctrl := NewAuthControllerWithUsecase(port, base.BaseController{}, mockUc)

	router := gin.New()
	router.POST("/logout", func(c *gin.Context) {
		c.Set("userId", "user-789")
		ctrl.Logout(c)
	})

	req, _ := http.NewRequest(http.MethodPost, "/logout", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, w.Code)
	}

	if len(mockCache.deletedKeys) != 1 || mockCache.deletedKeys[0] != "session:user:user-789" {
		t.Errorf("expected deleted key 'session:user:user-789', got %v", mockCache.deletedKeys)
	}
	if _, exists := mockCache.store["session:user:user-789"]; exists {
		t.Error("expected key to be removed from cache store")
	}
}

func TestAuthController_Logout_Unauthorized_NoUserInContext(t *testing.T) {
	mockUc := &mockAuthUsecase{}
	ctrl := NewAuthControllerWithUsecase(base.Port{}, base.BaseController{}, mockUc)

	router := gin.New()
	router.POST("/logout", ctrl.Logout)

	req, _ := http.NewRequest(http.MethodPost, "/logout", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected status %d, got %d", http.StatusUnauthorized, w.Code)
	}

	var resp payload.ErrorResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal error response: %v", err)
	}
	if resp.Code != http.StatusUnauthorized {
		t.Errorf("expected error code %d, got %d", http.StatusUnauthorized, resp.Code)
	}
	if resp.Message != "Unauthorized" {
		t.Errorf("expected message 'Unauthorized', got '%s'", resp.Message)
	}
}

func TestAuthController_Logout_UsecaseInvalidData(t *testing.T) {
	mockUc := &mockAuthUsecase{
		logoutFn: func(ctx context.Context, userID string) error {
			return localerror.InvalidData("Invalid user ID")
		},
	}
	ctrl := NewAuthControllerWithUsecase(base.Port{}, base.BaseController{}, mockUc)

	router := gin.New()
	router.POST("/logout", func(c *gin.Context) {
		c.Set("userId", "user-bad")
		ctrl.Logout(c)
	})

	req, _ := http.NewRequest(http.MethodPost, "/logout", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d", http.StatusBadRequest, w.Code)
	}
}

func TestAuthController_Logout_UsecaseInternalError(t *testing.T) {
	mockUc := &mockAuthUsecase{
		logoutFn: func(ctx context.Context, userID string) error {
			return localerror.InternalError{Msg: "Failed to delete user session"}
		},
	}
	ctrl := NewAuthControllerWithUsecase(base.Port{}, base.BaseController{}, mockUc)

	router := gin.New()
	router.POST("/logout", func(c *gin.Context) {
		c.Set("userId", "user-err")
		ctrl.Logout(c)
	})

	req, _ := http.NewRequest(http.MethodPost, "/logout", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("expected status %d, got %d", http.StatusInternalServerError, w.Code)
	}
}

func TestAuthController_Logout_PortCacheError(t *testing.T) {
	mockCache := &mockControllerCache{
		deleteFn: func(ctx context.Context, keys ...string) error {
			return errors.New("redis delete error")
		},
	}
	port := base.Port{Cache: mockCache}
	mockUc := &mockAuthUsecaseWithoutLogout{}
	ctrl := NewAuthControllerWithUsecase(port, base.BaseController{}, mockUc)

	router := gin.New()
	router.POST("/logout", func(c *gin.Context) {
		c.Set("userId", "user-123")
		ctrl.Logout(c)
	})

	req, _ := http.NewRequest(http.MethodPost, "/logout", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("expected status %d, got %d", http.StatusInternalServerError, w.Code)
	}
}

func TestAuthController_Logout_FullRoute_WithMiddleware_Success(t *testing.T) {
	mockCache := newMockControllerCache()
	mockCache.store["session:user:user-123"] = `{"id":"user-123","name":"John Doe"}`
	port := base.Port{Cache: mockCache}

	mockToken := &mockTokenService{
		validateTokenFn: func(ctx context.Context, tokenString string) (*domain.JWTClaims, error) {
			if tokenString == "valid-auth-token" {
				return &domain.JWTClaims{UserID: "user-123", Email: "john@example.com"}, nil
			}
			return nil, errors.New("invalid token")
		},
	}

	var loggedOutUser string
	mockUc := &mockAuthUsecase{
		logoutFn: func(ctx context.Context, userID string) error {
			loggedOutUser = userID
			return mockCache.Delete(ctx, "session:user:"+userID)
		},
	}

	ctrl := NewAuthControllerWithUsecase(port, base.BaseController{}, mockUc, mockToken)
	router := gin.New()
	group := router.Group("/api/v1")
	ctrl.Route(group)

	req, _ := http.NewRequest(http.MethodPost, "/api/v1/auth/logout", nil)
	req.Header.Set("Authorization", "Bearer valid-auth-token")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d (body: %s)", http.StatusOK, w.Code, w.Body.String())
	}
	if loggedOutUser != "user-123" {
		t.Errorf("expected loggedOutUser 'user-123', got '%s'", loggedOutUser)
	}
	if _, exists := mockCache.store["session:user:user-123"]; exists {
		t.Error("expected session:user:user-123 to be deleted from cache")
	}
}

func TestAuthController_Logout_FullRoute_WithMiddleware_SessionMiss_401(t *testing.T) {
	mockCache := newMockControllerCache()
	port := base.Port{Cache: mockCache}

	mockToken := &mockTokenService{
		validateTokenFn: func(ctx context.Context, tokenString string) (*domain.JWTClaims, error) {
			if tokenString == "valid-auth-token" {
				return &domain.JWTClaims{UserID: "user-123", Email: "john@example.com"}, nil
			}
			return nil, errors.New("invalid token")
		},
	}

	mockUc := &mockAuthUsecase{}
	ctrl := NewAuthControllerWithUsecase(port, base.BaseController{}, mockUc, mockToken)
	router := gin.New()
	group := router.Group("/api/v1")
	ctrl.Route(group)

	req, _ := http.NewRequest(http.MethodPost, "/api/v1/auth/logout", nil)
	req.Header.Set("Authorization", "Bearer valid-auth-token")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected status %d, got %d (body: %s)", http.StatusUnauthorized, w.Code, w.Body.String())
	}

	var resp payload.ErrorResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal error response: %v", err)
	}
	if resp.Message != "Session expired or invalid" {
		t.Errorf("expected 'Session expired or invalid', got '%s'", resp.Message)
	}
}

func TestAuthController_Logout_FullRoute_WithMiddleware_InvalidToken_401(t *testing.T) {
	mockCache := newMockControllerCache()
	port := base.Port{Cache: mockCache}

	mockToken := &mockTokenService{
		validateTokenFn: func(ctx context.Context, tokenString string) (*domain.JWTClaims, error) {
			return nil, errors.New("invalid token")
		},
	}

	mockUc := &mockAuthUsecase{}
	ctrl := NewAuthControllerWithUsecase(port, base.BaseController{}, mockUc, mockToken)
	router := gin.New()
	group := router.Group("/api/v1")
	ctrl.Route(group)

	req, _ := http.NewRequest(http.MethodPost, "/api/v1/auth/logout", nil)
	req.Header.Set("Authorization", "Bearer invalid-token")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected status %d, got %d", http.StatusUnauthorized, w.Code)
	}
}

func TestAuthController_Logout_FullRoute_WithMiddleware_MissingHeader_401(t *testing.T) {
	mockUc := &mockAuthUsecase{}
	ctrl := NewAuthControllerWithUsecase(base.Port{}, base.BaseController{}, mockUc)
	router := gin.New()
	group := router.Group("/api/v1")
	ctrl.Route(group)

	req, _ := http.NewRequest(http.MethodPost, "/api/v1/auth/logout", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected status %d, got %d", http.StatusUnauthorized, w.Code)
	}
}

func TestRegisterAuthRoutes_Logout_Success(t *testing.T) {
	mockToken := &mockTokenService{
		validateTokenFn: func(ctx context.Context, tokenString string) (*domain.JWTClaims, error) {
			return &domain.JWTClaims{UserID: "user-reg-route", Email: "reg@example.com"}, nil
		},
	}

	var loggedOutUser string
	mockUc := &mockAuthUsecase{
		logoutFn: func(ctx context.Context, userID string) error {
			loggedOutUser = userID
			return nil
		},
	}

	router := gin.New()
	RegisterAuthRoutes(router, mockUc, mockToken)

	req, _ := http.NewRequest(http.MethodPost, "/auth/logout", nil)
	req.Header.Set("Authorization", "Bearer some-token")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, w.Code)
	}
	if loggedOutUser != "user-reg-route" {
		t.Errorf("expected loggedOutUser 'user-reg-route', got '%s'", loggedOutUser)
	}
}

func TestNewAuthController_Instantiation(t *testing.T) {
	ctrl := NewAuthController(nil, base.Port{}, base.BaseController{})
	if ctrl == nil {
		t.Fatal("expected non-nil AuthController")
	}
}

type mockEnvironment struct {
	getFn    func(key string) string
	getIntFn func(key string, defaultValue int) int
}

func (m *mockEnvironment) CheckFlag(flag string) bool { return false }
func (m *mockEnvironment) Get(key string) string {
	if m.getFn != nil {
		return m.getFn(key)
	}
	return ""
}
func (m *mockEnvironment) GetInt(key string, defaultValue int) int {
	if m.getIntFn != nil {
		return m.getIntFn(key, defaultValue)
	}
	return defaultValue
}
func (m *mockEnvironment) GetUint(key string, defaultValue uint) uint       { return defaultValue }
func (m *mockEnvironment) GetFloat(key string, defaultValue float64) float64 { return defaultValue }
func (m *mockEnvironment) GetBranchID() uint                                 { return 1 }

func TestNewAuthController_WithEnvironment(t *testing.T) {
	mockEnv := &mockEnvironment{
		getFn: func(key string) string {
			if key == "SECRET" {
				return "custom-jwt-secret"
			}
			return ""
		},
		getIntFn: func(key string, defaultValue int) int {
			if key == "EXPIRED_TOKEN_JWT" {
				return 3
			}
			return defaultValue
		},
	}
	port := base.Port{
		Env: mockEnv,
	}
	ctrl := NewAuthController(nil, port, base.BaseController{})
	if ctrl == nil {
		t.Fatal("expected non-nil AuthController")
	}
}

func TestNewAuthController_WithMinutesEnvironment(t *testing.T) {
	mockEnv := &mockEnvironment{
		getFn: func(key string) string {
			if key == "SECRET" {
				return "custom-jwt-secret"
			}
			return ""
		},
		getIntFn: func(key string, defaultValue int) int {
			if key == "EXPIRED_TOKEN_JWT_MINUTES" {
				return 5
			}
			return defaultValue
		},
	}
	port := base.Port{
		Env: mockEnv,
	}
	ctrl := NewAuthController(nil, port, base.BaseController{})
	if ctrl == nil {
		t.Fatal("expected non-nil AuthController")
	}
}

func TestAuthController_RefreshToken_Success(t *testing.T) {
	mockUc := &mockAuthUsecase{
		refreshTokenFn: func(ctx context.Context, req authUsecase.RefreshTokenRequest) (*authUsecase.RefreshTokenResponse, error) {
			if req.RefreshToken == "valid-refresh-token" {
				return &authUsecase.RefreshTokenResponse{
					AccessToken:  "new-access-token-123",
					RefreshToken: "new-refresh-token-456",
					TokenType:    "Bearer",
				}, nil
			}
			return nil, localerror.AccessControlError{Msg: "Invalid or expired refresh token"}
		},
	}

	router := gin.New()
	group := router.Group("/api/v1")
	ctrl := NewAuthControllerWithUsecase(base.Port{}, base.BaseController{}, mockUc)
	ctrl.Route(group)

	body, _ := json.Marshal(authUsecase.RefreshTokenRequest{
		RefreshToken: "valid-refresh-token",
	})
	req, err := http.NewRequest(http.MethodPost, "/api/v1/auth/refresh", bytes.NewBuffer(body))
	if err != nil {
		t.Fatalf("failed to create request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d (body: %s)", http.StatusOK, w.Code, w.Body.String())
	}

	var resp payload.Response
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	if resp.Code != http.StatusOK {
		t.Errorf("expected code %d, got %d", http.StatusOK, resp.Code)
	}
	if resp.Message != "Token refreshed successfully" {
		t.Errorf("expected message 'Token refreshed successfully', got '%s'", resp.Message)
	}

	resultMap, ok := resp.Result.(map[string]interface{})
	if !ok {
		t.Fatalf("expected result to be map, got %T", resp.Result)
	}
	if resultMap["accessToken"] != "new-access-token-123" {
		t.Errorf("expected accessToken 'new-access-token-123', got %v", resultMap["accessToken"])
	}
	if resultMap["refreshToken"] != "new-refresh-token-456" {
		t.Errorf("expected refreshToken 'new-refresh-token-456', got %v", resultMap["refreshToken"])
	}
	if resultMap["tokenType"] != "Bearer" {
		t.Errorf("expected tokenType 'Bearer', got %v", resultMap["tokenType"])
	}
}

func TestAuthController_RefreshToken_ValidationError_EmptyBody(t *testing.T) {
	mockUc := &mockAuthUsecase{}
	router := gin.New()
	group := router.Group("/api/v1")
	ctrl := NewAuthControllerWithUsecase(base.Port{}, base.BaseController{}, mockUc)
	ctrl.Route(group)

	body := []byte(`{}`)
	req, _ := http.NewRequest(http.MethodPost, "/api/v1/auth/refresh", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d", http.StatusBadRequest, w.Code)
	}
}

func TestAuthController_RefreshToken_InvalidJSON(t *testing.T) {
	mockUc := &mockAuthUsecase{}
	router := gin.New()
	group := router.Group("/api/v1")
	ctrl := NewAuthControllerWithUsecase(base.Port{}, base.BaseController{}, mockUc)
	ctrl.Route(group)

	body := []byte(`{invalid-json}`)
	req, _ := http.NewRequest(http.MethodPost, "/api/v1/auth/refresh", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d", http.StatusBadRequest, w.Code)
	}
}

func TestAuthController_RefreshToken_Unauthorized_AccessControlError(t *testing.T) {
	mockUc := &mockAuthUsecase{
		refreshTokenFn: func(ctx context.Context, req authUsecase.RefreshTokenRequest) (*authUsecase.RefreshTokenResponse, error) {
			return nil, localerror.AccessControlError{Msg: "Invalid or expired refresh token"}
		},
	}
	router := gin.New()
	group := router.Group("/api/v1")
	ctrl := NewAuthControllerWithUsecase(base.Port{}, base.BaseController{}, mockUc)
	ctrl.Route(group)

	body, _ := json.Marshal(authUsecase.RefreshTokenRequest{
		RefreshToken: "expired-refresh-token",
	})
	req, _ := http.NewRequest(http.MethodPost, "/api/v1/auth/refresh", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected status %d, got %d", http.StatusUnauthorized, w.Code)
	}

	var resp payload.ErrorResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal error response: %v", err)
	}
	if resp.Code != http.StatusUnauthorized {
		t.Errorf("expected error code %d, got %d", http.StatusUnauthorized, resp.Code)
	}
	if resp.Message != "Invalid or expired refresh token" {
		t.Errorf("expected message 'Invalid or expired refresh token', got '%s'", resp.Message)
	}
}

func TestAuthController_RefreshToken_InvalidData(t *testing.T) {
	mockUc := &mockAuthUsecase{
		refreshTokenFn: func(ctx context.Context, req authUsecase.RefreshTokenRequest) (*authUsecase.RefreshTokenResponse, error) {
			return nil, localerror.InvalidData("Invalid refresh token payload")
		},
	}
	router := gin.New()
	group := router.Group("/api/v1")
	ctrl := NewAuthControllerWithUsecase(base.Port{}, base.BaseController{}, mockUc)
	ctrl.Route(group)

	body, _ := json.Marshal(authUsecase.RefreshTokenRequest{
		RefreshToken: "bad-token",
	})
	req, _ := http.NewRequest(http.MethodPost, "/api/v1/auth/refresh", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d", http.StatusBadRequest, w.Code)
	}
}

func TestAuthController_RefreshToken_InternalError(t *testing.T) {
	mockUc := &mockAuthUsecase{
		refreshTokenFn: func(ctx context.Context, req authUsecase.RefreshTokenRequest) (*authUsecase.RefreshTokenResponse, error) {
			return nil, errors.New("redis connection lost")
		},
	}
	router := gin.New()
	group := router.Group("/api/v1")
	ctrl := NewAuthControllerWithUsecase(base.Port{}, base.BaseController{}, mockUc)
	ctrl.Route(group)

	body, _ := json.Marshal(authUsecase.RefreshTokenRequest{
		RefreshToken: "valid-token",
	})
	req, _ := http.NewRequest(http.MethodPost, "/api/v1/auth/refresh", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("expected status %d, got %d", http.StatusInternalServerError, w.Code)
	}
}

func TestAuthController_RefreshToken_ServiceNotAvailable(t *testing.T) {
	mockUc := &mockAuthUsecaseWithoutLogout{}
	router := gin.New()
	group := router.Group("/api/v1")
	ctrl := NewAuthControllerWithUsecase(base.Port{}, base.BaseController{}, mockUc)
	ctrl.Route(group)

	body, _ := json.Marshal(authUsecase.RefreshTokenRequest{
		RefreshToken: "valid-token",
	})
	req, _ := http.NewRequest(http.MethodPost, "/api/v1/auth/refresh", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("expected status %d, got %d", http.StatusInternalServerError, w.Code)
	}
}

func TestAuthController_RegisterAuthRoutes_RefreshToken_Success(t *testing.T) {
	mockUc := &mockAuthUsecase{
		refreshTokenFn: func(ctx context.Context, req authUsecase.RefreshTokenRequest) (*authUsecase.RefreshTokenResponse, error) {
			return &authUsecase.RefreshTokenResponse{
				AccessToken:  "new-access-token-reg",
				RefreshToken: "new-refresh-token-reg",
				TokenType:    "Bearer",
			}, nil
		},
	}

	router := gin.New()
	RegisterAuthRoutes(router, mockUc)

	body, _ := json.Marshal(authUsecase.RefreshTokenRequest{
		RefreshToken: "my-refresh-token",
	})
	req, _ := http.NewRequest(http.MethodPost, "/auth/refresh", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d (body: %s)", http.StatusOK, w.Code, w.Body.String())
	}
}

func TestAuthController_Logout_WithRefreshToken_InBody(t *testing.T) {
	mockCache := newMockControllerCache()
	mockCache.store["session:user:user-rt-1"] = `{"id":"user-rt-1"}`
	mockCache.store["refresh:token:rt-body-123"] = `{"id":"user-rt-1"}`
	port := base.Port{Cache: mockCache}

	var loggedOutUser string
	mockUc := &mockAuthUsecase{
		logoutFn: func(ctx context.Context, userID string) error {
			loggedOutUser = userID
			return nil
		},
	}

	ctrl := NewAuthControllerWithUsecase(port, base.BaseController{}, mockUc)
	router := gin.New()
	router.POST("/logout", func(c *gin.Context) {
		c.Set("userId", "user-rt-1")
		ctrl.Logout(c)
	})

	body, _ := json.Marshal(authUsecase.LogoutRequest{
		RefreshToken: "rt-body-123",
	})
	req, _ := http.NewRequest(http.MethodPost, "/logout", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, w.Code)
	}
	if loggedOutUser != "user-rt-1" {
		t.Errorf("expected loggedOutUser 'user-rt-1', got '%s'", loggedOutUser)
	}

	found := false
	for _, k := range mockCache.deletedKeys {
		if k == "refresh:token:rt-body-123" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected 'refresh:token:rt-body-123' in deleted keys, got %v", mockCache.deletedKeys)
	}
}

func TestAuthController_Logout_WithRefreshToken_InQuery(t *testing.T) {
	mockCache := newMockControllerCache()
	port := base.Port{Cache: mockCache}

	mockUc := &mockAuthUsecase{
		logoutFn: func(ctx context.Context, userID string) error {
			return nil
		},
	}

	ctrl := NewAuthControllerWithUsecase(port, base.BaseController{}, mockUc)
	router := gin.New()
	router.POST("/logout", func(c *gin.Context) {
		c.Set("userId", "user-rt-2")
		ctrl.Logout(c)
	})

	req, _ := http.NewRequest(http.MethodPost, "/logout?refreshToken=rt-query-456", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, w.Code)
	}

	found := false
	for _, k := range mockCache.deletedKeys {
		if k == "refresh:token:rt-query-456" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected 'refresh:token:rt-query-456' in deleted keys, got %v", mockCache.deletedKeys)
	}
}

func TestAuthController_Logout_WithRefreshToken_InHeader(t *testing.T) {
	mockCache := newMockControllerCache()
	port := base.Port{Cache: mockCache}

	mockUc := &mockAuthUsecase{
		logoutFn: func(ctx context.Context, userID string) error {
			return nil
		},
	}

	ctrl := NewAuthControllerWithUsecase(port, base.BaseController{}, mockUc)
	router := gin.New()
	router.POST("/logout", func(c *gin.Context) {
		c.Set("userId", "user-rt-3")
		ctrl.Logout(c)
	})

	req, _ := http.NewRequest(http.MethodPost, "/logout", nil)
	req.Header.Set("X-Refresh-Token", "rt-header-789")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, w.Code)
	}

	found := false
	for _, k := range mockCache.deletedKeys {
		if k == "refresh:token:rt-header-789" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected 'refresh:token:rt-header-789' in deleted keys, got %v", mockCache.deletedKeys)
	}
}

func TestAuthController_Logout_WithRefreshToken_FallbackCache(t *testing.T) {
	mockCache := newMockControllerCache()
	mockCache.store["session:user:user-fb-1"] = `{"id":"user-fb-1"}`
	mockCache.store["refresh:token:rt-fb-1"] = `{"id":"user-fb-1"}`
	port := base.Port{Cache: mockCache}

	mockUc := &mockAuthUsecaseWithoutLogout{}
	ctrl := NewAuthControllerWithUsecase(port, base.BaseController{}, mockUc)

	router := gin.New()
	router.POST("/logout", func(c *gin.Context) {
		c.Set("userId", "user-fb-1")
		ctrl.Logout(c)
	})

	body, _ := json.Marshal(authUsecase.LogoutRequest{
		RefreshToken: "rt-fb-1",
	})
	req, _ := http.NewRequest(http.MethodPost, "/logout", bytes.NewBuffer(body))
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, w.Code)
	}

	hasUserSessionDeleted := false
	hasRefreshTokenDeleted := false
	for _, k := range mockCache.deletedKeys {
		if k == "session:user:user-fb-1" {
			hasUserSessionDeleted = true
		}
		if k == "refresh:token:rt-fb-1" {
			hasRefreshTokenDeleted = true
		}
	}
	if !hasUserSessionDeleted {
		t.Errorf("expected session:user:user-fb-1 in deleted keys, got %v", mockCache.deletedKeys)
	}
	if !hasRefreshTokenDeleted {
		t.Errorf("expected refresh:token:rt-fb-1 in deleted keys, got %v", mockCache.deletedKeys)
	}
}
