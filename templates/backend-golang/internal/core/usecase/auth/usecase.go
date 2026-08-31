package auth

import (
	"base-be-golang/internal/core/domain"
	"base-be-golang/pkg/localerror"
	"context"
	"encoding/json"
	"errors"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
)

type SessionCache interface {
	Set(ctx context.Context, key string, value interface{}, exp time.Duration) error
	Get(ctx context.Context, key string) (string, error)
	Delete(ctx context.Context, keys ...string) error
}

type Usecase interface {
	Register(ctx context.Context, req RegisterRequest) (*RegisterResponse, error)
	Login(ctx context.Context, req LoginRequest) (*LoginResponse, error)
}

type SessionUsecase interface {
	Register(ctx context.Context, req RegisterRequest) (*RegisterResponse, error)
	Login(ctx context.Context, req LoginRequest) (*LoginResponse, error)
	Logout(ctx context.Context, userID string) error
	RefreshToken(ctx context.Context, req RefreshTokenRequest) (*RefreshTokenResponse, error)
}

type usecase struct {
	userRepo        domain.UserRepository
	hasher          domain.PasswordHasher
	tokenService    domain.TokenService
	sessionCache    SessionCache
	sessionTTL      time.Duration
	refreshTokenTTL time.Duration
}

func getSessionTTL() time.Duration {
	defaultTTL := 3 * time.Minute
	if envMin := os.Getenv("EXPIRED_TOKEN_JWT_MINUTES"); envMin != "" {
		if min, err := strconv.Atoi(envMin); err == nil && min > 0 {
			return time.Duration(min) * time.Minute
		}
	}
	if envMin := os.Getenv("EXPIRED_TOKEN_JWT"); envMin != "" {
		if min, err := strconv.Atoi(envMin); err == nil && min > 0 {
			return time.Duration(min) * time.Minute
		}
	}
	return defaultTTL
}

func getRefreshTokenTTL() time.Duration {
	defaultTTL := 7 * 24 * time.Hour
	if envDays := os.Getenv("REFRESH_TOKEN_TTL_DAYS"); envDays != "" {
		if days, err := strconv.Atoi(envDays); err == nil && days > 0 {
			return time.Duration(days) * 24 * time.Hour
		}
	}
	return defaultTTL
}

func NewUsecase(userRepo domain.UserRepository, hasher domain.PasswordHasher, tokenService domain.TokenService, sessionCache ...SessionCache) SessionUsecase {
	if hasher == nil {
		hasher = domain.NewBcryptPasswordHasher()
	}
	var cache SessionCache
	if len(sessionCache) > 0 && sessionCache[0] != nil {
		cache = sessionCache[0]
	}
	ttl := getSessionTTL()
	refreshTTL := getRefreshTokenTTL()
	return &usecase{
		userRepo:        userRepo,
		hasher:          hasher,
		tokenService:    tokenService,
		sessionCache:    cache,
		sessionTTL:      ttl,
		refreshTokenTTL: refreshTTL,
	}
}

func NewUsecaseWithTTL(userRepo domain.UserRepository, hasher domain.PasswordHasher, tokenService domain.TokenService, sessionCache SessionCache, ttl time.Duration, refreshTTL ...time.Duration) SessionUsecase {
	if hasher == nil {
		hasher = domain.NewBcryptPasswordHasher()
	}
	if ttl <= 0 {
		ttl = getSessionTTL()
	}
	rTTL := getRefreshTokenTTL()
	if len(refreshTTL) > 0 && refreshTTL[0] > 0 {
		rTTL = refreshTTL[0]
	}
	return &usecase{
		userRepo:        userRepo,
		hasher:          hasher,
		tokenService:    tokenService,
		sessionCache:    sessionCache,
		sessionTTL:      ttl,
		refreshTokenTTL: rTTL,
	}
}

