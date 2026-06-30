# Cable Map

Cable Map is an **EDA operator app**. A single Go binary (built with the EDA EDK)
streams `toponode`/`topolink`/`interface` state from the EDA **State Aggregator** over
gRPC/mTLS and serves the React + React-Flow UI — topology canvas, front-panel view,
cable tables, xlsx and PDF export. EDA installs it as an in-cluster service and exposes
it through the EDA HTTP proxy.

It is read-only: there is no CRD and no reconciler — the operator scaffold is used purely
to package the app the EDA-native way (EDK wiring, build tooling, container baked into the
single OCI app image).

## Repository layout

- `cable_map/` — the `edabuilder` project app:
  - `frontend/` — the React SPA (`src/`, `index.html`, `vite.config.ts`, `package.json`); built and `go:embed`-ed into the operator.
  - `operators/cable-map/cmd/main.go` — operator entrypoint (EDK + HTTP server).
  - `operators/cable-map/internal/topology` — pure topology derivation (+ tests).
  - `operators/cable-map/internal/eda` — EDK state streams (`pkg/cr` + `pkg/state`).
  - `operators/cable-map/internal/server` — JSON/SSE API, embedded SPA (`go:embed`), PDF.
  - `operators/cable-map/Dockerfile` — runtime image (binary + Chromium for PDF).
  - `operators/cable-map/config/` — Deployment (with EDA internal-cert mounts), Service, HttpProxy.
  - `ui/cable-map-dashboard.json` — EDA launcher view.
  - `manifest.yaml` — app manifest; bakes the runtime container as a `dependencies.container`.
- `scripts/build-image.sh` — build the runtime image (SPA embedded) locally.
- `scripts/deploy-local.sh` — local dev deploy to the in-cluster EDA dev target.

## Prerequisites

- Go ≥ 1.26.4 (the workspace pins this; `go.work` / `go.mod` use it).
- The EDK (`eda.dev/edk`, a vanity path → `github.com/nokia-eda/edk`) is fetched directly from
  GitHub. Requires access to that private repo: `gh auth setup-git` (or SSH/`.netrc`) so `go` can
  clone it, and `go env -w GOPRIVATE=eda.dev/edk` the first time the version is bumped.
- `pnpm`, `docker`, `kubectl`, `edabuilder`.
- `typst` on `PATH` for PDF export from the Vite mock dev server, or set `TYPST_BIN=/path/to/typst`.
  The runtime image downloads Typst during `make image`.

## Local development (frontend)

The SPA lives in `cable_map/frontend/`. From the repo root:

```sh
pnpm -C cable_map/frontend install
make dev        # Vite dev server; /api is mocked from the golden topology fixture
```

The Go backend only returns live data inside the cluster (it needs the EDA internal
certs). Use `make dev` for UI work against the built-in mock topology; `/pdf`
renders that mock topology locally with Typst. To proxy to a real backend instead,
run with `EDA_API=http://host:port make dev`.

## Common commands

```sh
make help           # show project-level and generated EDA targets
make build          # vite build -> embed SPA -> build Go operator binary
make binary         # alias for the embedded Go operator binary build
make image          # build the local runtime image
make deploy-local   # build, push to the in-cluster dev registry, and edabuilder deploy
make check          # lint, Go tests, and full embedded binary build
```

## Build the runtime image

```sh
make image                         # vite build -> embed -> go build -> docker build
make image IMAGE=myrepo/cable-map:dev
```

## Local EDA dev deploy

```sh
make deploy-local
```

This builds the operator image with the SPA embedded, pushes it to the in-cluster
`edabuilder` dev registry, and runs `edabuilder deploy` from a temp manifest pointing at
that image. Nothing is pushed to GitHub/ghcr. The committed `manifest.yaml` keeps the
`ghcr.io/eda-labs/...` reference for publishing.

The app installs a ServiceAccount, a Deployment (runtime image + cert-manager CSI +
`eda-internal-trust-bundle` mounts), named-secret RBAC for EDA SSO, a read-only
`cable-map-viewer` EDA ClusterRole, a ClusterIP Service on 8080, an `HttpProxy`
(`authType: atDestination`), and a launcher card under **Topology → Cable Map**. The
browser entrypoint, relative to the EDA host, is:

```text
/core/httpproxy/v1/cable-map/
```

Cable Map uses EDA Keycloak SSO at the destination. The SPA uses `keycloak-js`
with EDA's public browser client (`auth`) to silently obtain a per-tab access
token from the existing EDA SSO browser session, then exchanges it with the
backend for an HTTP-only Cable Map session cookie. The backend validates tokens
with the confidential `eda` client secret. The default allowed roles are
`cable-map-viewer,system-administrator`, so the built-in EDA administrator role
can open it immediately and non-admin users can be granted the dedicated viewer
role.

## Tests

```sh
make test                           # topology port + JSON-contract round-trip vs fake-topology.json
```
