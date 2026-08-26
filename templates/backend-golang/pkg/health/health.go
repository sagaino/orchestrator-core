package health

import (
	"base-be-golang/shared/base"
	"net/http"
	"os"
	"time"

	"github.com/gin-gonic/gin"
)

// Response represents the health check response payload containing status, uptime, and environment.
type Response struct {
	Status      string `json:"status"`
	Uptime      int64  `json:"uptime"`
	Environment string `json:"environment"`
}

// HealthResponse is an alias for Response.
type HealthResponse = Response

// Controller handles health check requests.
type Controller struct {
	base.BaseController
	port base.Port
}

// HealthController is an alias for Controller.
type HealthController = Controller

// NewHealthController creates a new health check controller with injected base dependencies.
func NewHealthController(port base.Port, controller base.BaseController) *Controller {
	return &Controller{
		BaseController: controller,
		port:           port,
	}
}

// New creates a default standalone health check controller.
func New() *Controller {
	return &Controller{}
}

// HealthCheck handles GET /health endpoint and returns HTTP 200 with status, uptime, and environment.
func (ctrl *Controller) HealthCheck(c *gin.Context) {
	env := os.Getenv("ENVIRONMENT")
	if env == "" {
		env = "development"
	}

	c.JSON(http.StatusOK, Response{
		Status:      "OK",
		Uptime:      time.Now().Unix(),
		Environment: env,
	})
}

// Route registers the health check route on a Gin RouterGroup.
func (ctrl *Controller) Route(router *gin.RouterGroup) {
	router.GET("/health", ctrl.HealthCheck)
}

// RegisterRoutes registers the health check handler on any gin.IRoutes (e.g. *gin.Engine or *gin.RouterGroup).
func RegisterRoutes(router gin.IRoutes) {
	ctrl := New()
	router.GET("/health", ctrl.HealthCheck)
}
