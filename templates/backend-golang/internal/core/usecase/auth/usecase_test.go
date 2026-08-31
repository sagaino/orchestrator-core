package auth

import (
	"base-be-golang/internal/core/domain"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"gorm.io/gorm"
)

type mockUserRepository struct {
	createFn      func(ctx context.Context, user *domain.User) error
	findByEmailFn func(ctx context.Context, email string) (*domain.User, error)
	findByIDFn    func(ctx context.Context, id string) (*domain.User, error)
}

func (m *mockUserRepository) Create(ctx context.Context, user *domain.User) error {
	if m.createFn != nil {
		return m.createFn(ctx, user)
	}
	return nil
}

func (m *mockUserRepository) FindByEmail(ctx context.Context, email string) (*domain.User, error) {
	if m.findByEmailFn != nil {
		return m.findByEmailFn(ctx, email)
	}
	return nil, nil
}

func (m *mockUserRepository) FindByID(ctx context.Context, id string) (*domain.User, error) {
	if m.findByIDFn != nil {
		return m.findByIDFn(ctx, id)
	}
	return nil, nil
}

type mockPasswordHasher struct {
	hashPasswordFn    func(password string) (string, error)
	comparePasswordFn func(hashedPassword, password string) error
}

func (m *mockPasswordHasher) HashPassword(password string) (string, error) {
	if m.hashPasswordFn != nil {
		return m.hashPasswordFn(password)
	}
	return "$2a$10$hashed_" + password, nil
}

func (m *mockPasswordHasher) ComparePassword(hashedPassword, password string) error {
	if m.comparePasswordFn != nil {
		return m.comparePasswordFn(hashedPassword, password)
	}
	if hashedPassword == "$2a$10$hashed_"+password {
		return nil
	}
	return errors.New("password mismatch")
}

type mockTokenService struct {
	generateTokenFn func(ctx context.Context, user *domain.User) (string, error)
	validateTokenFn func(ctx context.Context, tokenString string) (*domain.JWTClaims, error)
}

func (m *mockTokenService) GenerateToken(ctx context.Context, user *domain.User) (string, error) {
	if m.generateTokenFn != nil {
		return m.generateTokenFn(ctx, user)
	}
	return "mock-jwt-token-for-" + user.ID, nil
}

func (m *mockTokenService) ValidateToken(ctx context.Context, tokenString string) (*domain.JWTClaims, error) {
	if m.validateTokenFn != nil {
		return m.validateTokenFn(ctx, tokenString)
	}
	return &domain.JWTClaims{UserID: "user-1", Email: "test@example.com"}, nil
}

type mockSessionCache struct {
	setFn    func(ctx context.Context, key string, value interface{}, exp time.Duration) error
	getFn    func(ctx context.Context, key string) (string, error)
	deleteFn func(ctx context.Context, keys ...string) error

	store       map[string]interface{}
	ttls        map[string]time.Duration
	setKeys     []string
	deletedKeys []string
}

func newMockSessionCache() *mockSessionCache {
	return &mockSessionCache{
		store:       make(map[string]interface{}),
		ttls:        make(map[string]time.Duration),
		setKeys:     make([]string, 0),
		deletedKeys: make([]string, 0),
	}
}

func (m *mockSessionCache) Set(ctx context.Context, key string, value interface{}, exp time.Duration) error {
	m.setKeys = append(m.setKeys, key)
	if m.setFn != nil {
		return m.setFn(ctx, key, value, exp)
	}
	if m.store != nil {
		m.store[key] = value
		m.ttls[key] = exp
	}
	return nil
}

func (m *mockSessionCache) Get(ctx context.Context, key string) (string, error) {
	if m.getFn != nil {
		return m.getFn(ctx, key)
	}
	if m.store != nil {
		if val, ok := m.store[key]; ok {
			if strVal, ok := val.(string); ok {
				return strVal, nil
			}
		}
	}
	return "", errors.New("key not found")
}

func (m *mockSessionCache) Delete(ctx context.Context, keys ...string) error {
	m.deletedKeys = append(m.deletedKeys, keys...)
	if m.deleteFn != nil {
		return m.deleteFn(ctx, keys...)
	}
	if m.store != nil {
		for _, k := range keys {
			delete(m.store, k)
			delete(m.ttls, k)
		}
	}
	return nil
}

func TestUsecase_Register_Success(t *testing.T) {
	mockRepo := &mockUserRepository{
		findByEmailFn: func(ctx context.Context, email string) (*domain.User, error) {
			return nil, gorm.ErrRecordNotFound
		},
		createFn: func(ctx context.Context, user *domain.User) error {
			if user.Name != "John Doe" {
				t.Errorf("expected name 'John Doe', got '%s'", user.Name)
			}
			if user.Email != "john@example.com" {
				t.Errorf("expected email 'john@example.com', got '%s'", user.Email)
			}
			if user.Password != "$2a$10$hashed_secret123" {
				t.Errorf("expected hashed password, got '%s'", user.Password)
			}
			if user.ID == "" {
				t.Error("expected generated user ID not to be empty")
			}
			return nil
		},
	}
	mockHasher := &mockPasswordHasher{}
	mockToken := &mockTokenService{}

	uc := NewUsecase(mockRepo, mockHasher, mockToken)
	res, err := uc.Register(context.Background(), RegisterRequest{
		Name:     "John Doe",
		Email:    "john@example.com",
		Password: "secret123",
	})

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res == nil {
		t.Fatal("expected non-nil response")
	}
	if res.Name != "John Doe" {
		t.Errorf("expected name 'John Doe', got '%s'", res.Name)
	}
	if res.Email != "john@example.com" {
		t.Errorf("expected email 'john@example.com', got '%s'", res.Email)
	}
	if res.ID == "" {
		t.Error("expected response ID not to be empty")
	}
}

func TestUsecase_Register_EmptyName(t *testing.T) {
	uc := NewUsecase(&mockUserRepository{}, &mockPasswordHasher{}, &mockTokenService{})
	res, err := uc.Register(context.Background(), RegisterRequest{
		Name:     "   ",
		Email:    "john@example.com",
		Password: "secret123",
	})

	if err == nil {
		t.Fatal("expected error for empty name, got nil")
	}
	if res != nil {
		t.Errorf("expected nil response on error, got %v", res)
	}
}

func TestUsecase_Register_EmptyEmail(t *testing.T) {
	uc := NewUsecase(&mockUserRepository{}, &mockPasswordHasher{}, &mockTokenService{})
	res, err := uc.Register(context.Background(), RegisterRequest{
		Name:     "John Doe",
		Email:    "   ",
		Password: "secret123",
	})

	if err == nil {
		t.Fatal("expected error for empty email, got nil")
	}
	if res != nil {
		t.Errorf("expected nil response on error, got %v", res)
	}
}

func TestUsecase_Register_ShortPassword(t *testing.T) {
	uc := NewUsecase(&mockUserRepository{}, &mockPasswordHasher{}, &mockTokenService{})
	res, err := uc.Register(context.Background(), RegisterRequest{
		Name:     "John Doe",
		Email:    "john@example.com",
		Password: "123",
	})

	if err == nil {
		t.Fatal("expected error for short password, got nil")
	}
	if res != nil {
		t.Errorf("expected nil response on error, got %v", res)
	}
}

func TestUsecase_Register_EmailAlreadyExists(t *testing.T) {
	mockRepo := &mockUserRepository{
		findByEmailFn: func(ctx context.Context, email string) (*domain.User, error) {
			return &domain.User{
				BaseEntity: domain.BaseEntity{ID: "existing-user-id"},
				Email:      "john@example.com",
			}, nil
		},
	}

	uc := NewUsecase(mockRepo, &mockPasswordHasher{}, &mockTokenService{})
	res, err := uc.Register(context.Background(), RegisterRequest{
		Name:     "John Doe",
		Email:    "john@example.com",
		Password: "secret123",
	})

	if err == nil {
		t.Fatal("expected error for duplicate email, got nil")
	}
	if res != nil {
		t.Errorf("expected nil response on error, got %v", res)
	}
}

