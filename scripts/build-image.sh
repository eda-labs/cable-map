#!/usr/bin/env bash
# Build the cable-map operator OCI runtime image locally (no push).
#
# Pipeline: vite build -> sync SPA into the operator's go:embed dir -> build the static
# operator binary (SPA baked in) -> docker build the runtime image (Typst for /pdf).
# The image is referenced by the app manifest as a dependencies.container, so `edabuilder`
# bakes it into the single OCI app image at deploy/publish time.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
IMAGE="${IMAGE:-ghcr.io/eda-labs/cable-map/operators/cable-map:dev}"
FRONTEND="cable_map/frontend"
EMBED="cable_map/operators/cable-map/internal/server/dist"
export GOTOOLCHAIN=auto

echo "==> [1/4] vite build"
pnpm -C "$FRONTEND" build

echo "==> [2/4] sync SPA into ${EMBED} (front-panel SVGs are not in public/ — operator serves them from /stencils)"
mkdir -p "$EMBED"
find "$EMBED" -mindepth 1 ! -name '.keep' ! -name '.gitignore' -exec rm -rf {} +
cp -r "$FRONTEND/dist/." "$EMBED/"

echo "==> [3/4] build operator binary (SPA embedded, front-panel stencils external)"
make cable_map-cable-map-build

# The Dockerfile COPYs operators/cable-map/frontpanel -> /stencils directly (a cached layer); the
# operator serves it at /frontpanel/*. No staging needed — the stencils live in the build context.
echo "==> [4/4] docker build ${IMAGE} (no push)"
# Pin linux/amd64: the Go binary is cross-compiled to GOARCH=amd64, so the base image (alpine + the
# typst x86_64 binary) must match the cluster nodes too — otherwise an arm64 host (Apple Silicon)
# bakes an arm64 base around an amd64 binary, and sh/typst fail with "exec format error" on amd64.
docker build --platform linux/amd64 -f cable_map/operators/cable-map/Dockerfile -t "$IMAGE" cable_map

echo "Done: ${IMAGE}"
