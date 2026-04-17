.PHONY: test lint fmt check build coverage

## Run test suite
test:
	go test ./...

## Run linters
lint:
	golangci-lint run ./...

## Format code
fmt:
	gofmt -w .

## Pre-commit gate: format, lint, test
check: fmt lint test

## Build the project
build:
	go build ./...

## Run test coverage report
coverage:
	go test -coverprofile=coverage.out ./...
	go tool cover -func=coverage.out
