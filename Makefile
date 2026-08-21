# DrishtiNet — task entrypoints.
#
# Everything runs inside this repository: .venv/, node_modules/, .cache/, models/, data/.
# Nothing is installed globally and nothing is written outside the repo root.

SHELL := /bin/bash
.DEFAULT_GOAL := help

ROOT      := $(shell pwd)
VENV      := $(ROOT)/.venv
PY        := $(VENV)/bin/python
GATEWAY   := $(ROOT)/services/stream-gateway
COMPOSE   := docker compose -f infra/docker-compose.yml --env-file .env

# Keep every tool's cache inside the repo (workspace rule).
export PIP_CACHE_DIR      := $(ROOT)/.cache/pip
export npm_config_cache   := $(ROOT)/.cache/npm
export YOLO_CONFIG_DIR    := $(ROOT)/.cache/ultralytics
export TORCH_HOME         := $(ROOT)/.cache/torch
export HF_HOME            := $(ROOT)/.cache/huggingface
export EASYOCR_MODULE_PATH:= $(ROOT)/.cache/easyocr

.PHONY: help
help: ## Show this help
	@echo "DrishtiNet — available targets:"
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

# ── setup ────────────────────────────────────────────────────────────────────

.PHONY: setup
setup: ## Install Node and Python dependencies into the repo
	pnpm install
	test -d $(VENV) || python3 -m venv $(VENV)
	$(VENV)/bin/pip install -q --upgrade pip
	$(VENV)/bin/pip install -q 'ruamel.yaml>=0.18' requests
	mkdir -p .cache models data
	@echo "setup complete"

.PHONY: env
env: ## Create .env from .env.example if missing
	@test -f .env || (cp .env.example .env && echo "created .env from .env.example")
	@test -f .env && echo ".env present"

# ── verification ─────────────────────────────────────────────────────────────

.PHONY: test
test: ## Run every test suite
	pnpm -r test:run

.PHONY: typecheck
typecheck: ## Typecheck all TypeScript packages
	pnpm -r typecheck

.PHONY: verify-slot
verify-slot: ## Verify slot arithmetic against captured portal ground truth
	@cd $(GATEWAY) && pnpm -s exec vitest run src/slot.test.ts

.PHONY: slot
slot: ## Show the current slot position and what the footage is showing right now
	@cd $(GATEWAY) && pnpm -s exec tsx src/cli.ts slot

.PHONY: cameras
cameras: ## List the camera registry
	@cd $(GATEWAY) && pnpm -s exec tsx src/cli.ts list

.PHONY: e2e
e2e: ## Run Playwright end-to-end tests (needs the web app running)
	cd apps/web && PLAYWRIGHT_BROWSERS_PATH=$(ROOT)/.cache/playwright pnpm exec playwright test

.PHONY: web
web: ## Build and serve the web app against the local database
	cd apps/web && pnpm build && pnpm start

.PHONY: doctor
doctor: ## Preflight: toolchain, services, disk, offline assets
	@./scripts/doctor.sh

.PHONY: basemap
basemap: ## Rebuild district boundaries + centroids from DataMeet (needs internet; output committed)
	$(PY) scripts/build_basemap.py

.PHONY: pmtiles
pmtiles: ## Build the offline roads/labels PMTiles archives (needs internet; output committed)
	./scripts/build_pmtiles.sh

.PHONY: seed
seed: ## Re-seed the registry from config/cameras.yaml (preserves human-placed positions)
	cd packages/db && pnpm exec tsx src/seed.ts

.PHONY: check
check: typecheck test ## Typecheck + test (run before every commit)

# ── portal interaction (all polite, sequential, logged) ──────────────────────

.PHONY: proxy
proxy: ## Run the caching range proxy (required for deep seeks into portal files)
	@cd $(GATEWAY) && pnpm -s exec tsx src/range-proxy-server.ts

.PHONY: probe
probe: ## Probe unprobed cameras, moov-only. IDS=9,12,13 make probe
	@test -n "$(IDS)" || (echo "usage: make probe IDS=9,12,13" && exit 1)
	python3 scripts/probe_mp4.py --ids $(IDS) --out data/probe/media_probe_$(shell date +%Y%m%d_%H%M%S).json

.PHONY: sync-registry
sync-registry: ## Sync config/cameras.yaml against the portal roster (never deletes)
	$(PY) scripts/sync_registry.py

.PHONY: capture
capture: ## Capture daylight + night windows for the demo cameras (needs `make proxy`)
	./scripts/capture_demo_windows.sh

.PHONY: verify-mirror
verify-mirror: ## Audit data/mirror: which captured clips actually decode
	python3 scripts/mirror.py verify

.PHONY: transfer-log
transfer-log: ## Show recent upstream transfers
	@tail -40 data/transfer.log 2>/dev/null || echo "no transfers logged yet"

# ── stack ────────────────────────────────────────────────────────────────────

.PHONY: up
up: env ## Start the full stack
	$(COMPOSE) --profile full up -d --build

.PHONY: infra
infra: env ## Start only the backing services (postgres, redis, minio, mediamtx)
	$(COMPOSE) up -d postgres redis minio minio-init mediamtx

.PHONY: down
down: ## Stop the stack
	$(COMPOSE) down

.PHONY: logs
logs: ## Follow stack logs
	$(COMPOSE) logs -f

# ── cleanup ──────────────────────────────────────────────────────────────────

.PHONY: clean-data
clean-data: ## Delete ALL government footage and derived data (data/ except the probe report)
	@echo "This deletes every mirrored clip, sample and index under data/."
	@echo "data/probe/REPORT.md is preserved."
	@read -p "Type 'delete' to confirm: " ans && [ "$$ans" = "delete" ] || (echo "aborted"; exit 1)
	rm -rf data/samples data/mirror data/index data/labels
	find data -maxdepth 1 -type f ! -name '.gitkeep' -delete
	@echo "footage removed. data/probe/REPORT.md kept."

.PHONY: clean-cache
clean-cache: ## Clear the in-repo caches (range proxy chunks, model/tooling caches)
	rm -rf .cache/rangeproxy .cache/scratch
	@echo "caches cleared"

.PHONY: clean
clean: ## Remove build output and node_modules
	rm -rf node_modules */node_modules **/*/node_modules .next dist
	@echo "build output removed"
