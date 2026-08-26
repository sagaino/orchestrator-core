.PHONY: help dev run test vet build tidy docker-up docker-down

help:
	@echo "Available commands:"
	@echo "  make dev         - Run application with .env.dev"
	@echo "  make run         - Run application with default .env"
	@echo "  make test        - Run all tests"
	@echo "  make vet         - Run go vet code analysis"
	@echo "  make build       - Build binary to bin/api"
	@echo "  make tidy        - Download & tidy dependencies"
	@echo "  make docker-up   - Start local dependencies (Postgres, Redis, MinIO)"
	@echo "  make docker-down - Stop local dependencies"

dev:
	go run ./cmd/api -env .env.dev

run:
	go run ./cmd/api -env .env

test:
	go test ./...

vet:
	go vet ./...

build:
	go build -o bin/api ./cmd/api

tidy:
	go mod tidy && go mod download

docker-up:
	docker compose up -d

docker-down:
	docker compose down