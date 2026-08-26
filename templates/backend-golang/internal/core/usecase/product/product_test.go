package product

import (
	"base-be-golang/internal/core/domain"
	"base-be-golang/pkg/localerror"
	"base-be-golang/pkg/logger"
	"base-be-golang/shared/base"
	"context"
	"errors"
	"testing"
)

type mockProductRepository struct {
	storeFn   func(ctx context.Context, data domain.Product) (domain.Product, error)
	findAllFn func(ctx context.Context) ([]domain.Product, error)
}

func (m *mockProductRepository) Store(ctx context.Context, data domain.Product) (domain.Product, error) {
	if m.storeFn != nil {
		return m.storeFn(ctx, data)
	}
	return data, nil
}

func (m *mockProductRepository) FindAll(ctx context.Context) ([]domain.Product, error) {
	if m.findAllFn != nil {
		return m.findAllFn(ctx)
	}
	return []domain.Product{}, nil
}

func intPtr(i int) *int {
	return &i
}

func TestCreateProductRequest_Getters(t *testing.T) {
	t.Run("with non-nil values", func(t *testing.T) {
		req := CreateProductRequest{
			Name:     "Keyboard",
			Price:    intPtr(150000),
			Quantity: intPtr(10),
		}

		if req.GetPrice() != 150000 {
			t.Errorf("expected price 150000, got %d", req.GetPrice())
		}
		if req.GetQuantity() != 10 {
			t.Errorf("expected quantity 10, got %d", req.GetQuantity())
		}
	})

	t.Run("with nil values", func(t *testing.T) {
		req := CreateProductRequest{
			Name:     "Keyboard",
			Price:    nil,
			Quantity: nil,
		}

		if req.GetPrice() != 0 {
			t.Errorf("expected price 0, got %d", req.GetPrice())
		}
		if req.GetQuantity() != 0 {
			t.Errorf("expected quantity 0, got %d", req.GetQuantity())
		}
	})
}

func TestUsecase_Create_Success(t *testing.T) {
	ctx := context.Background()
	expectedID := "411ec30b-665e-46bd-95a0-3d3f3f6b8fc4"
	expectedName := "Mechanical Keyboard"
	expectedPrice := 500000
	expectedQty := 25

	mockRepo := &mockProductRepository{
		storeFn: func(ctx context.Context, data domain.Product) (domain.Product, error) {
			data.ID = expectedID
			return data, nil
		},
	}

	uc := NewUsecaseWithRepo(base.Port{}, mockRepo)

	req := CreateProductRequest{
		Name:     expectedName,
		Price:    intPtr(expectedPrice),
		Quantity: intPtr(expectedQty),
	}

	created, err := uc.Create(ctx, req)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}

	if created.ID != expectedID {
		t.Errorf("expected product ID %s, got %s", expectedID, created.ID)
	}
	if created.Name != expectedName {
		t.Errorf("expected product name '%s', got '%s'", expectedName, created.Name)
	}
	if created.Price != expectedPrice {
		t.Errorf("expected product price %d, got %d", expectedPrice, created.Price)
	}
	if created.Quantity != expectedQty {
		t.Errorf("expected product quantity %d, got %d", expectedQty, created.Quantity)
	}
}

func TestUsecase_Create_RepoError(t *testing.T) {
	ctx := context.Background()
	expectedErr := errors.New("db insert failed")

	mockRepo := &mockProductRepository{
		storeFn: func(ctx context.Context, data domain.Product) (domain.Product, error) {
			return domain.Product{}, expectedErr
		},
	}

	uc := NewUsecaseWithRepo(base.Port{}, mockRepo)

	req := CreateProductRequest{
		Name:     "Mouse",
		Price:    intPtr(100000),
		Quantity: intPtr(5),
	}

	_, err := uc.Create(ctx, req)
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
}

func TestUsecase_GetAll_Success(t *testing.T) {
	ctx := context.Background()
	expectedProducts := []domain.Product{
		{
			BaseEntity: domain.BaseEntity{ID: "p-1"},
			Name:       "Monitor 4K",
			Price:      4000000,
			Quantity:   15,
		},
		{
			BaseEntity: domain.BaseEntity{ID: "p-2"},
			Name:       "USB-C Hub",
			Price:      350000,
			Quantity:   50,
		},
	}

	mockRepo := &mockProductRepository{
		findAllFn: func(ctx context.Context) ([]domain.Product, error) {
			return expectedProducts, nil
		},
	}

	uc := NewUsecaseWithRepo(base.Port{}, mockRepo)

	products, err := uc.GetAll(ctx)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}

	if len(products) != len(expectedProducts) {
		t.Fatalf("expected %d products, got %d", len(expectedProducts), len(products))
	}

	for i, p := range products {
		if p.ID != expectedProducts[i].ID {
			t.Errorf("expected product ID %s, got %s", expectedProducts[i].ID, p.ID)
		}
		if p.Name != expectedProducts[i].Name {
			t.Errorf("expected product name '%s', got '%s'", expectedProducts[i].Name, p.Name)
		}
		if p.Price != expectedProducts[i].Price {
			t.Errorf("expected product price %d, got %d", expectedProducts[i].Price, p.Price)
		}
		if p.Quantity != expectedProducts[i].Quantity {
			t.Errorf("expected product quantity %d, got %d", expectedProducts[i].Quantity, p.Quantity)
		}
	}
}

