package controller

import (
	"base-be-golang/internal/core/domain"
	"base-be-golang/internal/core/usecase/product"
	"base-be-golang/shared/base"
	"base-be-golang/shared/payload"
	"context"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

// ProductUsecase defines the usecase methods required by ProductController.
type ProductUsecase interface {
	Create(ctx context.Context, request product.CreateProductRequest) (domain.Product, error)
	GetAll(ctx context.Context) ([]domain.Product, error)
}

// ProductController handles HTTP requests for products.
type ProductController struct {
	base.BaseController
	port base.Port
	uc   ProductUsecase
}

// NewProductController creates a new ProductController with standard dependencies.
func NewProductController(
	dbConn *gorm.DB,
	port base.Port,
	controller base.BaseController,
) *ProductController {
	return &ProductController{
		BaseController: controller,
		port:           port,
		uc:             product.NewUsecase(dbConn, port),
	}
}

// NewProductControllerWithUsecase creates a ProductController with an injected usecase (useful for testing).
func NewProductControllerWithUsecase(
	port base.Port,
	controller base.BaseController,
	uc ProductUsecase,
) *ProductController {
	return &ProductController{
		BaseController: controller,
		port:           port,
		uc:             uc,
	}
}

// Create handles POST /products endpoint to create a new product.
func (ctrl *ProductController) Create(c *gin.Context) {
	if ctrl.uc == nil {
		ctrl.respond(c, nil, errors.New("product usecase not initialized"))
		return
	}

	var request product.CreateProductRequest
	if ctrl.Enigma != nil {
		if errs := ctrl.Enigma.BindAndValidate(c, &request); len(errs) > 0 {
			c.JSON(http.StatusBadRequest, payload.DefaultInvalidInputFormResponse(errs))
			return
		}
	} else {
		if err := c.ShouldBindJSON(&request); err != nil {
			c.JSON(http.StatusBadRequest, payload.DefaultErrorInvalidDataWithMessage(err.Error()))
			return
		}
	}

	created, err := ctrl.uc.Create(c.Request.Context(), request)
	ctrl.respond(c, payload.NewSuccessResponse(created, "CreateProductSuccess"), err)
}

// GetAll handles GET /products endpoint to retrieve all products.
func (ctrl *ProductController) GetAll(c *gin.Context) {
	if ctrl.uc == nil {
		ctrl.respond(c, nil, errors.New("product usecase not initialized"))
		return
	}

	products, err := ctrl.uc.GetAll(c.Request.Context())
	ctrl.respond(c, payload.NewSuccessResponse(products, "GetProductsSuccess"), err)
}

// Route registers the product routes on a Gin RouterGroup.
func (ctrl *ProductController) Route(router *gin.RouterGroup) {
	productRouter := router.Group("/products")
	productRouter.POST("", ctrl.Create)
	productRouter.GET("", ctrl.GetAll)
}

// RegisterRoutes registers the product endpoints directly on gin.IRoutes.
func (ctrl *ProductController) RegisterRoutes(router gin.IRoutes) {
	router.POST("/products", ctrl.Create)
	router.GET("/products", ctrl.GetAll)
}

// respond formats and sends the response using Mapper if available, or fallback formatting.
func (ctrl *ProductController) respond(c *gin.Context, res *payload.Response, err error) {
	if ctrl.Mapper != nil {
		ctrl.Mapper.NewResponse(c, res, err)
		return
	}

	if err != nil {
		c.JSON(http.StatusInternalServerError, payload.DefaultErrorResponse(err))
		return
	}

	if res != nil {
		c.JSON(http.StatusOK, res)
		return
	}

	c.Status(http.StatusOK)
}
