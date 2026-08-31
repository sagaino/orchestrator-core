package auth

import (
	"encoding/json"
	"errors"
	"strings"
	"time"
)

type RegisterRequest struct {
	Name     string `json:"name" binding:"required"`
	Email    string `json:"email" binding:"required,email"`
	Password string `json:"password" binding:"required,min=6"`
}

type RegisterResponse struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Email     string    `json:"email"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type LoginRequest struct {
	Email    string `json:"email" binding:"required,email"`
	Password string `json:"password" binding:"required"`
}

type LoginResponse struct {
	AccessToken  string            `json:"accessToken"`
	RefreshToken string            `json:"refreshToken"`
	TokenType    string            `json:"tokenType"`
	User         *RegisterResponse `json:"user,omitempty"`
}

type RefreshTokenRequest struct {
	RefreshToken string `json:"refreshToken" binding:"required"`
}

type RefreshTokenResponse struct {
	AccessToken  string `json:"accessToken"`
	RefreshToken string `json:"refreshToken"`
	TokenType    string `json:"tokenType"`
}

type UserSessionSnapshot struct {
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	Email        string    `json:"email"`
	RefreshToken string    `json:"refreshToken,omitempty"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

func (u *UserSessionSnapshot) UnmarshalJSON(data []byte) error {
	type Alias UserSessionSnapshot
	var aux struct {
		Alias
	}
	if err := json.Unmarshal(data, &aux); err != nil {
		return err
	}
	if strings.TrimSpace(aux.ID) == "" && strings.TrimSpace(aux.Email) == "" && strings.TrimSpace(aux.Name) == "" {
		return errors.New("invalid user session snapshot: missing identifier fields")
	}
	*u = UserSessionSnapshot(aux.Alias)
	return nil
}

type LogoutRequest struct {
	UserID       string `json:"userId"`
	RefreshToken string `json:"refreshToken,omitempty"`
}
