package product

import (
	"base-be-golang/internal/core/domain"
	"base-be-golang/pkg/db"
	"base-be-golang/shared/base"
	"context"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

// Usecase handles business logic for products.
type Usecase struct {
	base.Port
	productRepo ProductRepository
}

// NewUsecase creates a new product usecase with a database connection and base Port.
func NewUsecase(dbConn *gorm.DB, port base.Port) Usecase {
	return Usecase{
		Port:        port,
		productRepo: db.NewGenericeRepoPointr(dbConn, domain.Product{}),
	}
}

// NewUsecaseWithRepo creates a product usecase with an explicit ProductRepository (useful for testing and dependency injection).
func NewUsecaseWithRepo(port base.Port, repo ProductRepository) Usecase {
	return Usecase{
		Port:        port,
		productRepo: repo,
	}
}

// Create creates a new product and returns the created entity.
func (u Usecase) Create(ctx context.Context, request CreateProductRequest) (domain.Product, error) {
	product := domain.Product{
		BaseEntity: domain.BaseEntity{
			ID: uuid.New().String(),
		},
		Name:     request.Name,
		Price:    request.GetPrice(),
		Quantity: request.GetQuantity(),
	}
	product.SetCreated("system")

	created, err := u.productRepo.Store(ctx, product)
	if err != nil {
		if u.ErrHandler != nil {
			return domain.Product{}, u.ErrHandler.ErrorReturn(err)
		}
		return domain.Product{}, err
	}

	return created, nil
}

// GetAll returns all products.
func (u Usecase) GetAll(ctx context.Context) ([]domain.Product, error) {
	products, err := u.productRepo.FindAll(ctx)
	if err != nil {
		if u.ErrHandler != nil {
			return nil, u.ErrHandler.ErrorReturn(err)
		}
		return nil, err
	}

	if products == nil {
		products = []domain.Product{}
	}

	return products, nil
}
