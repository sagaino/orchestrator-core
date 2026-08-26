package controller

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"base-be-golang/internal/core/usecase/contact"
	"base-be-golang/shared/api"
	"base-be-golang/shared/base"
	"base-be-golang/shared/payload"
)

type ContactController struct {
	base.BaseController
	uc contact.Usecase
}

func NewContactController(dbConn *gorm.DB, port base.Port, ctrl base.BaseController) api.Router {
	return ContactController{
		BaseController: ctrl,
		uc:             contact.NewUsecase(dbConn, port),
	}
}

func (ctrl ContactController) Create(c *gin.Context) {
	var req contact.CreateContactRequest
	if errs := ctrl.Enigma.BindAndValidate(c, &req); errs != nil {
		c.JSON(http.StatusBadRequest, payload.DefaultInvalidInputFormResponse(errs))
		return
	}

	result, err := ctrl.uc.Create(c.Request.Context(), req)
	ctrl.Mapper.NewResponse(c, payload.NewSuccessResponse(result, "ContactCreated"), err)
}

func (ctrl ContactController) GetAll(c *gin.Context) {
	result, err := ctrl.uc.GetAll(c.Request.Context())
	ctrl.Mapper.NewResponse(c, payload.NewSuccessResponse(result, "ContactsRetrieved"), err)
}

func (ctrl ContactController) GetByID(c *gin.Context) {
	id := c.Param("id")
	result, err := ctrl.uc.GetByID(c.Request.Context(), id)
	ctrl.Mapper.NewResponse(c, payload.NewSuccessResponse(result, "ContactRetrieved"), err)
}

func (ctrl ContactController) Update(c *gin.Context) {
	id := c.Param("id")
	var req contact.UpdateContactRequest
	if errs := ctrl.Enigma.BindAndValidate(c, &req); errs != nil {
		c.JSON(http.StatusBadRequest, payload.DefaultInvalidInputFormResponse(errs))
		return
	}

	result, err := ctrl.uc.Update(c.Request.Context(), id, req)
	ctrl.Mapper.NewResponse(c, payload.NewSuccessResponse(result, "ContactUpdated"), err)
}

func (ctrl ContactController) Delete(c *gin.Context) {
	id := c.Param("id")
	err := ctrl.uc.Delete(c.Request.Context(), id)
	ctrl.Mapper.NewResponse(c, payload.NewSuccessResponseNoData("ContactDeleted"), err)
}

func (ctrl ContactController) Route(router *gin.RouterGroup) {
	r := router.Group("/contacts")
	r.POST("", ctrl.Create)
	r.GET("", ctrl.GetAll)
	r.GET("/:id", ctrl.GetByID)
	r.PUT("/:id", ctrl.Update)
	r.DELETE("/:id", ctrl.Delete)
}
