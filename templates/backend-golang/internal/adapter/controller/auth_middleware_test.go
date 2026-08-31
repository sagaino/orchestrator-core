package controller

import (
	authUsecase "base-be-golang/internal/core/usecase/auth"
	"base-be-golang/shared/payload"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

type dummyRouter struct {
	called bool
}

func (d *dummyRouter) Route(handler *gin.RouterGroup) {
	d.called = true
	handler.GET("/dummy", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"userId": c.GetString("userId")})
	})
	handler.POST("/dummy", func(c *gin.Context) {
		c.JSON(http.StatusCreated, gin.H{"status": "created"})
	})
	handler.DELETE("/dummy/:id", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "deleted"})
	})
}

func TestNewJWTAuthMiddleware_Success(t *testing.T) {
	router := gin.New()
	mockToken := &mockTokenService{}
	router.Use(NewJWTAuthMiddleware(mockToken))
	router.GET("/protected", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"userId":   c.GetString("userId"),
			"user_id":  c.GetString("user_id"),
			"email":    c.GetString("email"),
			"roleName": c.GetString("roleName"),
			"user":     c.GetString("user"),
		})
	})

	req, _ := http.NewRequest(http.MethodGet, "/protected", nil)
	req.Header.Set("Authorization", "Bearer valid-token-123")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d (body: %s)", http.StatusOK, w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	if resp["userId"] != "user-123" {
		t.Errorf("expected userId 'user-123', got '%v'", resp["userId"])
	}
	if resp["user_id"] != "user-123" {
		t.Errorf("expected user_id 'user-123', got '%v'", resp["user_id"])
	}
	if resp["email"] != "user@example.com" {
		t.Errorf("expected email 'user@example.com', got '%v'", resp["email"])
	}
	if resp["roleName"] != "admin" {
		t.Errorf("expected roleName 'admin', got '%v'", resp["roleName"])
	}
	if resp["user"] != "user@example.com" {
		t.Errorf("expected user 'user@example.com', got '%v'", resp["user"])
	}
}

func TestNewJWTAuthMiddleware_MissingHeader(t *testing.T) {
	router := gin.New()
	mockToken := &mockTokenService{}
	router.Use(NewJWTAuthMiddleware(mockToken))
	router.GET("/protected", func(c *gin.Context) {
		c.Status(http.StatusOK)
	})

	req, _ := http.NewRequest(http.MethodGet, "/protected", nil)
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
		t.Errorf("expected code %d, got %d", http.StatusUnauthorized, resp.Code)
	}
	if resp.Message != "Authorization header is required" {
		t.Errorf("expected message 'Authorization header is required', got '%s'", resp.Message)
	}
}

func TestNewJWTAuthMiddleware_InvalidHeaderFormat_NoBearer(t *testing.T) {
	router := gin.New()
	mockToken := &mockTokenService{}
	router.Use(NewJWTAuthMiddleware(mockToken))
	router.GET("/protected", func(c *gin.Context) {
		c.Status(http.StatusOK)
	})

	req, _ := http.NewRequest(http.MethodGet, "/protected", nil)
	req.Header.Set("Authorization", "Basic user-123")
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
		t.Errorf("expected code %d, got %d", http.StatusUnauthorized, resp.Code)
	}
	if resp.Message != "Invalid authorization header format" {
		t.Errorf("expected message 'Invalid authorization header format', got '%s'", resp.Message)
	}
}

func TestNewJWTAuthMiddleware_InvalidHeaderFormat_EmptyToken(t *testing.T) {
	router := gin.New()
	mockToken := &mockTokenService{}
	router.Use(NewJWTAuthMiddleware(mockToken))
	router.GET("/protected", func(c *gin.Context) {
		c.Status(http.StatusOK)
	})

	req, _ := http.NewRequest(http.MethodGet, "/protected", nil)
	req.Header.Set("Authorization", "Bearer ")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected status %d, got %d", http.StatusUnauthorized, w.Code)
	}

	var resp payload.ErrorResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal error response: %v", err)
	}
	if resp.Message != "Invalid authorization header format" {
		t.Errorf("expected message 'Invalid authorization header format', got '%s'", resp.Message)
	}
}

