package main

import (
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
	flag.StringVar(&envFile, "env", ".env.dev", "Provide env file path")
	flag.Parse()
	err := godotenv.Load(envFile)
	if err != nil {
		log.Println(err)
	}

	start := api.Default()

	// ========================= REGISTER CONTROLLER =========================
	// SYSTEM MODULE: Health check endpoint (/api/v1/health)
	start.Register(func(dbConn *gorm.DB, port base.Port, ctrl base.BaseController) api.Router {
		return health.NewHealthController(port, ctrl)
	})

	// BUSINESS MODULES: Register your business controllers here
	// Example:
	// start.Register(func(dbConn *gorm.DB, port base.Port, ctrl base.BaseController) api.Router {
	// 	return controller.NewOrderController(dbConn, port, ctrl)
	// })

	// ========================= DATABASE AUTO MIGRATE =========================
	// Register domain entities for GORM AutoMigrate here
	// Example:
	// start.DB().AutoMigrate(&domain.Order{})

	err = start.Start()
	if err != nil {
		panic(err)
	}
}
