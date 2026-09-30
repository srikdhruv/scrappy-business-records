# Scrappy Records — developer commands. Run `make help` for the list.
# Needs uv, Node 20+ and GNU make (macOS/Linux, or Git Bash on Windows).

SHELL := /bin/bash

DEVDATA  := $(CURDIR)/.devdata
PORT     := 8765
UV       := uv run --project backend
# Dev and `make run` never touch real data: everything lives in ./.devdata.
DEV_ENV  := SCRAPPY_HOME="$(DEVDATA)" SCRAPPY_BACKUP_DIR="$(DEVDATA)/backups" SCRAPPY_PORT=$(PORT)
OPENAPI  := frontend/node_modules/.tmp/openapi.json

.DEFAULT_GOAL := help
.PHONY: help setup dev dev-mock seed test e2e lint fmt gen-api build run package db-reset clean

help: ## List the available commands
	@echo "Scrappy Records — make targets:"
	@grep -E '^[a-zA-Z0-9_-]+:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[1m%-10s\033[0m %s\n", $$1, $$2}'

setup: ## Install backend (uv) and frontend (npm) dependencies
	cd backend && uv sync --locked
	cd frontend && npm ci

dev: ## API with auto-reload on :8765 + Vite UI on :5173 (open that one). Ctrl-C stops both
	@mkdir -p "$(DEVDATA)"
	@echo "UI:  http://localhost:5173   (API docs: http://127.0.0.1:$(PORT)/api/docs)"
	@trap 'kill 0' INT TERM; \
	$(DEV_ENV) $(UV) uvicorn app.main:app --reload --reload-dir backend/app \
		--host 127.0.0.1 --port $(PORT) & \
	(cd frontend && npm run dev) & \
	wait

dev-mock: ## Just the UI on :5173, with a pretend API and demo data (no backend needed)
	@echo "UI with demo data: http://localhost:5173   (add ?demo=empty or ?demo=all-paid)"
	cd frontend && npm run dev:mock

seed: ## Fill ./.devdata with demo students and payments
	@if [ ! -f backend/app/seed.py ]; then \
		echo "make seed: backend/app/seed.py doesn't exist yet (it arrives with the backend PR)."; \
		exit 1; \
	fi
	$(DEV_ENV) $(UV) python -m app.seed

test: ## Backend pytest and frontend vitest
	cd backend && uv run pytest
	cd frontend && npm test

e2e: build ## Build, then run the Playwright end-to-end tests against the production server
	@if [ ! -f frontend/playwright.config.ts ]; then \
		echo "make e2e: frontend/playwright.config.ts doesn't exist yet (it arrives with a later PR)."; \
		exit 1; \
	fi
	cd frontend && npx playwright test

lint: ## Lint and type-check everything (ruff, eslint, prettier --check, tsc)
	cd backend && uv run ruff check . ../scripts && uv run ruff format --check . ../scripts
	cd frontend && npm run lint && npm run typecheck

fmt: ## Auto-format everything (ruff, prettier, eslint --fix)
	cd backend && uv run ruff format . ../scripts && uv run ruff check --fix . ../scripts
	cd frontend && npm run fmt

gen-api: ## Regenerate frontend/src/api/schema.d.ts from the backend's OpenAPI (no server needed)
	@mkdir -p $(dir $(OPENAPI))
	$(UV) python -m app.openapi_dump > $(OPENAPI)
	cd frontend && npm run gen-api

build: ## Build the UI into backend/app/static/
	cd frontend && npm run build

run: ## Serve the production build from :8765, as the user's laptop does (data in ./.devdata)
	@if [ ! -f backend/app/static/index.html ]; then \
		echo "Note: the UI isn't built, so only /api works. Run 'make build' first."; \
	fi
	@echo "Open http://127.0.0.1:$(PORT)"
	$(DEV_ENV) $(UV) python -m app

package: build ## Build the UI, then the self-contained bundle zip for this OS into dist/ (self-tested)
	$(UV) python scripts/build_bundle.py

db-reset: ## Delete ./.devdata (dev database, logs and backups)
	rm -rf "$(DEVDATA)"

clean: ## Remove build outputs and caches
	rm -rf backend/app/static dist bundle \
		frontend/node_modules/.tmp frontend/node_modules/.vite \
		frontend/test-results frontend/playwright-report frontend/blob-report \
		backend/.pytest_cache backend/.ruff_cache .ruff_cache
	find backend -path backend/.venv -prune -o -name __pycache__ -type d -prune -exec rm -rf {} +
