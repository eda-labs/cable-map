# EDA generated start
SHELL ?= /bin/bash -eo pipefail
.DEFAULT_GOAL=help

TOP_DIR := $(abspath $(dir $(abspath $(lastword $(MAKEFILE_LIST)))))
MKLIBS=$(TOP_DIR)/.mk
include $(sort $(wildcard $(MKLIBS)/*.mk))
# EDA generated stop

# Project targets: small, memorable wrappers around the generated EDA targets.
PNPM ?= pnpm
APP_DIR := cable_map
FRONTEND_DIR := $(APP_DIR)/frontend
FRONTEND := $(PNPM) -C $(FRONTEND_DIR)
OPERATOR := cable-map
EMBED_DIR := $(APP_DIR)/operators/$(OPERATOR)/internal/server/dist
OPERATOR_BIN := build/operators/$(OPERATOR)/$(OPERATOR)
IMAGE ?= ghcr.io/eda-labs/cable-map/operators/cable-map:dev
GOOS ?= linux
GOARCH ?= amd64
CGO_ENABLED ?= 0

PROJECT_TARGETS += dev
PROJECT_TARGETS += dev-cluster
PROJECT_TARGETS += preview
PROJECT_TARGETS += lint
PROJECT_TARGETS += ts-contract
PROJECT_TARGETS += ts-contract-check
PROJECT_TARGETS += ui-build
PROJECT_TARGETS += ui-embed
PROJECT_TARGETS += operator-build
PROJECT_TARGETS += operator-build-dev
PROJECT_TARGETS += binary
PROJECT_TARGETS += build
PROJECT_TARGETS += image
PROJECT_TARGETS += deploy-local
PROJECT_TARGETS += check
PROJECT_TARGETS += clean

.PHONY: dev
HELP_dev := Start the Vite dev server (mock /api by default; set EDA_API to proxy a real backend)
dev:
	$(FRONTEND) dev

.PHONY: dev-cluster
HELP_dev-cluster := DevSpace: hot-reload the operator in the deployed pod + run the frontend (HMR)
dev-cluster:
	devspace dev

.PHONY: preview
HELP_preview := Preview the production Vite build locally
preview:
	$(FRONTEND) preview

.PHONY: lint
HELP_lint := Run frontend lint checks
lint:
	$(FRONTEND) lint

TYGO ?= github.com/gzuidhof/tygo@v0.2.21

.PHONY: ts-contract
HELP_ts-contract := Generate frontend/src/generated/topology.gen.ts from the Go output contract (internal/topology/contract.go)
ts-contract:
	go -C "$(APP_DIR)" run $(TYGO) generate

.PHONY: ts-contract-check
HELP_ts-contract-check := Fail if frontend/src/generated/topology.gen.ts is stale vs the Go contract (CI drift guard)
ts-contract-check: ts-contract
	git diff --exit-code $(FRONTEND_DIR)/src/generated/topology.gen.ts

.PHONY: ui-build
HELP_ui-build := Build the React SPA into frontend/dist/
ui-build: ts-contract
	$(FRONTEND) build

.PHONY: ui-embed
HELP_ui-embed := Build and copy the React SPA into the Go embed directory
ui-embed: ui-build
	mkdir -p "$(EMBED_DIR)"
	find "$(EMBED_DIR)" -mindepth 1 ! -name '.keep' ! -name '.gitignore' -exec rm -rf {} +
	cp -R $(FRONTEND_DIR)/dist/. "$(EMBED_DIR)/"

.PHONY: operator-build
HELP_operator-build := Build the embedded Go operator binary (vars: GOOS, GOARCH, CGO_ENABLED)
operator-build: ui-embed
	GOOS=$(GOOS) GOARCH=$(GOARCH) CGO_ENABLED=$(CGO_ENABLED) go -C "$(APP_DIR)" build -a -trimpath -ldflags "-s -w" -o "$(OPERATOR_BIN)" "./operators/$(OPERATOR)/cmd"

.PHONY: operator-build-dev
HELP_operator-build-dev := Fast incremental Go build for dev hot-reload (no -a; stripped; assumes embed populated)
operator-build-dev:
	GOOS=$(GOOS) GOARCH=$(GOARCH) CGO_ENABLED=$(CGO_ENABLED) go -C "$(APP_DIR)" build -ldflags "-s -w" -o "$(OPERATOR_BIN)" "./operators/$(OPERATOR)/cmd"

.PHONY: binary
HELP_binary := Alias for operator-build
binary: operator-build

.PHONY: build
HELP_build := Build the SPA and embedded Go binary
build: operator-build

.PHONY: image
HELP_image := Build the runtime image locally (vars: IMAGE)
image:
	IMAGE="$(IMAGE)" ./scripts/build-image.sh

.PHONY: deploy-local
HELP_deploy-local := Build, push to the in-cluster dev registry, and deploy with edabuilder
deploy-local:
	./scripts/deploy-local.sh

.PHONY: check
HELP_check := Run lint, the contract-drift guard, Go tests, and a full embedded binary build
check: lint ts-contract-check test build

.PHONY: clean
HELP_clean := Remove generated frontend, embedded frontend, and operator build output
clean:
	rm -rf $(FRONTEND_DIR)/dist "$(APP_DIR)/build"
	find "$(EMBED_DIR)" -mindepth 1 ! -name '.keep' ! -name '.gitignore' -exec rm -rf {} +
