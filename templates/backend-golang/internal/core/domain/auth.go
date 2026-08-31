package domain

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v4"
	"golang.org/x/crypto/bcrypt"
)

type AuthToken struct {
	AccessToken string `json:"accessToken"`
	TokenType   string `json:"tokenType"`
	ExpiresIn   int64  `json:"expiresIn"`
}

type JWTClaims struct {
	UserID   string `json:"userId"`
	Email    string `json:"email"`
	RoleName string `json:"roleName,omitempty"`
	jwt.RegisteredClaims
}

type PasswordHasher interface {
	HashPassword(password string) (string, error)
	ComparePassword(hashedPassword, password string) error
}

type TokenService interface {
	GenerateToken(ctx context.Context, user *User) (string, error)
	ValidateToken(ctx context.Context, tokenString string) (*JWTClaims, error)
}

type BcryptPasswordHasher struct {
	Cost int
}

func NewBcryptPasswordHasher(cost ...int) PasswordHasher {
	c := bcrypt.DefaultCost
	if len(cost) > 0 && cost[0] > 0 {
		c = cost[0]
	}
	return &BcryptPasswordHasher{Cost: c}
}

func (h *BcryptPasswordHasher) HashPassword(password string) (string, error) {
	bytes, err := bcrypt.GenerateFromPassword([]byte(password), h.Cost)
	if err != nil {
		return "", err
	}
	return string(bytes), nil
}

func (h *BcryptPasswordHasher) ComparePassword(hashedPassword, password string) error {
	return bcrypt.CompareHashAndPassword([]byte(hashedPassword), []byte(password))
}

type jwtTokenService struct {
	secretKey     []byte
	tokenDuration time.Duration
	issuer        string
}

func NewJWTTokenService(secretKey string, durationMinutes int, issuer ...string) TokenService {
	iss := "base-be-golang"
	if len(issuer) > 0 && issuer[0] != "" {
		iss = issuer[0]
	}
	dur := 3 * time.Minute
	if durationMinutes > 0 {
		dur = time.Duration(durationMinutes) * time.Minute
	}
	return &jwtTokenService{
		secretKey:     []byte(secretKey),
		tokenDuration: dur,
		issuer:        iss,
	}
}

func NewJWTTokenServiceWithDuration(secretKey string, duration time.Duration, issuer ...string) TokenService {
	iss := "base-be-golang"
	if len(issuer) > 0 && issuer[0] != "" {
		iss = issuer[0]
	}
	dur := 3 * time.Minute
	if duration != 0 {
		dur = duration
	}
	return &jwtTokenService{
		secretKey:     []byte(secretKey),
		tokenDuration: dur,
		issuer:        iss,
	}
}

func (s *jwtTokenService) GenerateToken(ctx context.Context, user *User) (string, error) {
	if len(s.secretKey) == 0 {
		return "", errors.New("jwt secret key is empty")
	}
	if user == nil {
		return "", errors.New("user cannot be nil")
	}

	now := time.Now().UTC()
	claims := JWTClaims{
		UserID: user.ID,
		Email:  user.Email,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   user.ID,
			Issuer:    s.issuer,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(s.tokenDuration)),
		},
	}

	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(s.secretKey)
}

func (s *jwtTokenService) ValidateToken(ctx context.Context, tokenString string) (*JWTClaims, error) {
	if len(s.secretKey) == 0 {
		return nil, errors.New("jwt secret key is empty")
	}

	token, err := jwt.ParseWithClaims(tokenString, &JWTClaims{}, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}
		return s.secretKey, nil
	})
	if err != nil {
		return nil, err
	}

	if claims, ok := token.Claims.(*JWTClaims); ok && token.Valid {
		return claims, nil
	}

	return nil, errors.New("invalid token")
}