func TestNewJWTAuthMiddleware_InvalidToken(t *testing.T) {
	router := gin.New()
	mockToken := &mockTokenService{}
	router.Use(NewJWTAuthMiddleware(mockToken))
	router.GET("/protected", func(c *gin.Context) {
		c.Status(http.StatusOK)
	})

	req, _ := http.NewRequest(http.MethodGet, "/protected", nil)
	req.Header.Set("Authorization", "Bearer invalid-or-expired-token")
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
		t.Errorf("expected code %d, got %d", http.StatusUnauthorized, resp.Code)
	}
	if resp.Message != "Invalid or expired token" {
		t.Errorf("expected message 'Invalid or expired token', got '%s'", resp.Message)
	}
}

func TestNewJWTAuthMiddleware_NilTokenService(t *testing.T) {
	router := gin.New()
	router.Use(NewJWTAuthMiddleware(nil))
	router.GET("/protected", func(c *gin.Context) {
		c.Status(http.StatusOK)
	})

	req, _ := http.NewRequest(http.MethodGet, "/protected", nil)
	req.Header.Set("Authorization", "Bearer valid-token-123")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("expected status %d, got %d", http.StatusInternalServerError, w.Code)
	}
}

func TestNewJWTAuthMiddleware_SessionHit_Success(t *testing.T) {
	router := gin.New()
	mockToken := &mockTokenService{}
	mockCache := newMockControllerCache()

	now := time.Now().UTC()
	snapshot := authUsecase.UserSessionSnapshot{
		ID:        "user-123",
		Name:      "John Doe",
		Email:     "user@example.com",
		CreatedAt: now,
		UpdatedAt: now,
	}
	bytesData, _ := json.Marshal(snapshot)
	mockCache.store["session:user:user-123"] = string(bytesData)

	var capturedUser authUsecase.UserSessionSnapshot
	router.Use(NewJWTAuthMiddleware(mockToken, mockCache))
	router.GET("/protected", func(c *gin.Context) {
		if val, exists := c.Get("currentUser"); exists {
			if u, ok := val.(authUsecase.UserSessionSnapshot); ok {
				capturedUser = u
			}
		}
		c.Status(http.StatusOK)
	})

	req, _ := http.NewRequest(http.MethodGet, "/protected", nil)
	req.Header.Set("Authorization", "Bearer valid-token-123")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, w.Code)
	}

	if capturedUser.ID != "user-123" {
		t.Errorf("expected capturedUser.ID 'user-123', got '%s'", capturedUser.ID)
	}
	if capturedUser.Name != "John Doe" {
		t.Errorf("expected capturedUser.Name 'John Doe', got '%s'", capturedUser.Name)
	}
	if capturedUser.Email != "user@example.com" {
		t.Errorf("expected capturedUser.Email 'user@example.com', got '%s'", capturedUser.Email)
	}
}

func TestNewJWTAuthMiddleware_SessionMiss_401(t *testing.T) {
	router := gin.New()
	mockToken := &mockTokenService{}
	mockCache := newMockControllerCache() // empty cache

	router.Use(NewJWTAuthMiddleware(mockToken, mockCache))
	router.GET("/protected", func(c *gin.Context) {
		c.Status(http.StatusOK)
	})

	req, _ := http.NewRequest(http.MethodGet, "/protected", nil)
	req.Header.Set("Authorization", "Bearer valid-token-123")

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
		t.Errorf("expected code %d, got %d", http.StatusUnauthorized, resp.Code)
	}
	if resp.Message != "Session expired or invalid" {
		t.Errorf("expected message 'Session expired or invalid', got '%s'", resp.Message)
	}
}

