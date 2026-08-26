package contact

import (
	"context"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"base-be-golang/internal/core/domain"
	"base-be-golang/pkg/db"
	"base-be-golang/pkg/localerror"
	"base-be-golang/shared/base"
)

// ContactRepository defines the database methods needed by Contact usecase.
type ContactRepository interface {
	Store(ctx context.Context, data domain.Contact) (domain.Contact, error)
	FindAll(ctx context.Context) ([]domain.Contact, error)
	FindOneByID(ctx context.Context, id interface{}) (domain.Contact, error)
	Update(ctx context.Context, data domain.Contact) error
	DeleteByID(ctx context.Context, id interface{}) error
}

type Usecase struct {
	base.Port
	repo ContactRepository
}

func NewUsecase(dbConn *gorm.DB, port base.Port) Usecase {
	return Usecase{
		Port: port,
		repo: db.NewGenericeRepoPointr(dbConn, domain.Contact{}),
	}
}

func NewUsecaseWithRepo(port base.Port, repo ContactRepository) Usecase {
	return Usecase{
		Port: port,
		repo: repo,
	}
}

func (u Usecase) Create(ctx context.Context, req CreateContactRequest) (ContactResponse, error) {
	contact := domain.Contact{
		BaseEntity:  domain.BaseEntity{ID: uuid.New().String()},
		Name:        req.Name,
		PhoneNumber: req.PhoneNumber,
	}
	contact.SetCreated("system")

	saved, err := u.repo.Store(ctx, contact)
	if err != nil {
		if u.ErrHandler != nil {
			return ContactResponse{}, u.ErrHandler.ErrorReturn(err)
		}
		return ContactResponse{}, err
	}

	return ContactResponse{
		ID:          saved.ID,
		Name:        saved.Name,
		PhoneNumber: saved.PhoneNumber,
		CreatedAt:   saved.CreatedAt,
		UpdatedAt:   saved.UpdatedAt,
	}, nil
}

func (u Usecase) GetAll(ctx context.Context) ([]ContactResponse, error) {
	contacts, err := u.repo.FindAll(ctx)
	if err != nil {
		if u.ErrHandler != nil {
			return nil, u.ErrHandler.ErrorReturn(err)
		}
		return nil, err
	}

	res := make([]ContactResponse, len(contacts))
	for i, c := range contacts {
		res[i] = ContactResponse{
			ID:          c.ID,
			Name:        c.Name,
			PhoneNumber: c.PhoneNumber,
			CreatedAt:   c.CreatedAt,
			UpdatedAt:   c.UpdatedAt,
		}
	}
	return res, nil
}

func (u Usecase) GetByID(ctx context.Context, id string) (ContactResponse, error) {
	contact, err := u.repo.FindOneByID(ctx, id)
	if err != nil {
		if u.ErrHandler != nil {
			return ContactResponse{}, u.ErrHandler.ErrorReturn(localerror.NotFound(err, "ContactNotFound"))
		}
		return ContactResponse{}, localerror.NotFound(err, "ContactNotFound")
	}

	return ContactResponse{
		ID:          contact.ID,
		Name:        contact.Name,
		PhoneNumber: contact.PhoneNumber,
		CreatedAt:   contact.CreatedAt,
		UpdatedAt:   contact.UpdatedAt,
	}, nil
}

func (u Usecase) Update(ctx context.Context, id string, req UpdateContactRequest) (ContactResponse, error) {
	contact, err := u.repo.FindOneByID(ctx, id)
	if err != nil {
		if u.ErrHandler != nil {
			return ContactResponse{}, u.ErrHandler.ErrorReturn(localerror.NotFound(err, "ContactNotFound"))
		}
		return ContactResponse{}, localerror.NotFound(err, "ContactNotFound")
	}

	contact.Name = req.Name
	contact.PhoneNumber = req.PhoneNumber
	contact.SetCreated("system")

	if err := u.repo.Update(ctx, contact); err != nil {
		if u.ErrHandler != nil {
			return ContactResponse{}, u.ErrHandler.ErrorReturn(err)
		}
		return ContactResponse{}, err
	}

	return ContactResponse{
		ID:          contact.ID,
		Name:        contact.Name,
		PhoneNumber: contact.PhoneNumber,
		CreatedAt:   contact.CreatedAt,
		UpdatedAt:   contact.UpdatedAt,
	}, nil
}

func (u Usecase) Delete(ctx context.Context, id string) error {
	return u.repo.DeleteByID(ctx, id)
}
