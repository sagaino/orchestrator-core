package domain

import (
	"testing"
)

func TestProduct_TableName(t *testing.T) {
	p := Product{}
	if got := p.TableName(); got != "products" {
		t.Errorf("Product.TableName() = %v, want %v", got, "products")
	}
}

func TestProduct_BaseEntity(t *testing.T) {
	uuidStr := "411ec30b-665e-46bd-95a0-3d3f3f6b8fc4"
	p := Product{
		BaseEntity: BaseEntity{
			ID: uuidStr,
		},
		Name:     "Test Product",
		Price:    50000,
		Quantity: 10,
	}
	p.SetCreated("test-user")

	if p.ID != uuidStr {
		t.Errorf("expected ID %v, got %v", uuidStr, p.ID)
	}
	if p.CreatedBy != "test-user" {
		t.Errorf("expected CreatedBy 'test-user', got %v", p.CreatedBy)
	}
	if p.CreatedAt.IsZero() {
		t.Errorf("expected CreatedAt not to be zero")
	}
}
