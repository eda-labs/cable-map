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
OPERATOR := cable-map
EMBED_DIR := $(APP_DIR)/operators/$(OPERATOR)/internal/server/dist
OPERATOR_BIN := build/operators/$(OPERATOR)/$(OPERATOR)
IMAGE ?= ghcr.io/eda-labs/cable-map/operators/cable-map:dev
GOOS ?= linux
GOARCH ?= amd64
CGO_ENABLED ?= 0

PROJECT_TARGETS += dev
PROJECT_TARGETS += preview
PROJECT_TARGETS += lint
PROJECT_TARGETS += ui-build
PROJECT_TARGETS += ui-embed
PROJECT_TARGETS += operator-build
PROJECT_TARGETS += binary
PROJECT_TARGETS += build
PROJECT_TARGETS += image
PROJECT_TARGETS += deploy-local
PROJECT_TARGETS += check
PROJECT_TARGETS += clean

.PHONY: dev
HELP_dev := Start the Vite dev server with mocked topology data
dev:
	$(PNPM) dev

.PHONY: preview
HELP_preview := Preview the production Vite build locally
preview:
	$(PNPM) preview

.PHONY: lint
HELP_lint := Run frontend lint checks
lint:
	$(PNPM) lint

.PHONY: ui-build
HELP_ui-build := Build the React SPA into dist/
ui-build:
	$(PNPM) build

.PHONY: ui-embed
HELP_ui-embed := Build and copy the React SPA into the Go embed directory
ui-embed: ui-build
	find "$(EMBED_DIR)" -mindepth 1 ! -name '.keep' ! -name '.gitignore' -exec rm -rf {} +
	cp -R dist/. "$(EMBED_DIR)/"

.PHONY: operator-build
HELP_operator-build := Build the embedded Go operator binary (vars: GOOS, GOARCH, CGO_ENABLED)
operator-build: ui-embed
	GOOS=$(GOOS) GOARCH=$(GOARCH) CGO_ENABLED=$(CGO_ENABLED) go -C "$(APP_DIR)" build -a -trimpath -ldflags "-s -w" -o "$(OPERATOR_BIN)" "./operators/$(OPERATOR)/cmd"

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
HELP_check := Run lint, Go tests, and a full embedded binary build
check: lint test build

.PHONY: clean
HELP_clean := Remove generated frontend, embedded frontend, and operator build output
clean:
	rm -rf dist "$(APP_DIR)/build"
	find "$(EMBED_DIR)" -mindepth 1 ! -name '.keep' ! -name '.gitignore' -exec rm -rf {} +
