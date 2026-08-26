package main

import (
	"base-be-golang/internal/adapter/controller"
	"base-be-golang/internal/core/domain"
	"base-be-golang/pkg/health"
	"base-be-golang/shared/api"
	"base-be-golang/shared/base"
	"flag"
	"log"

	"github.com/joho/godotenv"
	_ "github.com/joho/godotenv/autoload"
	"gorm.io/gorm"
)

func main() {
	var envFile string
	flag.StringVar(&envFile, "env", ".env.stag", "Provide env file path")
	flag.Parse()
	err := godotenv.Load(envFile)
	if err != nil {
		log.Println(err)
		panic(err)

	}

	start := api.Default()

	// ========================= REGISTER CONTROLLER =========================
	// IAM MODULE — removed, build your own and register here
	// BUSINESS MODULE — register your business controllers here
	start.Register(func(dbConn *gorm.DB, port base.Port, ctrl base.BaseController) api.Router {
		return health.NewHealthController(port, ctrl)
	})
	start.Register(func(dbConn *gorm.DB, port base.Port, ctrl base.BaseController) api.Router {
		return controller.NewProductController(dbConn, port, ctrl)
	})
	start.Register(func(dbConn *gorm.DB, port base.Port, ctrl base.BaseController) api.Router {
		return controller.NewContactController(dbConn, port, ctrl)
	})

	start.DB().AutoMigrate(&domain.Product{}, &domain.Contact{})

	err = start.Start()
	if err != nil {
		panic(err)
	}

}
