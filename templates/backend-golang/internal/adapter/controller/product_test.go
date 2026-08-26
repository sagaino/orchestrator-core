package controller

import (
	"base-be-golang/internal/core/domain"
	"base-be-golang/internal/core/usecase/product"
	"base-be-golang/pkg/middleware"
	"base-be-golang/shared/base"
	"base-be-golang/shared/payload"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func init() {
	gin.SetMode(gin.TestMode)
}

type mockProductUsecase struct {
	createFn func(ctx context.Context, request product.CreateProductRequest) (domain.Product, error)
	getAllFn func(ctx context.Context) ([]domain.Product, error)
}

func (m *mockProductUsecase) Create(ctx context.Context, request product.CreateProductRequest) (domain.Product, error) {
	if m.createFn != nil {
		return m.createFn(ctx, request)
	}
	return domain.Product{}, nil
}

func (m *mockProductUsecase) GetAll(ctx context.Context) ([]domain.Product, error) {
	if m.getAllFn != nil {
		return m.getAllFn(ctx)
	}
	return []domain.Product{}, nil
}

func setupTestRouter(uc ProductUsecase) (*gin.Engine, *ProductController) {
	router := gin.New()
	enigma := middleware.NewEnigma()
	ctrl := NewProductControllerWithUsecase(
		base.Port{},
		base.BaseController{
			Enigma: enigma,
		},
		uc,
	)
	ctrl.RegisterRoutes(router)
	return router, ctrl
}

func TestProductController_Create_Success(t *testing.T) {
	expectedProduct := domain.Product{
		BaseEntity: domain.BaseEntity{ID: "p-1"},
		Name:       "Wireless Mouse",
		Price:      250000,
		Quantity:   20,
	}

	mockUc := &mockProductUsecase{
		createFn: func(ctx context.Context, request product.CreateProductRequest) (domain.Product, error) {
			if request.Name != "Wireless Mouse" {
				t.Errorf("expected name 'Wireless Mouse', got '%s'", request.Name)
			}
			if request.GetPrice() != 250000 {
				t.Errorf("expected price 250000, got %d", request.GetPrice())
			}
			if request.GetQuantity() != 20 {
				t.Errorf("expected quantity 20, got %d", request.GetQuantity())
			}
			return expectedProduct, nil
		},
	}

	router, _ := setupTestRouter(mockUc)

	reqBody := []byte(`{"name":"Wireless Mouse","price":250000,"quantity":20}`)
	req, err := http.NewRequest(http.MethodPost, "/products", bytes.NewBuffer(reqBody))
	if err != nil {
		t.Fatalf("failed to create request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d. Body: %s", http.StatusOK, w.Code, w.Body.String())
	}

	var resp payload.Response
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to parse response: %v", err)
	}

	if resp.Code != http.StatusOK {
		t.Errorf("expected code %d, got %v", http.StatusOK, resp.Code)
	}
	if resp.Message != "CreateProductSuccess" {
		t.Errorf("expected message 'CreateProductSuccess', got '%s'", resp.Message)
	}
}

func TestProductController_Create_ValidationError_MissingName(t *testing.T) {
	mockUc := &mockProductUsecase{}
	router, _ := setupTestRouter(mockUc)

	reqBody := []byte(`{"price":10000,"quantity":5}`)
	req, err := http.NewRequest(http.MethodPost, "/products", bytes.NewBuffer(reqBody))
	if err != nil {
		t.Fatalf("failed to create request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d. Body: %s", http.StatusBadRequest, w.Code, w.Body.String())
	}

	var resp payload.Response
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to parse response: %v", err)
	}

	if resp.Code != http.StatusBadRequest {
		t.Errorf("expected code %d for validation error, got %d", http.StatusBadRequest, resp.Code)
	}
}

