package health

import (
	"base-be-golang/shared/base"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func init() {
	gin.SetMode(gin.TestMode)
}

func TestHealthCheck_Success(t *testing.T) {
	origEnv := os.Getenv("ENVIRONMENT")
	defer os.Setenv("ENVIRONMENT", origEnv)

	os.Setenv("ENVIRONMENT", "testing")

	router := gin.New()
	RegisterRoutes(router)

	req, err := http.NewRequest(http.MethodGet, "/health", nil)
	if err != nil {
		t.Fatalf("failed to create request: %v", err)
	}

	w := httptest.NewRecorder()
	beforeCall := time.Now().Unix()
	router.ServeHTTP(w, req)
	afterCall := time.Now().Unix()

	if w.Code != http.StatusOK {
		t.Fatalf("expected status code %d, got %d", http.StatusOK, w.Code)
	}

	contentType := w.Header().Get("Content-Type")
	if contentType != "application/json; charset=utf-8" {
		t.Errorf("expected Content-Type application/json; charset=utf-8, got %s", contentType)
	}

	var resp Response
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal JSON response: %v", err)
	}

	if resp.Status != "OK" {
		t.Errorf("expected status 'OK', got '%s'", resp.Status)
	}

	if resp.Uptime < beforeCall || resp.Uptime > afterCall {
		t.Errorf("expected uptime between %d and %d, got %d", beforeCall, afterCall, resp.Uptime)
	}

	if resp.Environment != "testing" {
		t.Errorf("expected environment 'testing', got '%s'", resp.Environment)
	}
}

func TestHealthCheck_DefaultEnvironment(t *testing.T) {
	origEnv := os.Getenv("ENVIRONMENT")
	defer os.Setenv("ENVIRONMENT", origEnv)

	os.Unsetenv("ENVIRONMENT")

	router := gin.New()
	ctrl := New()
	router.GET("/health", ctrl.HealthCheck)

	req, err := http.NewRequest(http.MethodGet, "/health", nil)
	if err != nil {
		t.Fatalf("failed to create request: %v", err)
	}

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status code %d, got %d", http.StatusOK, w.Code)
	}

	var resp Response
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal JSON response: %v", err)
	}

	if resp.Status != "OK" {
		t.Errorf("expected status 'OK', got '%s'", resp.Status)
	}

	if resp.Uptime <= 0 {
		t.Errorf("expected uptime > 0, got %d", resp.Uptime)
	}

	if resp.Environment != "development" {
		t.Errorf("expected default environment 'development', got '%s'", resp.Environment)
	}
}

func TestHealthController_Route(t *testing.T) {
	origEnv := os.Getenv("ENVIRONMENT")
	defer os.Setenv("ENVIRONMENT", origEnv)

	os.Setenv("ENVIRONMENT", "production")

	router := gin.New()
	group := router.Group("/api/v1")

	ctrl := NewHealthController(base.Port{}, base.BaseController{})
	ctrl.Route(group)

	req, err := http.NewRequest(http.MethodGet, "/api/v1/health", nil)
	if err != nil {
		t.Fatalf("failed to create request: %v", err)
	}

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status code %d, got %d", http.StatusOK, w.Code)
	}

	var rawMap map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &rawMap); err != nil {
		t.Fatalf("failed to unmarshal raw JSON response: %v", err)
	}

	if rawMap["status"] != "OK" {
		t.Errorf("expected status 'OK', got %v", rawMap["status"])
	}

	if _, ok := rawMap["uptime"]; !ok {
		t.Errorf("expected 'uptime' field in response")
	}

	if rawMap["environment"] != "production" {
		t.Errorf("expected environment 'production', got %v", rawMap["environment"])
	}
}

func TestHealthResponse_PayloadFields(t *testing.T) {
	origEnv := os.Getenv("ENVIRONMENT")
	defer os.Setenv("ENVIRONMENT", origEnv)

	os.Setenv("ENVIRONMENT", "staging")

	router := gin.New()
	RegisterRoutes(router)

	req, err := http.NewRequest(http.MethodGet, "/health", nil)
	if err != nil {
		t.Fatalf("failed to create request: %v", err)
	}

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	var payload map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil {
		t.Fatalf("failed to parse json: %v", err)
	}

	expectedKeys := []string{"status", "uptime", "environment"}
	for _, key := range expectedKeys {
		if _, exists := payload[key]; !exists {
			t.Errorf("expected key '%s' to be present in response payload", key)
		}
	}
}