func TestUsecase_Register_FindByEmailDBError(t *testing.T) {
	mockRepo := &mockUserRepository{
		findByEmailFn: func(ctx context.Context, email string) (*domain.User, error) {
			return nil, errors.New("db error")
		},
	}

	uc := NewUsecase(mockRepo, &mockPasswordHasher{}, &mockTokenService{})
	res, err := uc.Register(context.Background(), RegisterRequest{
		Name:     "John Doe",
		Email:    "john@example.com",
		Password: "secret123",
	})

	if err == nil {
		t.Fatal("expected error on repo find error, got nil")
	}
	if res != nil {
		t.Errorf("expected nil response on error, got %v", res)
	}
}

func TestUsecase_Register_HasherError(t *testing.T) {
	mockRepo := &mockUserRepository{
		findByEmailFn: func(ctx context.Context, email string) (*domain.User, error) {
			return nil, gorm.ErrRecordNotFound
		},
	}
	mockHasher := &mockPasswordHasher{
		hashPasswordFn: func(password string) (string, error) {
			return "", errors.New("hashing failed")
		},
	}

	uc := NewUsecase(mockRepo, mockHasher, &mockTokenService{})
	res, err := uc.Register(context.Background(), RegisterRequest{
		Name:     "John Doe",
		Email:    "john@example.com",
		Password: "secret123",
	})

	if err == nil {
		t.Fatal("expected error on hash failure, got nil")
	}
	if res != nil {
		t.Errorf("expected nil response on error, got %v", res)
	}
}

func TestUsecase_Register_RepoCreateError(t *testing.T) {
	mockRepo := &mockUserRepository{
		findByEmailFn: func(ctx context.Context, email string) (*domain.User, error) {
			return nil, gorm.ErrRecordNotFound
		},
		createFn: func(ctx context.Context, user *domain.User) error {
			return errors.New("failed to insert user")
		},
	}

	uc := NewUsecase(mockRepo, &mockPasswordHasher{}, &mockTokenService{})
	res, err := uc.Register(context.Background(), RegisterRequest{
		Name:     "John Doe",
		Email:    "john@example.com",
		Password: "secret123",
	})

	if err == nil {
		t.Fatal("expected error on create user failure, got nil")
	}
	if res != nil {
		t.Errorf("expected nil response on error, got %v", res)
	}
}

func TestUsecase_Login_Success(t *testing.T) {
	now := time.Now().UTC()
	mockRepo := &mockUserRepository{
		findByEmailFn: func(ctx context.Context, email string) (*domain.User, error) {
			return &domain.User{
				BaseEntity: domain.BaseEntity{
					ID:        "user-123",
					CreatedAt: now,
					UpdatedAt: now,
				},
				Name:     "Jane Doe",
				Email:    "jane@example.com",
				Password: "$2a$10$hashed_secret123",
			}, nil
		},
	}
	mockHasher := &mockPasswordHasher{}
	mockToken := &mockTokenService{
		generateTokenFn: func(ctx context.Context, user *domain.User) (string, error) {
			return "signed-jwt-token-123", nil
		},
	}

	uc := NewUsecase(mockRepo, mockHasher, mockToken)
	res, err := uc.Login(context.Background(), LoginRequest{
		Email:    "jane@example.com",
		Password: "secret123",
	})

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res == nil {
		t.Fatal("expected non-nil response")
	}
	if res.AccessToken != "signed-jwt-token-123" {
		t.Errorf("expected token 'signed-jwt-token-123', got '%s'", res.AccessToken)
	}
	if res.TokenType != "Bearer" {
		t.Errorf("expected token type 'Bearer', got '%s'", res.TokenType)
	}
	if res.User == nil || res.User.ID != "user-123" || res.User.Email != "jane@example.com" {
		t.Errorf("unexpected user data in response: %+v", res.User)
	}
}

func TestUsecase_Login_Success_WithCache_DefaultTTL(t *testing.T) {
	now := time.Now().UTC()
	mockRepo := &mockUserRepository{
		findByEmailFn: func(ctx context.Context, email string) (*domain.User, error) {
			return &domain.User{
				BaseEntity: domain.BaseEntity{
					ID:        "user-123",
					CreatedAt: now,
					UpdatedAt: now,
				},
				Name:     "Jane Doe",
				Email:    "jane@example.com",
				Password: "$2a$10$hashed_secret123",
			}, nil
		},
	}
	mockHasher := &mockPasswordHasher{}
	mockToken := &mockTokenService{
		generateTokenFn: func(ctx context.Context, user *domain.User) (string, error) {
			return "signed-jwt-token-123", nil
		},
	}
	mockCache := newMockSessionCache()

	uc := NewUsecase(mockRepo, mockHasher, mockToken, mockCache)
	res, err := uc.Login(context.Background(), LoginRequest{
		Email:    "jane@example.com",
		Password: "secret123",
	})

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res == nil {
		t.Fatal("expected non-nil response")
	}

	sessionKey := "session:user:user-123"
	cachedVal, exists := mockCache.store[sessionKey]
	if !exists {
		t.Fatalf("expected session key '%s' to be saved in cache", sessionKey)
	}

	cachedStr, ok := cachedVal.(string)
	if !ok {
		t.Fatalf("expected cached value to be string, got %T", cachedVal)
	}

	// Verify TTL default is 3 minutes
	ttl := mockCache.ttls[sessionKey]
	if ttl != 3*time.Minute {
		t.Errorf("expected default TTL of 3 minutes, got %v", ttl)
	}

	// Verify cached content
	if !strings.Contains(cachedStr, `"id":"user-123"`) {
		t.Errorf("expected cached session to contain user ID, got %s", cachedStr)
	}
	if !strings.Contains(cachedStr, `"name":"Jane Doe"`) {
		t.Errorf("expected cached session to contain user name, got %s", cachedStr)
	}
	if !strings.Contains(cachedStr, `"email":"jane@example.com"`) {
		t.Errorf("expected cached session to contain user email, got %s", cachedStr)
	}
}

func TestUsecase_Login_Success_WithCache_CustomTTL_EnvMinutes(t *testing.T) {
	t.Setenv("EXPIRED_TOKEN_JWT_MINUTES", "7")

	now := time.Now().UTC()
	mockRepo := &mockUserRepository{
		findByEmailFn: func(ctx context.Context, email string) (*domain.User, error) {
			return &domain.User{
				BaseEntity: domain.BaseEntity{
					ID:        "user-456",
					CreatedAt: now,
					UpdatedAt: now,
				},
				Name:     "Alice",
				Email:    "alice@example.com",
				Password: "$2a$10$hashed_secret123",
			}, nil
		},
	}
	mockHasher := &mockPasswordHasher{}
	mockToken := &mockTokenService{}
	mockCache := newMockSessionCache()

	uc := NewUsecase(mockRepo, mockHasher, mockToken, mockCache)
	_, err := uc.Login(context.Background(), LoginRequest{
		Email:    "alice@example.com",
		Password: "secret123",
	})

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	sessionKey := "session:user:user-456"
	ttl := mockCache.ttls[sessionKey]
	if ttl != 7*time.Minute {
		t.Errorf("expected TTL from EXPIRED_TOKEN_JWT_MINUTES to be 7 minutes, got %v", ttl)
	}
}

func TestUsecase_Login_Success_WithCache_CustomTTL_EnvExpiredToken(t *testing.T) {
	t.Setenv("EXPIRED_TOKEN_JWT_MINUTES", "")
	t.Setenv("EXPIRED_TOKEN_JWT", "5")

	now := time.Now().UTC()
	mockRepo := &mockUserRepository{
		findByEmailFn: func(ctx context.Context, email string) (*domain.User, error) {
			return &domain.User{
				BaseEntity: domain.BaseEntity{
					ID:        "user-789",
					CreatedAt: now,
					UpdatedAt: now,
				},
				Name:     "Bob",
				Email:    "bob@example.com",
				Password: "$2a$10$hashed_secret123",
			}, nil
		},
	}
	mockHasher := &mockPasswordHasher{}
	mockToken := &mockTokenService{}
	mockCache := newMockSessionCache()

	uc := NewUsecase(mockRepo, mockHasher, mockToken, mockCache)
	_, err := uc.Login(context.Background(), LoginRequest{
		Email:    "bob@example.com",
		Password: "secret123",
	})

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	sessionKey := "session:user:user-789"
	ttl := mockCache.ttls[sessionKey]
	if ttl != 5*time.Minute {
		t.Errorf("expected TTL from EXPIRED_TOKEN_JWT to be 5 minutes, got %v", ttl)
	}
}