func (u *usecase) Register(ctx context.Context, req RegisterRequest) (*RegisterResponse, error) {
	name := strings.TrimSpace(req.Name)
	if name == "" {
		return nil, localerror.InvalidData("User name is required")
	}

	email := strings.TrimSpace(strings.ToLower(req.Email))
	if email == "" {
		return nil, localerror.InvalidData("User email is required")
	}

	password := req.Password
	if len(password) < 6 {
		return nil, localerror.InvalidData("Password must be at least 6 characters")
	}

	existingUser, err := u.userRepo.FindByEmail(ctx, email)
	if err == nil && existingUser != nil {
		return nil, localerror.InvalidData("Email is already registered")
	}
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}

	hashedPassword, err := u.hasher.HashPassword(password)
	if err != nil {
		return nil, err
	}

	user := domain.User{
		BaseEntity: domain.BaseEntity{
			ID: uuid.NewString(),
		},
		Name:     name,
		Email:    email,
		Password: hashedPassword,
	}
	user.SetCreated(name)

	if err := u.userRepo.Create(ctx, &user); err != nil {
		return nil, err
	}

	return &RegisterResponse{
		ID:        user.ID,
		Name:      user.Name,
		Email:     user.Email,
		CreatedAt: user.CreatedAt,
		UpdatedAt: user.UpdatedAt,
	}, nil
}

func (u *usecase) Login(ctx context.Context, req LoginRequest) (*LoginResponse, error) {
	email := strings.TrimSpace(strings.ToLower(req.Email))
	if email == "" {
		return nil, localerror.InvalidData("User email is required")
	}

	password := req.Password
	if password == "" {
		return nil, localerror.InvalidData("Password is required")
	}

	user, err := u.userRepo.FindByEmail(ctx, email)
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, localerror.InvalidData("Invalid email or password")
		}
		return nil, err
	}
	if user == nil {
		return nil, localerror.InvalidData("Invalid email or password")
	}

	if err := u.hasher.ComparePassword(user.Password, password); err != nil {
		return nil, localerror.InvalidData("Invalid email or password")
	}

	if u.tokenService == nil {
		return nil, errors.New("token service is not configured")
	}

	token, err := u.tokenService.GenerateToken(ctx, user)
	if err != nil {
		return nil, err
	}

	refreshToken := uuid.NewString()

	if u.sessionCache != nil {
		snapshot := UserSessionSnapshot{
			ID:           user.ID,
			Name:         user.Name,
			Email:        user.Email,
			RefreshToken: refreshToken,
			CreatedAt:    user.CreatedAt,
			UpdatedAt:    user.UpdatedAt,
		}
		sessionBytes, err := json.Marshal(snapshot)
		if err != nil {
			return nil, localerror.InternalError{Msg: "Failed to serialize user session: " + err.Error()}
		}

		sessionKey := "session:user:" + user.ID
		ttl := u.sessionTTL
		if ttl <= 0 {
			ttl = getSessionTTL()
		}

		if err := u.sessionCache.Set(ctx, sessionKey, string(sessionBytes), ttl); err != nil {
			return nil, localerror.InternalError{Msg: "Failed to save user session: " + err.Error()}
		}

		refreshTTL := u.refreshTokenTTL
		if refreshTTL <= 0 {
			refreshTTL = getRefreshTokenTTL()
		}
		refreshKey := "refresh:token:" + refreshToken
		if err := u.sessionCache.Set(ctx, refreshKey, string(sessionBytes), refreshTTL); err != nil {
			return nil, localerror.InternalError{Msg: "Failed to save refresh token: " + err.Error()}
		}
	}

	return &LoginResponse{
		AccessToken:  token,
		RefreshToken: refreshToken,
		TokenType:    "Bearer",
		User: &RegisterResponse{
			ID:        user.ID,
			Name:      user.Name,
			Email:     user.Email,
			CreatedAt: user.CreatedAt,
			UpdatedAt: user.UpdatedAt,
		},
	}, nil
}

