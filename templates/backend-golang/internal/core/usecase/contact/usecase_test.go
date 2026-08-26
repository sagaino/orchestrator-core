package contact

import (
	"context"
	"errors"
	"testing"

	"base-be-golang/internal/core/domain"
	"base-be-golang/shared/base"
)

type mockContactRepository struct {
	storeFn      func(ctx context.Context, data domain.Contact) (domain.Contact, error)
	findAllFn    func(ctx context.Context) ([]domain.Contact, error)
	findOneByIDFn func(ctx context.Context, id interface{}) (domain.Contact, error)
	updateFn     func(ctx context.Context, data domain.Contact) error
	deleteByIDFn func(ctx context.Context, id interface{}) error
}

func (m *mockContactRepository) Store(ctx context.Context, data domain.Contact) (domain.Contact, error) {
	if m.storeFn != nil {
		return m.storeFn(ctx, data)
	}
	return data, nil
}

func (m *mockContactRepository) FindAll(ctx context.Context) ([]domain.Contact, error) {
	if m.findAllFn != nil {
		return m.findAllFn(ctx)
	}
	return []domain.Contact{}, nil
}

func (m *mockContactRepository) FindOneByID(ctx context.Context, id interface{}) (domain.Contact, error) {
	if m.findOneByIDFn != nil {
		return m.findOneByIDFn(ctx, id)
	}
	return domain.Contact{}, nil
}

func (m *mockContactRepository) Update(ctx context.Context, data domain.Contact) error {
	if m.updateFn != nil {
		return m.updateFn(ctx, data)
	}
	return nil
}

func (m *mockContactRepository) DeleteByID(ctx context.Context, id interface{}) error {
	if m.deleteByIDFn != nil {
		return m.deleteByIDFn(ctx, id)
	}
	return nil
}

func TestUsecase_Create(t *testing.T) {
	ctx := context.Background()
	mockRepo := &mockContactRepository{
		storeFn: func(ctx context.Context, data domain.Contact) (domain.Contact, error) {
			data.ID = "c-123"
			return data, nil
		},
	}

	uc := NewUsecaseWithRepo(base.Port{}, mockRepo)
	res, err := uc.Create(ctx, CreateContactRequest{
		Name:        "Alice",
		PhoneNumber: "081234567890",
	})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if res.ID != "c-123" || res.Name != "Alice" || res.PhoneNumber != "081234567890" {
		t.Errorf("unexpected response: %+v", res)
	}
}

func TestUsecase_GetAll(t *testing.T) {
	ctx := context.Background()
	mockRepo := &mockContactRepository{
		findAllFn: func(ctx context.Context) ([]domain.Contact, error) {
			return []domain.Contact{
				{BaseEntity: domain.BaseEntity{ID: "c-1"}, Name: "Alice", PhoneNumber: "111"},
				{BaseEntity: domain.BaseEntity{ID: "c-2"}, Name: "Bob", PhoneNumber: "222"},
			}, nil
		},
	}

	uc := NewUsecaseWithRepo(base.Port{}, mockRepo)
	res, err := uc.GetAll(ctx)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if len(res) != 2 {
		t.Fatalf("expected 2 contacts, got %d", len(res))
	}
}

func TestUsecase_GetByID(t *testing.T) {
	ctx := context.Background()
	mockRepo := &mockContactRepository{
		findOneByIDFn: func(ctx context.Context, id interface{}) (domain.Contact, error) {
			if id == "c-1" {
				return domain.Contact{BaseEntity: domain.BaseEntity{ID: "c-1"}, Name: "Alice", PhoneNumber: "111"}, nil
			}
			return domain.Contact{}, errors.New("not found")
		},
	}

	uc := NewUsecaseWithRepo(base.Port{}, mockRepo)
	res, err := uc.GetByID(ctx, "c-1")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if res.Name != "Alice" {
		t.Errorf("expected Name 'Alice', got '%s'", res.Name)
	}
}

func TestUsecase_Update(t *testing.T) {
	ctx := context.Background()
	mockRepo := &mockContactRepository{
		findOneByIDFn: func(ctx context.Context, id interface{}) (domain.Contact, error) {
			return domain.Contact{BaseEntity: domain.BaseEntity{ID: "c-1"}, Name: "Old Name", PhoneNumber: "111"}, nil
		},
		updateFn: func(ctx context.Context, data domain.Contact) error {
			return nil
		},
	}

	uc := NewUsecaseWithRepo(base.Port{}, mockRepo)
	res, err := uc.Update(ctx, "c-1", UpdateContactRequest{
		Name:        "New Name",
		PhoneNumber: "999",
	})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if res.Name != "New Name" || res.PhoneNumber != "999" {
		t.Errorf("unexpected updated response: %+v", res)
	}
}

func TestUsecase_Delete(t *testing.T) {
	ctx := context.Background()
	called := false
	mockRepo := &mockContactRepository{
		deleteByIDFn: func(ctx context.Context, id interface{}) error {
			called = true
			return nil
		},
	}

	uc := NewUsecaseWithRepo(base.Port{}, mockRepo)
	err := uc.Delete(ctx, "c-1")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if !called {
		t.Errorf("expected DeleteByID to be called")
	}
}
