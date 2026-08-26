package product

import (
	"context"

	"base-be-golang/internal/core/domain"
)

// CreateProductRequest represents the payload for creating a new product.
type CreateProductRequest struct {
	Name     string `json:"name" validate:"required"`
	Price    *int   `json:"price" validate:"required,gte=0"`
	Quantity *int   `json:"quantity" validate:"required,gte=0"`
}

// GetPrice safely returns the price value as int.
func (r CreateProductRequest) GetPrice() int {
	if r.Price != nil {
		return *r.Price
	}
	return 0
}

// GetQuantity safely returns the quantity value as int.
func (r CreateProductRequest) GetQuantity() int {
	if r.Quantity != nil {
		return *r.Quantity
	}
	return 0
}

// ProductRepository defines the repository methods required by the product usecase.
type ProductRepository interface {
	Store(ctx context.Context, data domain.Product) (domain.Product, error)
	FindAll(ctx context.Context) ([]domain.Product, error)
}