func (u *usecase) RefreshToken(ctx context.Context, req RefreshTokenRequest) (*RefreshTokenResponse, error) {
	refreshToken := strings.TrimSpace(req.RefreshToken)
	if refreshToken == "" {
		return nil, localerror.AccessControlError{Msg: "Invalid or expired refresh token"}
	}

	if u.sessionCache == nil {
		return nil, localerror.AccessControlError{Msg: "Invalid or expired refresh token"}
	}

	if u.tokenService == nil {
		return nil, errors.New("token service is not configured")
	}

	refreshKey := "refresh:token:" + refreshToken
	rawSession, err := u.sessionCache.Get(ctx, refreshKey)
	if err != nil || strings.TrimSpace(rawSession) == "" {
		return nil, localerror.AccessControlError{Msg: "Invalid or expired refresh token"}
	}

	var snapshot UserSessionSnapshot
	if err := json.Unmarshal([]byte(rawSession), &snapshot); err != nil || strings.TrimSpace(snapshot.ID) == "" {
		return nil, localerror.AccessControlError{Msg: "Invalid or expired refresh token"}
	}

	// Step 1: Remove old refresh token from Redis (Refresh Token Rotation)
	if err := u.sessionCache.Delete(ctx, refreshKey); err != nil {
		return nil, localerror.InternalError{Msg: "Failed to delete old refresh token: " + err.Error()}
	}

	// Step 2: Generate new AccessToken and new RefreshToken
	user := &domain.User{
		BaseEntity: domain.BaseEntity{
			ID:        snapshot.ID,
			CreatedAt: snapshot.CreatedAt,
			UpdatedAt: snapshot.UpdatedAt,
		},
		Name:  snapshot.Name,
		Email: snapshot.Email,
	}

	newAccessToken, err := u.tokenService.GenerateToken(ctx, user)
	if err != nil {
		return nil, localerror.InternalError{Msg: "Failed to generate access token: " + err.Error()}
	}

	newRefreshToken := uuid.NewString()

	// Step 3: Update session snapshot and save new RefreshToken with 7-day sliding TTL
	snapshot.RefreshToken = newRefreshToken
	newSessionBytes, err := json.Marshal(snapshot)
	if err != nil {
		return nil, localerror.InternalError{Msg: "Failed to serialize user session: " + err.Error()}
	}

	refreshTTL := u.refreshTokenTTL
	if refreshTTL <= 0 {
		refreshTTL = getRefreshTokenTTL()
	}
	newRefreshKey := "refresh:token:" + newRefreshToken
	if err := u.sessionCache.Set(ctx, newRefreshKey, string(newSessionBytes), refreshTTL); err != nil {
		return nil, localerror.InternalError{Msg: "Failed to save refresh token: " + err.Error()}
	}

	// Step 4: Update user session in Redis session:user:<userId>
	sessionTTL := u.sessionTTL
	if sessionTTL <= 0 {
		sessionTTL = getSessionTTL()
	}
	sessionKey := "session:user:" + snapshot.ID
	if err := u.sessionCache.Set(ctx, sessionKey, string(newSessionBytes), sessionTTL); err != nil {
		return nil, localerror.InternalError{Msg: "Failed to save user session: " + err.Error()}
	}

	// Step 5: Return RefreshTokenResponse with new token pair
	return &RefreshTokenResponse{
		AccessToken:  newAccessToken,
		RefreshToken: newRefreshToken,
		TokenType:    "Bearer",
	}, nil
}

func (u *usecase) Logout(ctx context.Context, userID string) error {
	trimmedID := strings.TrimSpace(userID)
	if trimmedID == "" {
		return localerror.InvalidData("User ID is required")
	}

	if u.sessionCache == nil {
		return nil
	}

	sessionKey := "session:user:" + trimmedID
	rawSession, err := u.sessionCache.Get(ctx, sessionKey)
	if err == nil && strings.TrimSpace(rawSession) != "" {
		var snapshot UserSessionSnapshot
		if err := json.Unmarshal([]byte(rawSession), &snapshot); err == nil && strings.TrimSpace(snapshot.RefreshToken) != "" {
			refreshKey := "refresh:token:" + snapshot.RefreshToken
			if err := u.sessionCache.Delete(ctx, sessionKey, refreshKey); err != nil {
				return localerror.InternalError{Msg: "Failed to delete user session: " + err.Error()}
			}
			return nil
		}
	}

	if err := u.sessionCache.Delete(ctx, sessionKey); err != nil {
		return localerror.InternalError{Msg: "Failed to delete user session: " + err.Error()}
	}

	return nil
}