func TestUsecase_Login_Success_WithNewUsecaseWithTTL(t *testing.T) {
	now := time.Now().UTC()
	mockRepo := &mockUserRepository{
		findByEmailFn: func(ctx context.Context, email string) (*domain.User, error) {
			return &domain.User{
				BaseEntity: domain.BaseEntity{
					ID:        "user-custom-ttl",
					CreatedAt: now,
					UpdatedAt: now,
				},
				Name:     "Charlie",
				Email:    "charlie@example.com",
				Password: "$2a$10$hashed_secret123",
			}, nil
		},
	}
	mockHasher := &mockPasswordHasher{}
	mockToken := &mockTokenService{}
	mockCache := newMockSessionCache()

	uc := NewUsecaseWithTTL(mockRepo, mockHasher, mockToken, mockCache, 15*time.Minute)
	_, err := uc.Login(context.Background(), LoginRequest{
		Email:    "charlie@example.com",
		Password: "secret123",
	})

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	sessionKey := "session:user:user-custom-ttl"
	ttl := mockCache.ttls[sessionKey]
	if ttl != 15*time.Minute {
		t.Errorf("expected custom TTL of 15 minutes, got %v", ttl)
	}
}

func TestUsecase_Login_CacheSetError(t *testing.T) {
	now := time.Now().UTC()
	mockRepo := &mockUserRepository{
		findByEmailFn: func(ctx context.Context, email string) (*domain.User, error) {
			return &domain.User{
				BaseEntity: domain.BaseEntity{
					ID:        "user-123",
					CreatedAt: now,
					UpdatedAt: now,
				},
				Name:     "Jane Doe",
				Email:    "jane@example.com",
				Password: "$2a$10$hashed_secret123",
			}, nil
		},
	}
	mockHasher := &mockPasswordHasher{}
	mockToken := &mockTokenService{}
	mockCache := &mockSessionCache{
		setFn: func(ctx context.Context, key string, value interface{}, exp time.Duration) error {
			return errors.New("redis connection refused")
		},
	}

	uc := NewUsecase(mockRepo, mockHasher, mockToken, mockCache)
	res, err := uc.Login(context.Background(), LoginRequest{
		Email:    "jane@example.com",
		Password: "secret123",
	})

	if err == nil {
		t.Fatal("expected error on cache set failure, got nil")
	}
	if res != nil {
		t.Errorf("expected nil response on error, got %v", res)
	}
}

func TestUsecase_Login_EmptyEmail(t *testing.T) {
	uc := NewUsecase(&mockUserRepository{}, &mockPasswordHasher{}, &mockTokenService{})
	res, err := uc.Login(context.Background(), LoginRequest{
		Email:    "   ",
		Password: "secret123",
	})

	if err == nil {
		t.Fatal("expected error for empty email, got nil")
	}
	if res != nil {
		t.Errorf("expected nil response on error, got %v", res)
	}
}

func TestUsecase_Login_EmptyPassword(t *testing.T) {
	uc := NewUsecase(&mockUserRepository{}, &mockPasswordHasher{}, &mockTokenService{})
	res, err := uc.Login(context.Background(), LoginRequest{
		Email:    "jane@example.com",
		Password: "",
	})

	if err == nil {
		t.Fatal("expected error for empty password, got nil")
	}
	if res != nil {
		t.Errorf("expected nil response on error, got %v", res)
	}
}

func TestUsecase_Login_UserNotFound(t *testing.T) {
	mockRepo := &mockUserRepository{
		findByEmailFn: func(ctx context.Context, email string) (*domain.User, error) {
			return nil, gorm.ErrRecordNotFound
		},
	}

	uc := NewUsecase(mockRepo, &mockPasswordHasher{}, &mockTokenService{})
	res, err := uc.Login(context.Background(), LoginRequest{
		Email:    "unknown@example.com",
		Password: "secret123",
	})

	if err == nil {
		t.Fatal("expected error for unknown user, got nil")
	}
	if res != nil {
		t.Errorf("expected nil response on error, got %v", res)
	}
}

func TestUsecase_Login_NilUserFound(t *testing.T) {
	mockRepo := &mockUserRepository{
		findByEmailFn: func(ctx context.Context, email string) (*domain.User, error) {
			return nil, nil
		},
	}

	uc := NewUsecase(mockRepo, &mockPasswordHasher{}, &mockTokenService{})
	res, err := uc.Login(context.Background(), LoginRequest{
		Email:    "user@example.com",
		Password: "secret123",
	})

	if err == nil {
		t.Fatal("expected error for nil user, got nil")
	}
	if res != nil {
		t.Errorf("expected nil response on error, got %v", res)
	}
}

func TestUsecase_Login_FindByEmailDBError(t *testing.T) {
	mockRepo := &mockUserRepository{
		findByEmailFn: func(ctx context.Context, email string) (*domain.User, error) {
			return nil, errors.New("database connection lost")
		},
	}

	uc := NewUsecase(mockRepo, &mockPasswordHasher{}, &mockTokenService{})
	res, err := uc.Login(context.Background(), LoginRequest{
		Email:    "user@example.com",
		Password: "secret123",
	})

	if err == nil {
		t.Fatal("expected error on DB failure, got nil")
	}
	if res != nil {
		t.Errorf("expected nil response on error, got %v", res)
	}
}

func TestUsecase_Login_InvalidPassword(t *testing.T) {
	mockRepo := &mockUserRepository{
		findByEmailFn: func(ctx context.Context, email string) (*domain.User, error) {
			return &domain.User{
				BaseEntity: domain.BaseEntity{ID: "user-1"},
				Email:      "jane@example.com",
				Password:   "$2a$10$hashed_correctpwd",
			}, nil
		},
	}
	mockHasher := &mockPasswordHasher{
		comparePasswordFn: func(hashedPassword, password string) error {
			return errors.New("password mismatch")
		},
	}

	uc := NewUsecase(mockRepo, mockHasher, &mockTokenService{})
	res, err := uc.Login(context.Background(), LoginRequest{
		Email:    "jane@example.com",
		Password: "wrongpassword",
	})

	if err == nil {
		t.Fatal("expected error on wrong password, got nil")
	}
	if res != nil {
		t.Errorf("expected nil response on error, got %v", res)
	}
}

func TestUsecase_Login_TokenGenerationError(t *testing.T) {
	mockRepo := &mockUserRepository{
		findByEmailFn: func(ctx context.Context, email string) (*domain.User, error) {
			return &domain.User{
				BaseEntity: domain.BaseEntity{ID: "user-1"},
				Email:      "jane@example.com",
				Password:   "$2a$10$hashed_secret123",
			}, nil
		},
	}
	mockHasher := &mockPasswordHasher{}
	mockToken := &mockTokenService{
		generateTokenFn: func(ctx context.Context, user *domain.User) (string, error) {
			return "", errors.New("signing key failure")
		},
	}

	uc := NewUsecase(mockRepo, mockHasher, mockToken)
	res, err := uc.Login(context.Background(), LoginRequest{
		Email:    "jane@example.com",
		Password: "secret123",
	})

	if err == nil {
		t.Fatal("expected error on token signing failure, got nil")
	}
	if res != nil {
		t.Errorf("expected nil response on error, got %v", res)
	}
}

func TestUsecase_Login_NilTokenService(t *testing.T) {
	mockRepo := &mockUserRepository{
		findByEmailFn: func(ctx context.Context, email string) (*domain.User, error) {
			return &domain.User{
				BaseEntity: domain.BaseEntity{ID: "user-1"},
				Email:      "jane@example.com",
				Password:   "$2a$10$hashed_secret123",
			}, nil
		},
	}

	uc := NewUsecase(mockRepo, &mockPasswordHasher{}, nil)
	res, err := uc.Login(context.Background(), LoginRequest{
		Email:    "jane@example.com",
		Password: "secret123",
	})

	if err == nil {
		t.Fatal("expected error when token service is nil, got nil")
	}
	if res != nil {
		t.Errorf("expected nil response on error, got %v", res)
	}
}