func TestProductController_Create_ValidationError_MissingPrice(t *testing.T) {
	mockUc := &mockProductUsecase{}
	router, _ := setupTestRouter(mockUc)

	reqBody := []byte(`{"name":"Keyboard","quantity":5}`)
	req, err := http.NewRequest(http.MethodPost, "/products", bytes.NewBuffer(reqBody))
	if err != nil {
		t.Fatalf("failed to create request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d. Body: %s", http.StatusBadRequest, w.Code, w.Body.String())
	}
}

func TestProductController_Create_ValidationError_MissingQuantity(t *testing.T) {
	mockUc := &mockProductUsecase{}
	router, _ := setupTestRouter(mockUc)

	reqBody := []byte(`{"name":"Keyboard","price":100000}`)
	req, err := http.NewRequest(http.MethodPost, "/products", bytes.NewBuffer(reqBody))
	if err != nil {
		t.Fatalf("failed to create request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d. Body: %s", http.StatusBadRequest, w.Code, w.Body.String())
	}
}

func TestProductController_Create_ValidationError_NegativePrice(t *testing.T) {
	mockUc := &mockProductUsecase{}
	router, _ := setupTestRouter(mockUc)

	reqBody := []byte(`{"name":"Keyboard","price":-100,"quantity":5}`)
	req, err := http.NewRequest(http.MethodPost, "/products", bytes.NewBuffer(reqBody))
	if err != nil {
		t.Fatalf("failed to create request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d. Body: %s", http.StatusBadRequest, w.Code, w.Body.String())
	}
}

func TestProductController_Create_ValidationError_NegativeQuantity(t *testing.T) {
	mockUc := &mockProductUsecase{}
	router, _ := setupTestRouter(mockUc)

	reqBody := []byte(`{"name":"Keyboard","price":10000,"quantity":-1}`)
	req, err := http.NewRequest(http.MethodPost, "/products", bytes.NewBuffer(reqBody))
	if err != nil {
		t.Fatalf("failed to create request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d. Body: %s", http.StatusBadRequest, w.Code, w.Body.String())
	}
}

func TestProductController_Create_InvalidJSON(t *testing.T) {
	mockUc := &mockProductUsecase{}
	router, _ := setupTestRouter(mockUc)

	reqBody := []byte(`{invalid json}`)
	req, err := http.NewRequest(http.MethodPost, "/products", bytes.NewBuffer(reqBody))
	if err != nil {
		t.Fatalf("failed to create request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected status %d, got %d. Body: %s", http.StatusBadRequest, w.Code, w.Body.String())
	}
}

func TestProductController_Create_UsecaseError(t *testing.T) {
	mockUc := &mockProductUsecase{
		createFn: func(ctx context.Context, request product.CreateProductRequest) (domain.Product, error) {
			return domain.Product{}, errors.New("database connection lost")
		},
	}

	router, _ := setupTestRouter(mockUc)

	reqBody := []byte(`{"name":"USB Cable","price":20000,"quantity":100}`)
	req, err := http.NewRequest(http.MethodPost, "/products", bytes.NewBuffer(reqBody))
	if err != nil {
		t.Fatalf("failed to create request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("expected status %d, got %d. Body: %s", http.StatusInternalServerError, w.Code, w.Body.String())
	}
}

func TestProductController_GetAll_Success(t *testing.T) {
	expectedList := []domain.Product{
		{
			BaseEntity: domain.BaseEntity{ID: "p-1"},
			Name:       "Product 1",
			Price:      10000,
			Quantity:   5,
		},
		{
			BaseEntity: domain.BaseEntity{ID: "p-2"},
			Name:       "Product 2",
			Price:      20000,
			Quantity:   10,
		},
	}

	mockUc := &mockProductUsecase{
		getAllFn: func(ctx context.Context) ([]domain.Product, error) {
			return expectedList, nil
		},
	}

	router, _ := setupTestRouter(mockUc)

	req, err := http.NewRequest(http.MethodGet, "/products", nil)
	if err != nil {
		t.Fatalf("failed to create request: %v", err)
	}

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d. Body: %s", http.StatusOK, w.Code, w.Body.String())
	}

	var resp payload.Response
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to parse response: %v", err)
	}

	if resp.Code != http.StatusOK {
		t.Errorf("expected code %d, got %v", http.StatusOK, resp.Code)
	}
	if resp.Message != "GetProductsSuccess" {
		t.Errorf("expected message 'GetProductsSuccess', got '%s'", resp.Message)
	}
}

