#!/usr/bin/env bash
# Build the cable-map operator OCI runtime image locally (no push).
#
# Pipeline: vite build -> sync SPA into the operator's go:embed dir -> build the static
# operator binary (SPA baked in) -> docker build the runtime image (Chromium for /pdf).
# The image is referenced by the app manifest as a dependencies.container, so `edabuilder`
# bakes it into the single OCI app image at deploy/publish time.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
IMAGE="${IMAGE:-ghcr.io/eda-labs/cable-map/operators/cable-map:dev}"
EMBED="cable_map/operators/cable-map/internal/server/dist"
export GOTOOLCHAIN=auto

echo "==> [1/4] vite build"
pnpm build

echo "==> [2/4] sync SPA into ${EMBED}"
mkdir -p "$EMBED"
find "$EMBED" -mindepth 1 ! -name '.keep' ! -name '.gitignore' -exec rm -rf {} +
cp -r dist/. "$EMBED/"

echo "==> [3/4] build operator binary (SPA embedded)"
make cable_map-cable-map-build

echo "==> [4/4] docker build ${IMAGE} (no push)"
docker build -f cable_map/operators/cable-map/Dockerfile -t "$IMAGE" cable_map

echo "Done: ${IMAGE}"