func TestNewJWTAuthMiddleware_SessionHit_MapFallback(t *testing.T) {
	router := gin.New()
	mockToken := &mockTokenService{}
	mockCache := newMockControllerCache()
	mockCache.store["session:user:user-123"] = `{"custom_role":"manager","permissions":["read","write"]}`

	var capturedMap map[string]interface{}
	router.Use(NewJWTAuthMiddleware(mockToken, mockCache))
	router.GET("/protected", func(c *gin.Context) {
		if val, exists := c.Get("currentUser"); exists {
			if m, ok := val.(map[string]interface{}); ok {
				capturedMap = m
			}
		}
		c.Status(http.StatusOK)
	})

	req, _ := http.NewRequest(http.MethodGet, "/protected", nil)
	req.Header.Set("Authorization", "Bearer valid-token-123")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, w.Code)
	}
	if capturedMap == nil || capturedMap["custom_role"] != "manager" {
		t.Errorf("expected capturedMap with custom_role 'manager', got %v", capturedMap)
	}
}

func TestProtectedRouter_WithSessionCache_Hit_And_Miss(t *testing.T) {
	mockToken := &mockTokenService{}
	mockCache := newMockControllerCache()
	dummy := &dummyRouter{}
	protected := NewProtectedRouter(dummy, mockToken, mockCache)

	engine := gin.New()
	root := engine.Group("/api/v1")
	protected.Route(root)

	// 1. Session miss -> 401
	reqMiss, _ := http.NewRequest(http.MethodGet, "/api/v1/dummy", nil)
	reqMiss.Header.Set("Authorization", "Bearer valid-token-123")
	wMiss := httptest.NewRecorder()
	engine.ServeHTTP(wMiss, reqMiss)
	if wMiss.Code != http.StatusUnauthorized {
		t.Fatalf("expected status %d on session miss, got %d", http.StatusUnauthorized, wMiss.Code)
	}

	// 2. Add session -> Session hit -> 200
	mockCache.store["session:user:user-123"] = `{"id":"user-123","name":"John Doe"}`
	reqHit, _ := http.NewRequest(http.MethodGet, "/api/v1/dummy", nil)
	reqHit.Header.Set("Authorization", "Bearer valid-token-123")
	wHit := httptest.NewRecorder()
	engine.ServeHTTP(wHit, reqHit)
	if wHit.Code != http.StatusOK {
		t.Fatalf("expected status %d on session hit, got %d", http.StatusOK, wHit.Code)
	}
}

func TestProtectRoute_WithSessionCache_Hit_And_Miss(t *testing.T) {
	mockToken := &mockTokenService{}
	mockCache := newMockControllerCache()
	dummy := &dummyRouter{}
	router := ProtectRoute(dummy, mockToken, mockCache)

	engine := gin.New()
	root := engine.Group("/api/v1")
	router.Route(root)

	// 1. Session miss -> 401
	reqMiss, _ := http.NewRequest(http.MethodGet, "/api/v1/dummy", nil)
	reqMiss.Header.Set("Authorization", "Bearer valid-token-123")
	wMiss := httptest.NewRecorder()
	engine.ServeHTTP(wMiss, reqMiss)
	if wMiss.Code != http.StatusUnauthorized {
		t.Fatalf("expected status %d on session miss, got %d", http.StatusUnauthorized, wMiss.Code)
	}

	// 2. Add session -> Session hit -> 200
	mockCache.store["session:user:user-123"] = `{"id":"user-123"}`
	reqHit, _ := http.NewRequest(http.MethodGet, "/api/v1/dummy", nil)
	reqHit.Header.Set("Authorization", "Bearer valid-token-123")
	wHit := httptest.NewRecorder()
	engine.ServeHTTP(wHit, reqHit)
	if wHit.Code != http.StatusOK {
		t.Fatalf("expected status %d on session hit, got %d", http.StatusOK, wHit.Code)
	}
}
