package controller

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"base-be-golang/internal/core/domain"
	"base-be-golang/internal/core/usecase/contact"
	"base-be-golang/pkg/middleware"
	"base-be-golang/shared/base"
	"base-be-golang/shared/payload"
)

type mockContactRepoForCtrl struct {
	storeFn       func(ctx context.Context, data domain.Contact) (domain.Contact, error)
	findAllFn     func(ctx context.Context) ([]domain.Contact, error)
	findOneByIDFn func(ctx context.Context, id interface{}) (domain.Contact, error)
	updateFn      func(ctx context.Context, data domain.Contact) error
	deleteByIDFn  func(ctx context.Context, id interface{}) error
}

func (m *mockContactRepoForCtrl) Store(ctx context.Context, data domain.Contact) (domain.Contact, error) {
	if m.storeFn != nil {
		return m.storeFn(ctx, data)
	}
	data.ID = "c-1"
	return data, nil
}

func (m *mockContactRepoForCtrl) FindAll(ctx context.Context) ([]domain.Contact, error) {
	if m.findAllFn != nil {
		return m.findAllFn(ctx)
	}
	return []domain.Contact{}, nil
}

func (m *mockContactRepoForCtrl) FindOneByID(ctx context.Context, id interface{}) (domain.Contact, error) {
	if m.findOneByIDFn != nil {
		return m.findOneByIDFn(ctx, id)
	}
	return domain.Contact{}, nil
}

func (m *mockContactRepoForCtrl) Update(ctx context.Context, data domain.Contact) error {
	if m.updateFn != nil {
		return m.updateFn(ctx, data)
	}
	return nil
}

func (m *mockContactRepoForCtrl) DeleteByID(ctx context.Context, id interface{}) error {
	if m.deleteByIDFn != nil {
		return m.deleteByIDFn(ctx, id)
	}
	return nil
}

type mockContactMapper struct{}

func (m *mockContactMapper) NewResponse(c *gin.Context, res *payload.Response, err error) {
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, res)
}

func setupContactTestRouter(uc contact.Usecase) *gin.Engine {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	enigma := middleware.NewEnigma()
	ctrl := ContactController{
		BaseController: base.BaseController{
			Enigma: enigma,
			Mapper: &mockContactMapper{},
		},
		uc: uc,
	}
	ctrl.Route(router.Group("/api/v1"))
	return router
}

func TestContactController_Create_Success(t *testing.T) {
	uc := contact.NewUsecaseWithRepo(base.Port{}, &mockContactRepoForCtrl{
		storeFn: func(ctx context.Context, data domain.Contact) (domain.Contact, error) {
			data.ID = "c-1"
			return data, nil
		},
	})
	router := setupContactTestRouter(uc)

	reqBody := []byte(`{"name":"Jane Doe","phone_number":"081234567890"}`)
	req, _ := http.NewRequest(http.MethodPost, "/api/v1/contacts", bytes.NewBuffer(reqBody))
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d. Body: %s", http.StatusOK, w.Code, w.Body.String())
	}

	var resp payload.Response
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to parse response: %v", err)
	}
	if resp.Code != http.StatusOK {
		t.Errorf("expected code %d, got %d", http.StatusOK, resp.Code)
	}
}

func TestContactController_GetAll_Success(t *testing.T) {
	uc := contact.NewUsecaseWithRepo(base.Port{}, &mockContactRepoForCtrl{
		findAllFn: func(ctx context.Context) ([]domain.Contact, error) {
			return []domain.Contact{
				{BaseEntity: domain.BaseEntity{ID: "c-1"}, Name: "Jane Doe", PhoneNumber: "081234567890"},
			}, nil
		},
	})
	router := setupContactTestRouter(uc)

	req, _ := http.NewRequest(http.MethodGet, "/api/v1/contacts", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d. Body: %s", http.StatusOK, w.Code, w.Body.String())
	}
}

func TestContactController_GetByID_Success(t *testing.T) {
	uc := contact.NewUsecaseWithRepo(base.Port{}, &mockContactRepoForCtrl{
		findOneByIDFn: func(ctx context.Context, id interface{}) (domain.Contact, error) {
			return domain.Contact{
				BaseEntity:  domain.BaseEntity{ID: "c-1"},
				Name:        "Jane Doe",
				PhoneNumber: "081234567890",
			}, nil
		},
	})
	router := setupContactTestRouter(uc)

	req, _ := http.NewRequest(http.MethodGet, "/api/v1/contacts/c-1", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d. Body: %s", http.StatusOK, w.Code, w.Body.String())
	}
}

func TestContactController_Update_Success(t *testing.T) {
	uc := contact.NewUsecaseWithRepo(base.Port{}, &mockContactRepoForCtrl{
		findOneByIDFn: func(ctx context.Context, id interface{}) (domain.Contact, error) {
			return domain.Contact{
				BaseEntity:  domain.BaseEntity{ID: "c-1"},
				Name:        "Old Name",
				PhoneNumber: "081234567890",
			}, nil
		},
		updateFn: func(ctx context.Context, data domain.Contact) error {
			return nil
		},
	})
	router := setupContactTestRouter(uc)

	reqBody := []byte(`{"name":"Updated Name","phone_number":"089999999999"}`)
	req, _ := http.NewRequest(http.MethodPut, "/api/v1/contacts/c-1", bytes.NewBuffer(reqBody))
	req.Header.Set("Content-Type", "application/json")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d. Body: %s", http.StatusOK, w.Code, w.Body.String())
	}
}

func TestContactController_Delete_Success(t *testing.T) {
	uc := contact.NewUsecaseWithRepo(base.Port{}, &mockContactRepoForCtrl{
		deleteByIDFn: func(ctx context.Context, id interface{}) error {
			return nil
		},
	})
	router := setupContactTestRouter(uc)

	req, _ := http.NewRequest(http.MethodDelete, "/api/v1/contacts/c-1", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status %d, got %d. Body: %s", http.StatusOK, w.Code, w.Body.String())
	}
}
