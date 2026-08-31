package domain

import (
	"context"

	"gorm.io/gorm"
)

type User struct {
	BaseEntity
	Name     string `gorm:"column:name;type:varchar(255);not null" json:"name"`
	Email    string `gorm:"column:email;type:varchar(255);uniqueIndex;not null" json:"email"`
	Password string `gorm:"column:password;type:varchar(255);not null" json:"-"`
}

func (User) TableName() string {
	return "users"
}

type UserRepository interface {
	Create(ctx context.Context, user *User) error
	FindByEmail(ctx context.Context, email string) (*User, error)
	FindByID(ctx context.Context, id string) (*User, error)
}

type gormUserRepository struct {
	db *gorm.DB
}

func NewUserRepository(db *gorm.DB) UserRepository {
	return &gormUserRepository{db: db}
}

func (r *gormUserRepository) Create(ctx context.Context, user *User) error {
	if r.db == nil {
		return gorm.ErrInvalidDB
	}
	return r.db.WithContext(ctx).Create(user).Error
}

func (r *gormUserRepository) FindByEmail(ctx context.Context, email string) (*User, error) {
	if r.db == nil {
		return nil, gorm.ErrInvalidDB
	}
	var user User
	err := r.db.WithContext(ctx).First(&user, "email = ?", email).Error
	if err != nil {
		return nil, err
	}
	return &user, nil
}

func (r *gormUserRepository) FindByID(ctx context.Context, id string) (*User, error) {
	if r.db == nil {
		return nil, gorm.ErrInvalidDB
	}
	var user User
	err := r.db.WithContext(ctx).First(&user, "id = ?", id).Error
	if err != nil {
		return nil, err
	}
	return &user, nil
}