func TestUsecase_Logout_Success(t *testing.T) {
	mockCache := newMockSessionCache()
	mockCache.store["session:user:user-123"] = `{"id":"user-123"}`

	uc := NewUsecase(&mockUserRepository{}, &mockPasswordHasher{}, &mockTokenService{}, mockCache)
	err := uc.Logout(context.Background(), "user-123")

	if err != nil {
		t.Fatalf("unexpected error on logout: %v", err)
	}

	if _, exists := mockCache.store["session:user:user-123"]; exists {
		t.Error("expected session:user:user-123 to be deleted from cache")
	}
}

func TestUsecase_Logout_EmptyUserID(t *testing.T) {
	mockCache := newMockSessionCache()
	uc := NewUsecase(&mockUserRepository{}, &mockPasswordHasher{}, &mockTokenService{}, mockCache)

	err := uc.Logout(context.Background(), "")
	if err == nil {
		t.Fatal("expected error for empty user ID on logout, got nil")
	}
}

func TestUsecase_Logout_WhitespaceUserID(t *testing.T) {
	mockCache := newMockSessionCache()
	uc := NewUsecase(&mockUserRepository{}, &mockPasswordHasher{}, &mockTokenService{}, mockCache)

	err := uc.Logout(context.Background(), "   ")
	if err == nil {
		t.Fatal("expected error for whitespace user ID on logout, got nil")
	}
}

func TestUsecase_Logout_CacheDeleteError(t *testing.T) {
	mockCache := &mockSessionCache{
		deleteFn: func(ctx context.Context, keys ...string) error {
			return errors.New("redis connection timeout")
		},
	}
	uc := NewUsecase(&mockUserRepository{}, &mockPasswordHasher{}, &mockTokenService{}, mockCache)

	err := uc.Logout(context.Background(), "user-123")
	if err == nil {
		t.Fatal("expected error when cache delete fails, got nil")
	}
	if !strings.Contains(err.Error(), "Failed to delete user session") {
		t.Errorf("expected error message to contain 'Failed to delete user session', got '%s'", err.Error())
	}
}

func TestUsecase_Logout_NilCache(t *testing.T) {
	uc := NewUsecase(&mockUserRepository{}, &mockPasswordHasher{}, &mockTokenService{})

	err := uc.Logout(context.Background(), "user-123")
	if err != nil {
		t.Fatalf("expected nil error when cache is nil, got %v", err)
	}
}

func TestUsecase_Login_SessionCache_SnapshotUnmarshal(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	mockRepo := &mockUserRepository{
		findByEmailFn: func(ctx context.Context, email string) (*domain.User, error) {
			return &domain.User{
				BaseEntity: domain.BaseEntity{
					ID:        "user-snapshot-test",
					CreatedAt: now,
					UpdatedAt: now,
				},
				Name:     "Snapshot User",
				Email:    "snapshot@example.com",
				Password: "$2a$10$hashed_secret123",
			}, nil
		},
	}
	mockHasher := &mockPasswordHasher{}
	mockToken := &mockTokenService{}
	mockCache := newMockSessionCache()

	uc := NewUsecase(mockRepo, mockHasher, mockToken, mockCache)
	res, err := uc.Login(context.Background(), LoginRequest{
		Email:    "snapshot@example.com",
		Password: "secret123",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res == nil {
		t.Fatal("expected non-nil login response")
	}

	expectedKey := "session:user:user-snapshot-test"
	if len(mockCache.setKeys) < 1 || mockCache.setKeys[0] != expectedKey {
		t.Fatalf("expected setKeys to contain '%s', got %v", expectedKey, mockCache.setKeys)
	}

	expectedRefreshKey := "refresh:token:" + res.RefreshToken
	if len(mockCache.setKeys) != 2 || mockCache.setKeys[1] != expectedRefreshKey {
		t.Fatalf("expected setKeys second element to be '%s', got %v", expectedRefreshKey, mockCache.setKeys)
	}

	rawSession, ok := mockCache.store[expectedKey].(string)
	if !ok {
		t.Fatalf("expected cached session to be string, got %T", mockCache.store[expectedKey])
	}

	var snapshot UserSessionSnapshot
	if err := json.Unmarshal([]byte(rawSession), &snapshot); err != nil {
		t.Fatalf("failed to unmarshal cached session snapshot: %v", err)
	}

	if snapshot.ID != "user-snapshot-test" {
		t.Errorf("expected snapshot ID 'user-snapshot-test', got '%s'", snapshot.ID)
	}
	if snapshot.Name != "Snapshot User" {
		t.Errorf("expected snapshot Name 'Snapshot User', got '%s'", snapshot.Name)
	}
	if snapshot.Email != "snapshot@example.com" {
		t.Errorf("expected snapshot Email 'snapshot@example.com', got '%s'", snapshot.Email)
	}
	if !snapshot.CreatedAt.Equal(now) {
		t.Errorf("expected snapshot CreatedAt %v, got %v", now, snapshot.CreatedAt)
	}
	if !snapshot.UpdatedAt.Equal(now) {
		t.Errorf("expected snapshot UpdatedAt %v, got %v", now, snapshot.UpdatedAt)
	}
}

func TestUsecase_Login_SessionCache_KeyAndTTLAssertions(t *testing.T) {
	now := time.Now().UTC()
	tests := []struct {
		name        string
		userID      string
		customTTL   time.Duration
		envMinutes  string
		expectedTTL time.Duration
		expectedKey string
	}{
		{
			name:        "default TTL 3 minutes",
			userID:      "usr-default-ttl",
			customTTL:   0,
			expectedTTL: 3 * time.Minute,
			expectedKey: "session:user:usr-default-ttl",
		},
		{
			name:        "custom TTL 20 minutes via constructor",
			userID:      "usr-custom-20m",
			customTTL:   20 * time.Minute,
			expectedTTL: 20 * time.Minute,
			expectedKey: "session:user:usr-custom-20m",
		},
		{
			name:        "env EXPIRED_TOKEN_JWT_MINUTES override",
			userID:      "usr-env-12m",
			envMinutes:  "12",
			expectedTTL: 12 * time.Minute,
			expectedKey: "session:user:usr-env-12m",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if tt.envMinutes != "" {
				t.Setenv("EXPIRED_TOKEN_JWT_MINUTES", tt.envMinutes)
			} else {
				t.Setenv("EXPIRED_TOKEN_JWT_MINUTES", "")
				t.Setenv("EXPIRED_TOKEN_JWT", "")
			}

			mockRepo := &mockUserRepository{
				findByEmailFn: func(ctx context.Context, email string) (*domain.User, error) {
					return &domain.User{
						BaseEntity: domain.BaseEntity{
							ID:        tt.userID,
							CreatedAt: now,
							UpdatedAt: now,
						},
						Name:     "TTL User",
						Email:    "ttl@example.com",
						Password: "$2a$10$hashed_secret123",
					}, nil
				},
			}
			mockHasher := &mockPasswordHasher{}
			mockToken := &mockTokenService{}
			mockCache := newMockSessionCache()

			var uc SessionUsecase
			if tt.customTTL > 0 {
				uc = NewUsecaseWithTTL(mockRepo, mockHasher, mockToken, mockCache, tt.customTTL)
			} else {
				uc = NewUsecase(mockRepo, mockHasher, mockToken, mockCache)
			}

			_, err := uc.Login(context.Background(), LoginRequest{
				Email:    "ttl@example.com",
				Password: "secret123",
			})
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}

			if _, exists := mockCache.store[tt.expectedKey]; !exists {
				t.Fatalf("expected key '%s' to exist in cache", tt.expectedKey)
			}
			actualTTL := mockCache.ttls[tt.expectedKey]
			if actualTTL != tt.expectedTTL {
				t.Errorf("expected TTL %v, got %v", tt.expectedTTL, actualTTL)
			}
		})
	}
}