func TestUsecase_GetAll_EmptyList(t *testing.T) {
	ctx := context.Background()

	mockRepo := &mockProductRepository{
		findAllFn: func(ctx context.Context) ([]domain.Product, error) {
			return nil, nil
		},
	}

	uc := NewUsecaseWithRepo(base.Port{}, mockRepo)

	products, err := uc.GetAll(ctx)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}

	if products == nil {
		t.Fatalf("expected non-nil empty slice, got nil")
	}

	if len(products) != 0 {
		t.Fatalf("expected 0 products, got %d", len(products))
	}
}

func TestUsecase_GetAll_RepoError(t *testing.T) {
	ctx := context.Background()
	expectedErr := errors.New("db query failed")

	mockRepo := &mockProductRepository{
		findAllFn: func(ctx context.Context) ([]domain.Product, error) {
			return nil, expectedErr
		},
	}

	uc := NewUsecaseWithRepo(base.Port{}, mockRepo)

	_, err := uc.GetAll(ctx)
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
}

type mockErrHandler struct {
	errorReturnFn func(err error) error
}

func (m *mockErrHandler) ErrorPrint(err error) {}
func (m *mockErrHandler) DebugPrint(err string, v ...interface{}) {}
func (m *mockErrHandler) ErrorReturn(err error) error {
	if m.errorReturnFn != nil {
		return m.errorReturnFn(err)
	}
	return err
}

func TestUsecase_Create_WithErrorHandler(t *testing.T) {
	ctx := context.Background()
	originalErr := errors.New("underlying db error")
	handledErr := errors.New("handled error")

	mockRepo := &mockProductRepository{
		storeFn: func(ctx context.Context, data domain.Product) (domain.Product, error) {
			return domain.Product{}, originalErr
		},
	}

	handler := &mockErrHandler{
		errorReturnFn: func(err error) error {
			if !errors.Is(err, originalErr) && err.Error() != originalErr.Error() {
				t.Errorf("expected original error, got %v", err)
			}
			return handledErr
		},
	}

	port := base.Port{
		ErrHandler: handler,
	}

	uc := NewUsecaseWithRepo(port, mockRepo)

	req := CreateProductRequest{
		Name:     "Tablet",
		Price:    intPtr(3000000),
		Quantity: intPtr(8),
	}

	_, err := uc.Create(ctx, req)
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
	if err != handledErr {
		t.Errorf("expected handled error %v, got %v", handledErr, err)
	}
}

func TestUsecase_GetAll_WithErrorHandler(t *testing.T) {
	ctx := context.Background()
	originalErr := errors.New("underlying query error")
	handledErr := errors.New("handled error")

	mockRepo := &mockProductRepository{
		findAllFn: func(ctx context.Context) ([]domain.Product, error) {
			return nil, originalErr
		},
	}

	handler := &mockErrHandler{
		errorReturnFn: func(err error) error {
			if !errors.Is(err, originalErr) && err.Error() != originalErr.Error() {
				t.Errorf("expected original error, got %v", err)
			}
			return handledErr
		},
	}

	port := base.Port{
		ErrHandler: handler,
	}

	uc := NewUsecaseWithRepo(port, mockRepo)

	_, err := uc.GetAll(ctx)
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
	if err != handledErr {
		t.Errorf("expected handled error %v, got %v", handledErr, err)
	}
}

func TestUsecase_Create_WithRealHandleError_NilLogger(t *testing.T) {
	ctx := context.Background()
	originalErr := errors.New("underlying db insert error")

	mockRepo := &mockProductRepository{
		storeFn: func(ctx context.Context, data domain.Product) (domain.Product, error) {
			return domain.Product{}, originalErr
		},
	}

	port := base.Port{
		ErrHandler: localerror.NewHandlerError(nil),
	}

	uc := NewUsecaseWithRepo(port, mockRepo)

	req := CreateProductRequest{
		Name:     "Mouse",
		Price:    intPtr(50000),
		Quantity: intPtr(2),
	}

	_, err := uc.Create(ctx, req)
	if err == nil {
		t.Fatalf("expected error, got nil")
	}

	var internalErr localerror.InternalError
	if !errors.As(err, &internalErr) {
		t.Errorf("expected localerror.InternalError, got %T: %v", err, err)
	}
}

func TestUsecase_GetAll_WithRealHandleError_NilLogger(t *testing.T) {
	ctx := context.Background()
	originalErr := errors.New("underlying db query error")

	mockRepo := &mockProductRepository{
		findAllFn: func(ctx context.Context) ([]domain.Product, error) {
			return nil, originalErr
		},
	}

	port := base.Port{
		ErrHandler: localerror.NewHandlerError(nil),
	}

	uc := NewUsecaseWithRepo(port, mockRepo)

	_, err := uc.GetAll(ctx)
	if err == nil {
		t.Fatalf("expected error, got nil")
	}

	var internalErr localerror.InternalError
	if !errors.As(err, &internalErr) {
		t.Errorf("expected localerror.InternalError, got %T: %v", err, err)
	}
}

func TestUsecase_GetAll_WithRealHandleError_UninitializedLogger(t *testing.T) {
	ctx := context.Background()
	originalErr := errors.New("underlying db query error")

	mockRepo := &mockProductRepository{
		findAllFn: func(ctx context.Context) ([]domain.Product, error) {
			return nil, originalErr
		},
	}

	port := base.Port{
		ErrHandler: localerror.NewHandlerError(&logger.ReZero{}),
	}

	uc := NewUsecaseWithRepo(port, mockRepo)

	_, err := uc.GetAll(ctx)
	if err == nil {
		t.Fatalf("expected error, got nil")
	}

	var internalErr localerror.InternalError
	if !errors.As(err, &internalErr) {
		t.Errorf("expected localerror.InternalError, got %T: %v", err, err)
	}
}
