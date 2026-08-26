package db

import (
	"fmt"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"os"
	"strconv"
)

func Default() (*gorm.DB, error) {
	// logLevel (env: DB_LOG_MODE)
	// 1 = Silent (not printing any log)
	// 2 = Error (only printing in case of error)
	// 3 = Warn (print error + warning)
	// 4 = Info (print all type of log)
	logLevel, _ := strconv.Atoi(os.Getenv("DB_LOG_MODE"))
	if logLevel == 0 {
		logLevel = 2
	}
	var (
		username string
		password string
		host     string
		port     string
		dbName   string
	)
	username = os.Getenv("PG_USER")
	password = os.Getenv("PG_PASSWORD")
	dbName = os.Getenv("PG_DATABASE")
	port = os.Getenv("PG_PORT")

	switch os.Getenv("ENVIRONMENT") {
	case "development":
		host = os.Getenv("PG_HOST_DEV")
	case "staging":
		host = os.Getenv("PG_HOST_STAG_DOCKER")
	case "docker":
		host = os.Getenv("PG_HOST_DOCKER")
	}

	dbConn, err := gorm.Open(
		postgres.Open(fmt.Sprintf(
			"host=%s user=%s password=%s dbname=%s port=%s sslmode=disable TimeZone=UTC",
			host,
			username,
			password,
			dbName,
			port,
		)),
		&gorm.Config{
			CreateBatchSize: 500,
			Logger:          logger.Default.LogMode(logger.LogLevel(logLevel)),
		},
	)

	return dbConn, err

}