func TestUsecase_Logout_TableDriven(t *testing.T) {
	tests := []struct {
		name         string
		userID       string
		initialCache map[string]interface{}
		deleteFn     func(ctx context.Context, keys ...string) error
		nilCache     bool
		wantErr      bool
		errMsg       string
		wantDeleted  string
	}{
		{
			name:   "success delete active session",
			userID: "user-100",
			initialCache: map[string]interface{}{
				"session:user:user-100": `{"id":"user-100"}`,
			},
			wantErr:     false,
			wantDeleted: "session:user:user-100",
		},
		{
			name:   "success delete session with whitespace around id",
			userID: "  user-200  ",
			initialCache: map[string]interface{}{
				"session:user:user-200": `{"id":"user-200"}`,
			},
			wantErr:     false,
			wantDeleted: "session:user:user-200",
		},
		{
			name:    "fail empty user id",
			userID:  "",
			wantErr: true,
			errMsg:  "User ID is required",
		},
		{
			name:    "fail whitespace only user id",
			userID:  "   ",
			wantErr: true,
			errMsg:  "User ID is required",
		},
		{
			name:   "fail cache delete error",
			userID: "user-300",
			deleteFn: func(ctx context.Context, keys ...string) error {
				return errors.New("redis timeout")
			},
			wantErr: true,
			errMsg:  "Failed to delete user session",
		},
		{
			name:     "success with nil cache (no-op)",
			userID:   "user-400",
			nilCache: true,
			wantErr:  false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var cache SessionCache
			var mockCache *mockSessionCache
			if !tt.nilCache {
				mockCache = newMockSessionCache()
				if tt.initialCache != nil {
					for k, v := range tt.initialCache {
						mockCache.store[k] = v
					}
				}
				if tt.deleteFn != nil {
					mockCache.deleteFn = tt.deleteFn
				}
				cache = mockCache
			}

			uc := NewUsecase(&mockUserRepository{}, &mockPasswordHasher{}, &mockTokenService{}, cache)
			err := uc.Logout(context.Background(), tt.userID)

			if (err != nil) != tt.wantErr {
				t.Fatalf("expected error: %v, got: %v", tt.wantErr, err)
			}
			if tt.wantErr && tt.errMsg != "" {
				if !strings.Contains(err.Error(), tt.errMsg) {
					t.Errorf("expected error containing '%s', got '%s'", tt.errMsg, err.Error())
				}
			}
			if !tt.wantErr && tt.wantDeleted != "" && mockCache != nil {
				if len(mockCache.deletedKeys) == 0 || mockCache.deletedKeys[0] != tt.wantDeleted {
					t.Errorf("expected deleted key '%s', got %v", tt.wantDeleted, mockCache.deletedKeys)
				}
				if _, exists := mockCache.store[tt.wantDeleted]; exists {
					t.Errorf("expected key '%s' to be removed from store", tt.wantDeleted)
				}
			}
		})
	}
}

func TestUsecase_Logout_WithNewUsecaseWithTTL(t *testing.T) {
	mockCache := newMockSessionCache()
	mockCache.store["session:user:user-ttl-logout"] = `{"id":"user-ttl-logout"}`

	uc := NewUsecaseWithTTL(&mockUserRepository{}, &mockPasswordHasher{}, &mockTokenService{}, mockCache, 10*time.Minute)
	err := uc.Logout(context.Background(), "user-ttl-logout")
	if err != nil {
		t.Fatalf("unexpected error on logout: %v", err)
	}

	if len(mockCache.deletedKeys) != 1 || mockCache.deletedKeys[0] != "session:user:user-ttl-logout" {
		t.Errorf("expected deleted key 'session:user:user-ttl-logout', got %v", mockCache.deletedKeys)
	}
	if _, exists := mockCache.store["session:user:user-ttl-logout"]; exists {
		t.Error("expected key to be removed from cache store")
	}
}


func TestDomain_BcryptPasswordHasher(t *testing.T) {
	hasher := domain.NewBcryptPasswordHasher(4)
	rawPassword := "mySecretPass123"

	hashed, err := hasher.HashPassword(rawPassword)
	if err != nil {
		t.Fatalf("unexpected error hashing password: %v", err)
	}
	if hashed == "" || hashed == rawPassword {
		t.Fatal("expected valid hashed password")
	}

	err = hasher.ComparePassword(hashed, rawPassword)
	if err != nil {
		t.Fatalf("expected password match, got %v", err)
	}

	err = hasher.ComparePassword(hashed, "wrongPassword")
	if err == nil {
		t.Fatal("expected error comparing wrong password, got nil")
	}
}

func TestDomain_JWTTokenService(t *testing.T) {
	secretKey := "super-secret-key-1234567890"
	tokenService := domain.NewJWTTokenService(secretKey, 3)

	user := &domain.User{
		BaseEntity: domain.BaseEntity{ID: "test-user-id"},
		Name:       "Test User",
		Email:      "test@example.com",
	}

	tokenStr, err := tokenService.GenerateToken(context.Background(), user)
	if err != nil {
		t.Fatalf("unexpected error generating token: %v", err)
	}
	if tokenStr == "" {
		t.Fatal("expected non-empty token string")
	}

	claims, err := tokenService.ValidateToken(context.Background(), tokenStr)
	if err != nil {
		t.Fatalf("unexpected error validating token: %v", err)
	}
	if claims.UserID != "test-user-id" {
		t.Errorf("expected claims UserID 'test-user-id', got '%s'", claims.UserID)
	}
	if claims.Email != "test@example.com" {
		t.Errorf("expected claims Email 'test@example.com', got '%s'", claims.Email)
	}

	// Verify expiration duration is 3 minutes
	if claims.ExpiresAt == nil || claims.IssuedAt == nil {
		t.Fatal("expected non-nil ExpiresAt and IssuedAt")
	}
	diff := claims.ExpiresAt.Time.Sub(claims.IssuedAt.Time)
	if diff != 3*time.Minute {
		t.Errorf("expected token duration of 3 minutes, got %v", diff)
	}

	// Validate invalid token
	_, err = tokenService.ValidateToken(context.Background(), "invalid.token.string")
	if err == nil {
		t.Fatal("expected error validating invalid token, got nil")
	}

	// Test nil user
	_, err = tokenService.GenerateToken(context.Background(), nil)
	if err == nil {
		t.Fatal("expected error generating token for nil user, got nil")
	}
}

func TestDomain_JWTTokenService_DefaultExpiration(t *testing.T) {
	secretKey := "super-secret-key-1234567890"
	// 0 should default to 3 minutes
	tokenService := domain.NewJWTTokenService(secretKey, 0)

	user := &domain.User{
		BaseEntity: domain.BaseEntity{ID: "test-user-id-2"},
		Name:       "Test User 2",
		Email:      "test2@example.com",
	}

	tokenStr, err := tokenService.GenerateToken(context.Background(), user)
	if err != nil {
		t.Fatalf("unexpected error generating token: %v", err)
	}

	claims, err := tokenService.ValidateToken(context.Background(), tokenStr)
	if err != nil {
		t.Fatalf("unexpected error validating token: %v", err)
	}

	if claims.ExpiresAt == nil || claims.IssuedAt == nil {
		t.Fatal("expected non-nil ExpiresAt and IssuedAt")
	}
	diff := claims.ExpiresAt.Time.Sub(claims.IssuedAt.Time)
	if diff != 3*time.Minute {
		t.Errorf("expected default token duration of 3 minutes, got %v", diff)
	}
}

func TestDomain_JWTTokenService_CustomDuration(t *testing.T) {
	secretKey := "super-secret-key-1234567890"
	tokenService := domain.NewJWTTokenServiceWithDuration(secretKey, 10*time.Minute, "custom-issuer")

	user := &domain.User{
		BaseEntity: domain.BaseEntity{ID: "test-user-id-3"},
		Name:       "Test User 3",
		Email:      "test3@example.com",
	}

	tokenStr, err := tokenService.GenerateToken(context.Background(), user)
	if err != nil {
		t.Fatalf("unexpected error generating token: %v", err)
	}

	claims, err := tokenService.ValidateToken(context.Background(), tokenStr)
	if err != nil {
		t.Fatalf("unexpected error validating token: %v", err)
	}

	if claims.Issuer != "custom-issuer" {
		t.Errorf("expected issuer 'custom-issuer', got '%s'", claims.Issuer)
	}
	diff := claims.ExpiresAt.Time.Sub(claims.IssuedAt.Time)
	if diff != 10*time.Minute {
		t.Errorf("expected custom token duration of 10 minutes, got %v", diff)
	}
}

