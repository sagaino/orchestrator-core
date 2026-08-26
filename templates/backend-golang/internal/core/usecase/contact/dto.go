package contact

import "time"

type CreateContactRequest struct {
	Name        string `json:"name" binding:"required"`
	PhoneNumber string `json:"phone_number" binding:"required"`
}

type UpdateContactRequest struct {
	Name        string `json:"name" binding:"required"`
	PhoneNumber string `json:"phone_number" binding:"required"`
}

type ContactResponse struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	PhoneNumber string    `json:"phone_number"`
	CreatedAt   time.Time `json:"createdAt"`
	UpdatedAt   time.Time `json:"updatedAt"`
}
