package api

import (
	"base-be-golang/pkg/cache"
	"base-be-golang/pkg/logger"
	"base-be-golang/pkg/miniostorage"
	"os"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

type Api struct {
	server   *gin.Engine
	db       *gorm.DB
	cache    cache.DbClient
	minioStr miniostorage.StorageMinio
	reZero   *logger.ReZero
	routers  []Router
}

type Router interface {
	Route(handler *gin.RouterGroup)
}

func (a *Api) DB() *gorm.DB { return a.db }

func (a *Api) Start() error {
	root := a.server.Group("/api/v1")

	for _, router := range a.routers {
		router.Route(root)
	}

	port := os.Getenv("APP_PORT")
	err := a.server.Run("0.0.0.0:" + port)
	if err != nil {
		return err
	}

	return err
}