func TestDomain_JWTTokenService_ExpiredToken(t *testing.T) {
	secretKey := "super-secret-key-1234567890"
	tokenService := domain.NewJWTTokenServiceWithDuration(secretKey, -1*time.Minute)

	user := &domain.User{
		BaseEntity: domain.BaseEntity{ID: "test-user-id-4"},
		Name:       "Test User 4",
		Email:      "test4@example.com",
	}

	tokenStr, err := tokenService.GenerateToken(context.Background(), user)
	if err != nil {
		t.Fatalf("unexpected error generating token: %v", err)
	}

	_, err = tokenService.ValidateToken(context.Background(), tokenStr)
	if err == nil {
		t.Fatal("expected error validating expired token, got nil")
	}
}

func TestDomain_JWTTokenService_EmptySecretKey(t *testing.T) {
	tokenService := domain.NewJWTTokenService("", 3)
	user := &domain.User{
		BaseEntity: domain.BaseEntity{ID: "test-user-id-5"},
		Email:      "test5@example.com",
	}

	_, err := tokenService.GenerateToken(context.Background(), user)
	if err == nil {
		t.Fatal("expected error generating token with empty secret, got nil")
	}

	_, err = tokenService.ValidateToken(context.Background(), "some-token")
	if err == nil {
		t.Fatal("expected error validating token with empty secret, got nil")
	}
}

func TestUserSessionSnapshot_UnmarshalJSON(t *testing.T) {
	// 1. Valid snapshot with ID
	var snap1 UserSessionSnapshot
	if err := json.Unmarshal([]byte(`{"id":"u-100","name":"Alice","email":"alice@example.com"}`), &snap1); err != nil {
		t.Fatalf("expected nil error for valid snapshot, got %v", err)
	}
	if snap1.ID != "u-100" || snap1.Name != "Alice" || snap1.Email != "alice@example.com" {
		t.Errorf("unexpected unmarshaled snapshot data: %+v", snap1)
	}

	// 2. Arbitrary JSON without identifier fields should return error to allow fallback
	var snap2 UserSessionSnapshot
	if err := json.Unmarshal([]byte(`{"custom_role":"manager","permissions":["read","write"]}`), &snap2); err == nil {
		t.Fatal("expected error for JSON without identifier fields, got nil")
	}

	// 3. Invalid JSON syntax should return error
	var snap3 UserSessionSnapshot
	if err := json.Unmarshal([]byte(`{invalid-json`), &snap3); err == nil {
		t.Fatal("expected error for invalid JSON syntax, got nil")
	}
}

func TestUsecase_Login_ReturnsRefreshToken_AndStoresInCache(t *testing.T) {
	now := time.Now().UTC()
	mockRepo := &mockUserRepository{
		findByEmailFn: func(ctx context.Context, email string) (*domain.User, error) {
			return &domain.User{
				BaseEntity: domain.BaseEntity{
					ID:        "user-rt-1",
					CreatedAt: now,
					UpdatedAt: now,
				},
				Name:     "RT User",
				Email:    "rt@example.com",
				Password: "$2a$10$hashed_secret123",
			}, nil
		},
	}
	mockHasher := &mockPasswordHasher{}
	mockToken := &mockTokenService{
		generateTokenFn: func(ctx context.Context, user *domain.User) (string, error) {
			return "access-token-123", nil
		},
	}
	mockCache := newMockSessionCache()

	uc := NewUsecase(mockRepo, mockHasher, mockToken, mockCache)
	res, err := uc.Login(context.Background(), LoginRequest{
		Email:    "rt@example.com",
		Password: "secret123",
	})
	if err != nil {
		t.Fatalf("unexpected error on login: %v", err)
	}
	if res == nil {
		t.Fatal("expected non-nil login response")
	}

	if res.AccessToken != "access-token-123" {
		t.Errorf("expected access token 'access-token-123', got '%s'", res.AccessToken)
	}
	if strings.TrimSpace(res.RefreshToken) == "" {
		t.Fatal("expected non-empty refresh token in response")
	}
	if res.TokenType != "Bearer" {
		t.Errorf("expected tokenType 'Bearer', got '%s'", res.TokenType)
	}

	// Verify session key
	sessionKey := "session:user:user-rt-1"
	if _, exists := mockCache.store[sessionKey]; !exists {
		t.Fatalf("expected session key '%s' in cache", sessionKey)
	}

	// Verify refresh token key
	refreshKey := "refresh:token:" + res.RefreshToken
	rawRefresh, exists := mockCache.store[refreshKey]
	if !exists {
		t.Fatalf("expected refresh token key '%s' in cache", refreshKey)
	}

	// Verify default 7-day TTL
	refreshTTL := mockCache.ttls[refreshKey]
	if refreshTTL != 7*24*time.Hour {
		t.Errorf("expected default refresh token TTL of 7 days (168h), got %v", refreshTTL)
	}

	// Verify snapshot content in refresh token key
	var snapshot UserSessionSnapshot
	if err := json.Unmarshal([]byte(rawRefresh.(string)), &snapshot); err != nil {
		t.Fatalf("failed to unmarshal refresh token snapshot: %v", err)
	}
	if snapshot.ID != "user-rt-1" || snapshot.Email != "rt@example.com" {
		t.Errorf("unexpected snapshot data: %+v", snapshot)
	}
	if snapshot.RefreshToken != res.RefreshToken {
		t.Errorf("expected snapshot RefreshToken '%s', got '%s'", res.RefreshToken, snapshot.RefreshToken)
	}
}