func TestProductController_GetAll_EmptyList(t *testing.T) {
	mockUc := &mockProductUsecase{
		getAllFn: func(ctx context.Context) ([]domain.Product, error) {
			return []domain.Product{}, nil
		},
	}

	router, _ := setupTestRouter(mockUc)

	req, err := http.NewRequest(http.MethodGet, "/products", nil)
	if err != nil {
		t.Fatalf("failed to create request: %v", err)
	}

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d. Body: %s", http.StatusOK, w.Code, w.Body.String())
	}

	var resp payload.Response
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to parse response: %v", err)
	}

	if resp.Code != http.StatusOK {
		t.Errorf("expected code %d, got %v", http.StatusOK, resp.Code)
	}
}

func TestProductController_GetAll_UsecaseError(t *testing.T) {
	mockUc := &mockProductUsecase{
		getAllFn: func(ctx context.Context) ([]domain.Product, error) {
			return nil, errors.New("database failure")
		},
	}

	router, _ := setupTestRouter(mockUc)

	req, err := http.NewRequest(http.MethodGet, "/products", nil)
	if err != nil {
		t.Fatalf("failed to create request: %v", err)
	}

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("expected status %d, got %d. Body: %s", http.StatusInternalServerError, w.Code, w.Body.String())
	}
}

func TestProductController_Route_Group(t *testing.T) {
	mockUc := &mockProductUsecase{
		getAllFn: func(ctx context.Context) ([]domain.Product, error) {
			return []domain.Product{
				{BaseEntity: domain.BaseEntity{ID: "p-1"}, Name: "Item", Price: 1000, Quantity: 1},
			}, nil
		},
		createFn: func(ctx context.Context, request product.CreateProductRequest) (domain.Product, error) {
			return domain.Product{BaseEntity: domain.BaseEntity{ID: "p-2"}, Name: request.Name, Price: request.GetPrice(), Quantity: request.GetQuantity()}, nil
		},
	}

	router := gin.New()
	group := router.Group("/api/v1")
	enigma := middleware.NewEnigma()
	ctrl := NewProductControllerWithUsecase(
		base.Port{},
		base.BaseController{
			Enigma: enigma,
		},
		mockUc,
	)
	ctrl.Route(group)

	// Test GET /api/v1/products
	reqGet, _ := http.NewRequest(http.MethodGet, "/api/v1/products", nil)
	wGet := httptest.NewRecorder()
	router.ServeHTTP(wGet, reqGet)

	if wGet.Code != http.StatusOK {
		t.Fatalf("expected GET /api/v1/products status %d, got %d", http.StatusOK, wGet.Code)
	}

	// Test POST /api/v1/products
	reqBody := []byte(`{"name":"New Item","price":5000,"quantity":10}`)
	reqPost, _ := http.NewRequest(http.MethodPost, "/api/v1/products", bytes.NewBuffer(reqBody))
	reqPost.Header.Set("Content-Type", "application/json")
	wPost := httptest.NewRecorder()
	router.ServeHTTP(wPost, reqPost)

	if wPost.Code != http.StatusOK {
		t.Fatalf("expected POST /api/v1/products status %d, got %d", http.StatusOK, wPost.Code)
	}
}

