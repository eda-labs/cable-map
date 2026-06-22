#!/usr/bin/env bash
# Local dev deploy of the cable-map EDA operator app to the in-cluster dev target,
# using a locally-built operator image. Nothing is pushed to GitHub/ghcr.
#
# Flow (the EDA-native equivalent of the old `pnpm deploy:eda:local`):
#   1. build the operator image with the SPA embedded (scripts/build-image.sh)
#   2. push it to the in-cluster edabuilder dev registry (via a port-forward)
#   3. edabuilder deploy from a temp manifest whose container dependency points at that
#      dev-registry image, so edabuilder bakes it into the single OCI app image and installs.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

FWD_PORT="${FWD_PORT:-15055}"
PUSH_IMAGE="localhost:${FWD_PORT}/eda-labs/cable-map/operators/cable-map:dev"
# How edabuilder/the cluster resolve the same registry when baking the app image:
DEP_IMAGE="edabuilder-in-cluster-dev-registry:5555/eda-labs/cable-map/operators/cable-map:dev"

echo "==> build operator image (SPA embedded)"
IMAGE="$PUSH_IMAGE" ./scripts/build-image.sh

echo "==> port-forward dev registry (localhost:${FWD_PORT})"
kubectl -n eda-system port-forward svc/edabuilder-in-cluster-dev-registry "${FWD_PORT}:5555" >/tmp/cable-map-regfwd.log 2>&1 &
FWD=$!
TMP="$(mktemp -d)"
trap 'kill "$FWD" 2>/dev/null || true; rm -rf "$TMP" 2>/dev/null || true' EXIT
for _ in $(seq 1 80); do curl -sf "http://localhost:${FWD_PORT}/v2/" >/dev/null 2>&1 && break; sleep 0.25; done

echo "==> push operator image to dev registry"
docker push "$PUSH_IMAGE"

echo "==> edabuilder deploy (in-cluster target)"
sed "s#image: ghcr.io/eda-labs/cable-map/operators/cable-map:latest#image: ${DEP_IMAGE}#" \
  cable_map/manifest.yaml > "$TMP/manifest.yaml"
edabuilder deploy --app "manifest=${TMP}/manifest.yaml,context=${ROOT}" --skip-generate --verbose

echo "Done. Open the EDA UI -> Topology -> Cable Map (served via /core/httpproxy/v1/cable-map/)."