func TestUsecase_Login_RefreshTokenTTL_FromEnv(t *testing.T) {
	t.Setenv("REFRESH_TOKEN_TTL_DAYS", "14")

	now := time.Now().UTC()
	mockRepo := &mockUserRepository{
		findByEmailFn: func(ctx context.Context, email string) (*domain.User, error) {
			return &domain.User{
				BaseEntity: domain.BaseEntity{
					ID:        "user-env-rt",
					CreatedAt: now,
					UpdatedAt: now,
				},
				Name:     "Env RT User",
				Email:    "envrt@example.com",
				Password: "$2a$10$hashed_secret123",
			}, nil
		},
	}
	mockHasher := &mockPasswordHasher{}
	mockToken := &mockTokenService{}
	mockCache := newMockSessionCache()

	uc := NewUsecase(mockRepo, mockHasher, mockToken, mockCache)
	res, err := uc.Login(context.Background(), LoginRequest{
		Email:    "envrt@example.com",
		Password: "secret123",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	refreshKey := "refresh:token:" + res.RefreshToken
	refreshTTL := mockCache.ttls[refreshKey]
	if refreshTTL != 14*24*time.Hour {
		t.Errorf("expected refresh TTL of 14 days, got %v", refreshTTL)
	}
}

func TestUsecase_RefreshToken_Success_RTR(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	oldRefreshToken := "old-refresh-token-uuid-123"

	mockCache := newMockSessionCache()
	oldSnapshot := UserSessionSnapshot{
		ID:           "user-rtr-100",
		Name:         "RTR User",
		Email:        "rtr@example.com",
		RefreshToken: oldRefreshToken,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	snapshotBytes, _ := json.Marshal(oldSnapshot)

	oldRefreshKey := "refresh:token:" + oldRefreshToken
	oldSessionKey := "session:user:user-rtr-100"
	mockCache.store[oldRefreshKey] = string(snapshotBytes)
	mockCache.store[oldSessionKey] = string(snapshotBytes)

	mockToken := &mockTokenService{
		generateTokenFn: func(ctx context.Context, user *domain.User) (string, error) {
			if user.ID != "user-rtr-100" || user.Email != "rtr@example.com" {
				return "", errors.New("user mismatch in token generator")
			}
			return "new-access-token-456", nil
		},
	}

	uc := NewUsecase(&mockUserRepository{}, &mockPasswordHasher{}, mockToken, mockCache)
	res, err := uc.RefreshToken(context.Background(), RefreshTokenRequest{
		RefreshToken: oldRefreshToken,
	})
	if err != nil {
		t.Fatalf("unexpected error on RefreshToken: %v", err)
	}
	if res == nil {
		t.Fatal("expected non-nil RefreshTokenResponse")
	}

	// 1. Verify new tokens in response
	if res.AccessToken != "new-access-token-456" {
		t.Errorf("expected accessToken 'new-access-token-456', got '%s'", res.AccessToken)
	}
	if res.RefreshToken == "" || res.RefreshToken == oldRefreshToken {
		t.Errorf("expected new unique refreshToken, got '%s'", res.RefreshToken)
	}
	if res.TokenType != "Bearer" {
		t.Errorf("expected tokenType 'Bearer', got '%s'", res.TokenType)
	}

	// 2. Verify old refresh token is DELETED from Redis (RTR)
	if _, exists := mockCache.store[oldRefreshKey]; exists {
		t.Errorf("expected old refresh key '%s' to be deleted from cache store", oldRefreshKey)
	}

	// 3. Verify new refresh token is SAVED in Redis with 7-day sliding TTL
	newRefreshKey := "refresh:token:" + res.RefreshToken
	newRefreshVal, exists := mockCache.store[newRefreshKey]
	if !exists {
		t.Fatalf("expected new refresh key '%s' to be stored in cache", newRefreshKey)
	}
	if mockCache.ttls[newRefreshKey] != 7*24*time.Hour {
		t.Errorf("expected 7-day sliding TTL on new refresh token, got %v", mockCache.ttls[newRefreshKey])
	}

	// 4. Verify updated snapshot in new refresh token
	var newRefreshSnapshot UserSessionSnapshot
	if err := json.Unmarshal([]byte(newRefreshVal.(string)), &newRefreshSnapshot); err != nil {
		t.Fatalf("failed to unmarshal new refresh snapshot: %v", err)
	}
	if newRefreshSnapshot.ID != "user-rtr-100" || newRefreshSnapshot.RefreshToken != res.RefreshToken {
		t.Errorf("unexpected data in new refresh snapshot: %+v", newRefreshSnapshot)
	}

	// 5. Verify user session key is updated in Redis with sliding session TTL
	updatedSessionVal, exists := mockCache.store[oldSessionKey]
	if !exists {
		t.Fatalf("expected user session key '%s' to be present in cache", oldSessionKey)
	}
	if mockCache.ttls[oldSessionKey] != 3*time.Minute {
		t.Errorf("expected default 3-minute session TTL on updated session, got %v", mockCache.ttls[oldSessionKey])
	}

	var updatedSessionSnapshot UserSessionSnapshot
	if err := json.Unmarshal([]byte(updatedSessionVal.(string)), &updatedSessionSnapshot); err != nil {
		t.Fatalf("failed to unmarshal updated session snapshot: %v", err)
	}
	if updatedSessionSnapshot.RefreshToken != res.RefreshToken {
		t.Errorf("expected session snapshot RefreshToken to be updated to '%s', got '%s'", res.RefreshToken, updatedSessionSnapshot.RefreshToken)
	}
}

func TestUsecase_RefreshToken_CustomTTL_Sliding(t *testing.T) {
	now := time.Now().UTC()
	initialToken := "custom-ttl-rt-token"
	mockCache := newMockSessionCache()

	snap := UserSessionSnapshot{
		ID:           "user-custom-rtr",
		Name:         "Custom User",
		Email:        "custom@example.com",
		RefreshToken: initialToken,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	snapBytes, _ := json.Marshal(snap)
	mockCache.store["refresh:token:"+initialToken] = string(snapBytes)
	mockCache.store["session:user:user-custom-rtr"] = string(snapBytes)

	mockToken := &mockTokenService{}
	customSessionTTL := 15 * time.Minute
	customRefreshTTL := 10 * 24 * time.Hour

	uc := NewUsecaseWithTTL(&mockUserRepository{}, &mockPasswordHasher{}, mockToken, mockCache, customSessionTTL, customRefreshTTL)
	res, err := uc.RefreshToken(context.Background(), RefreshTokenRequest{
		RefreshToken: initialToken,
	})
	if err != nil {
		t.Fatalf("unexpected error on RefreshToken: %v", err)
	}

	newRefreshKey := "refresh:token:" + res.RefreshToken
	if mockCache.ttls[newRefreshKey] != customRefreshTTL {
		t.Errorf("expected custom refresh TTL %v, got %v", customRefreshTTL, mockCache.ttls[newRefreshKey])
	}

	sessionKey := "session:user:user-custom-rtr"
	if mockCache.ttls[sessionKey] != customSessionTTL {
		t.Errorf("expected custom session TTL %v, got %v", customSessionTTL, mockCache.ttls[sessionKey])
	}
}

func TestUsecase_RefreshToken_InvalidOrExpired_Rejection(t *testing.T) {
	tests := []struct {
		name         string
		reqToken     string
		initialCache map[string]interface{}
		getFn        func(ctx context.Context, key string) (string, error)
		nilCache     bool
		errMsg       string
	}{
		{
			name:     "empty refresh token",
			reqToken: "",
			errMsg:   "Invalid or expired refresh token",
		},
		{
			name:     "whitespace refresh token",
			reqToken: "    ",
			errMsg:   "Invalid or expired refresh token",
		},
		{
			name:         "token not found in cache (expired)",
			reqToken:     "non-existent-token-uuid",
			initialCache: map[string]interface{}{},
			errMsg:       "Invalid or expired refresh token",
		},
		{
			name:     "corrupted JSON in cache",
			reqToken: "corrupted-token",
			initialCache: map[string]interface{}{
				"refresh:token:corrupted-token": "{invalid-json-data",
			},
			errMsg: "Invalid or expired refresh token",
		},
		{
			name:     "JSON without user ID in cache",
			reqToken: "no-id-token",
			initialCache: map[string]interface{}{
				"refresh:token:no-id-token": `{"name":"Ghost","email":"ghost@example.com"}`,
			},
			errMsg: "Invalid or expired refresh token",
		},
		{
			name:     "cache Get returns error",
			reqToken: "redis-err-token",
			getFn: func(ctx context.Context, key string) (string, error) {
				return "", errors.New("redis connection refused")
			},
			errMsg: "Invalid or expired refresh token",
		},
		{
			name:     "nil session cache",
			reqToken: "some-token",
			nilCache: true,
			errMsg:   "Invalid or expired refresh token",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var cache SessionCache
			if !tt.nilCache {
				mockCache := newMockSessionCache()
				if tt.initialCache != nil {
					for k, v := range tt.initialCache {
						mockCache.store[k] = v
					}
				}
				if tt.getFn != nil {
					mockCache.getFn = tt.getFn
				}
				cache = mockCache
			}

			uc := NewUsecase(&mockUserRepository{}, &mockPasswordHasher{}, &mockTokenService{}, cache)
			res, err := uc.RefreshToken(context.Background(), RefreshTokenRequest{
				RefreshToken: tt.reqToken,
			})

			if err == nil {
				t.Fatalf("expected error for case '%s', got nil response %+v", tt.name, res)
			}
			if res != nil {
				t.Errorf("expected nil response on error, got %+v", res)
			}
			if !strings.Contains(err.Error(), tt.errMsg) {
				t.Errorf("expected error message to contain '%s', got '%s'", tt.errMsg, err.Error())
			}
		})
	}
}

func TestUsecase_RefreshToken_NilTokenService(t *testing.T) {
	now := time.Now().UTC()
	snap := UserSessionSnapshot{
		ID:        "user-nil-ts",
		Name:      "Nil TS",
		Email:     "nilts@example.com",
		CreatedAt: now,
		UpdatedAt: now,
	}
	snapBytes, _ := json.Marshal(snap)

	mockCache := newMockSessionCache()
	mockCache.store["refresh:token:valid-token-nil-ts"] = string(snapBytes)

	uc := NewUsecase(&mockUserRepository{}, &mockPasswordHasher{}, nil, mockCache)
	res, err := uc.RefreshToken(context.Background(), RefreshTokenRequest{
		RefreshToken: "valid-token-nil-ts",
	})
	if err == nil {
		t.Fatal("expected error when tokenService is nil, got nil")
	}
	if res != nil {
		t.Errorf("expected nil response, got %+v", res)
	}
	if !strings.Contains(err.Error(), "token service is not configured") {
		t.Errorf("expected 'token service is not configured', got '%s'", err.Error())
	}
}

func TestUsecase_RefreshToken_TokenServiceGenerateError(t *testing.T) {
	now := time.Now().UTC()
	snap := UserSessionSnapshot{
		ID:        "user-gen-err",
		Name:      "Gen Err",
		Email:     "generr@example.com",
		CreatedAt: now,
		UpdatedAt: now,
	}
	snapBytes, _ := json.Marshal(snap)

	mockCache := newMockSessionCache()
	mockCache.store["refresh:token:valid-token-gen-err"] = string(snapBytes)

	mockToken := &mockTokenService{
		generateTokenFn: func(ctx context.Context, user *domain.User) (string, error) {
			return "", errors.New("jwt signing failed")
		},
	}

	uc := NewUsecase(&mockUserRepository{}, &mockPasswordHasher{}, mockToken, mockCache)
	res, err := uc.RefreshToken(context.Background(), RefreshTokenRequest{
		RefreshToken: "valid-token-gen-err",
	})
	if err == nil {
		t.Fatal("expected error on token generation failure, got nil")
	}
	if res != nil {
		t.Errorf("expected nil response, got %+v", res)
	}
	if !strings.Contains(err.Error(), "Failed to generate access token") {
		t.Errorf("expected 'Failed to generate access token', got '%s'", err.Error())
	}
}

func TestUsecase_RefreshToken_CacheDeleteOldTokenError(t *testing.T) {
	now := time.Now().UTC()
	snap := UserSessionSnapshot{
		ID:        "user-del-err",
		Name:      "Del Err",
		Email:     "delerr@example.com",
		CreatedAt: now,
		UpdatedAt: now,
	}
	snapBytes, _ := json.Marshal(snap)

	mockCache := newMockSessionCache()
	mockCache.store["refresh:token:valid-token-del-err"] = string(snapBytes)
	mockCache.deleteFn = func(ctx context.Context, keys ...string) error {
		return errors.New("redis delete timeout")
	}

	uc := NewUsecase(&mockUserRepository{}, &mockPasswordHasher{}, &mockTokenService{}, mockCache)
	res, err := uc.RefreshToken(context.Background(), RefreshTokenRequest{
		RefreshToken: "valid-token-del-err",
	})
	if err == nil {
		t.Fatal("expected error on cache delete failure, got nil")
	}
	if res != nil {
		t.Errorf("expected nil response, got %+v", res)
	}
	if !strings.Contains(err.Error(), "Failed to delete old refresh token") {
		t.Errorf("expected 'Failed to delete old refresh token', got '%s'", err.Error())
	}
}

func TestUsecase_RefreshToken_CacheSetNewTokenError(t *testing.T) {
	now := time.Now().UTC()
	snap := UserSessionSnapshot{
		ID:        "user-set-err",
		Name:      "Set Err",
		Email:     "seterr@example.com",
		CreatedAt: now,
		UpdatedAt: now,
	}
	snapBytes, _ := json.Marshal(snap)

	mockCache := newMockSessionCache()
	mockCache.store["refresh:token:valid-token-set-err"] = string(snapBytes)
	mockCache.setFn = func(ctx context.Context, key string, value interface{}, exp time.Duration) error {
		if strings.HasPrefix(key, "refresh:token:") {
			return errors.New("redis OOM")
		}
		return nil
	}

	uc := NewUsecase(&mockUserRepository{}, &mockPasswordHasher{}, &mockTokenService{}, mockCache)
	res, err := uc.RefreshToken(context.Background(), RefreshTokenRequest{
		RefreshToken: "valid-token-set-err",
	})
	if err == nil {
		t.Fatal("expected error on cache set failure for new refresh token, got nil")
	}
	if res != nil {
		t.Errorf("expected nil response, got %+v", res)
	}
	if !strings.Contains(err.Error(), "Failed to save refresh token") {
		t.Errorf("expected 'Failed to save refresh token', got '%s'", err.Error())
	}
}

func TestUsecase_RefreshToken_CacheSetSessionError(t *testing.T) {
	now := time.Now().UTC()
	snap := UserSessionSnapshot{
		ID:        "user-session-err",
		Name:      "Session Err",
		Email:     "sessionerr@example.com",
		CreatedAt: now,
		UpdatedAt: now,
	}
	snapBytes, _ := json.Marshal(snap)

	mockCache := newMockSessionCache()
	mockCache.store["refresh:token:valid-token-session-err"] = string(snapBytes)
	mockCache.setFn = func(ctx context.Context, key string, value interface{}, exp time.Duration) error {
		if strings.HasPrefix(key, "session:user:") {
			return errors.New("redis cluster down")
		}
		return nil
	}

	uc := NewUsecase(&mockUserRepository{}, &mockPasswordHasher{}, &mockTokenService{}, mockCache)
	res, err := uc.RefreshToken(context.Background(), RefreshTokenRequest{
		RefreshToken: "valid-token-session-err",
	})
	if err == nil {
		t.Fatal("expected error on cache set failure for session, got nil")
	}
	if res != nil {
		t.Errorf("expected nil response, got %+v", res)
	}
	if !strings.Contains(err.Error(), "Failed to save user session") {
		t.Errorf("expected 'Failed to save user session', got '%s'", err.Error())
	}
}

func TestUsecase_Logout_ClearsSessionAndRefreshToken(t *testing.T) {
	now := time.Now().UTC()
	mockCache := newMockSessionCache()

	userSnapshot := UserSessionSnapshot{
		ID:           "user-logout-both",
		Name:         "Logout Both",
		Email:        "both@example.com",
		RefreshToken: "rt-to-clear-123",
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	snapBytes, _ := json.Marshal(userSnapshot)

	sessionKey := "session:user:user-logout-both"
	refreshKey := "refresh:token:rt-to-clear-123"
	mockCache.store[sessionKey] = string(snapBytes)
	mockCache.store[refreshKey] = string(snapBytes)

	uc := NewUsecase(&mockUserRepository{}, &mockPasswordHasher{}, &mockTokenService{}, mockCache)
	err := uc.Logout(context.Background(), "user-logout-both")
	if err != nil {
		t.Fatalf("unexpected error on logout: %v", err)
	}

	// Verify both session key and refresh token key were removed from cache
	if _, exists := mockCache.store[sessionKey]; exists {
		t.Errorf("expected session key '%s' to be deleted from cache store", sessionKey)
	}
	if _, exists := mockCache.store[refreshKey]; exists {
		t.Errorf("expected refresh key '%s' to be deleted from cache store", refreshKey)
	}

	// Verify deleted keys recorded in mock
	foundSessionKey := false
	foundRefreshKey := false
	for _, k := range mockCache.deletedKeys {
		if k == sessionKey {
			foundSessionKey = true
		}
		if k == refreshKey {
			foundRefreshKey = true
		}
	}
	if !foundSessionKey {
		t.Errorf("expected '%s' in deletedKeys, got %v", sessionKey, mockCache.deletedKeys)
	}
	if !foundRefreshKey {
		t.Errorf("expected '%s' in deletedKeys, got %v", refreshKey, mockCache.deletedKeys)
	}
}

func TestUsecase_Logout_ClearsSession_WhenNoRefreshTokenInSnapshot(t *testing.T) {
	now := time.Now().UTC()
	mockCache := newMockSessionCache()

	userSnapshot := UserSessionSnapshot{
		ID:        "user-no-rt-snap",
		Name:      "No RT",
		Email:     "nort@example.com",
		CreatedAt: now,
		UpdatedAt: now,
	}
	snapBytes, _ := json.Marshal(userSnapshot)

	sessionKey := "session:user:user-no-rt-snap"
	mockCache.store[sessionKey] = string(snapBytes)

	uc := NewUsecase(&mockUserRepository{}, &mockPasswordHasher{}, &mockTokenService{}, mockCache)
	err := uc.Logout(context.Background(), "user-no-rt-snap")
	if err != nil {
		t.Fatalf("unexpected error on logout: %v", err)
	}

	if _, exists := mockCache.store[sessionKey]; exists {
		t.Errorf("expected session key '%s' to be deleted from cache", sessionKey)
	}
}

func TestUsecase_Logout_WhenSessionNotFoundInCache(t *testing.T) {
	mockCache := newMockSessionCache()

	uc := NewUsecase(&mockUserRepository{}, &mockPasswordHasher{}, &mockTokenService{}, mockCache)
	err := uc.Logout(context.Background(), "user-not-cached")
	if err != nil {
		t.Fatalf("expected nil error on logout when session not in cache, got %v", err)
	}

	if len(mockCache.deletedKeys) != 1 || mockCache.deletedKeys[0] != "session:user:user-not-cached" {
		t.Errorf("expected Delete to be called for session:user:user-not-cached, got %v", mockCache.deletedKeys)
	}
}