func TestProductController_Create_ZeroValues(t *testing.T) {
	expectedProduct := domain.Product{
		BaseEntity: domain.BaseEntity{ID: "p-10"},
		Name:       "Free Sample",
		Price:      0,
		Quantity:   0,
	}

	mockUc := &mockProductUsecase{
		createFn: func(ctx context.Context, request product.CreateProductRequest) (domain.Product, error) {
			if request.GetPrice() != 0 {
				t.Errorf("expected price 0, got %d", request.GetPrice())
			}
			if request.GetQuantity() != 0 {
				t.Errorf("expected quantity 0, got %d", request.GetQuantity())
			}
			return expectedProduct, nil
		},
	}

	router, _ := setupTestRouter(mockUc)

	reqBody := []byte(`{"name":"Free Sample","price":0,"quantity":0}`)
	req, err := http.NewRequest(http.MethodPost, "/products", bytes.NewBuffer(reqBody))
	if err != nil {
		t.Fatalf("failed to create request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d. Body: %s", http.StatusOK, w.Code, w.Body.String())
	}
}

func TestProductController_Create_WithoutEnigma(t *testing.T) {
	mockUc := &mockProductUsecase{
		createFn: func(ctx context.Context, request product.CreateProductRequest) (domain.Product, error) {
			return domain.Product{BaseEntity: domain.BaseEntity{ID: "p-1"}, Name: request.Name, Price: request.GetPrice(), Quantity: request.GetQuantity()}, nil
		},
	}

	router := gin.New()
	ctrl := NewProductControllerWithUsecase(
		base.Port{},
		base.BaseController{
			Enigma: nil,
		},
		mockUc,
	)
	ctrl.RegisterRoutes(router)

	t.Run("valid body without enigma", func(t *testing.T) {
		reqBody := []byte(`{"name":"Item","price":1000,"quantity":5}`)
		req, _ := http.NewRequest(http.MethodPost, "/products", bytes.NewBuffer(reqBody))
		req.Header.Set("Content-Type", "application/json")

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("expected status %d, got %d", http.StatusOK, w.Code)
		}
	})

	t.Run("invalid json body without enigma", func(t *testing.T) {
		reqBody := []byte(`{"name": invalid json}`)
		req, _ := http.NewRequest(http.MethodPost, "/products", bytes.NewBuffer(reqBody))
		req.Header.Set("Content-Type", "application/json")

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusBadRequest {
			t.Fatalf("expected status %d, got %d", http.StatusBadRequest, w.Code)
		}
	})
}

type testMockMapper struct {
	called bool
}

func (m *testMockMapper) NewResponse(c *gin.Context, res *payload.Response, err error) {
	m.called = true
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, res)
}

func TestProductController_WithMapper(t *testing.T) {
	mockMapper := &testMockMapper{}
	mockUc := &mockProductUsecase{
		getAllFn: func(ctx context.Context) ([]domain.Product, error) {
			return []domain.Product{{BaseEntity: domain.BaseEntity{ID: "p-1"}, Name: "Test", Price: 100, Quantity: 1}}, nil
		},
	}

	router := gin.New()
	ctrl := NewProductControllerWithUsecase(
		base.Port{},
		base.BaseController{
			Mapper: mockMapper,
		},
		mockUc,
	)
	ctrl.RegisterRoutes(router)

	req, _ := http.NewRequest(http.MethodGet, "/products", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d", http.StatusOK, w.Code)
	}

	if !mockMapper.called {
		t.Errorf("expected mapper to be called")
	}
}

func TestProductController_NilUsecase(t *testing.T) {
	router := gin.New()
	ctrl := NewProductControllerWithUsecase(
		base.Port{},
		base.BaseController{},
		nil,
	)
	ctrl.RegisterRoutes(router)

	t.Run("Create with nil usecase", func(t *testing.T) {
		reqBody := []byte(`{"name":"Item","price":1000,"quantity":5}`)
		req, _ := http.NewRequest(http.MethodPost, "/products", bytes.NewBuffer(reqBody))
		req.Header.Set("Content-Type", "application/json")

		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusInternalServerError {
			t.Fatalf("expected status %d, got %d", http.StatusInternalServerError, w.Code)
		}
	})

	t.Run("GetAll with nil usecase", func(t *testing.T) {
		req, _ := http.NewRequest(http.MethodGet, "/products", nil)
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusInternalServerError {
			t.Fatalf("expected status %d, got %d", http.StatusInternalServerError, w.Code)
		}
	})
}
