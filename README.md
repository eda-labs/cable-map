# Cable Map

Cable Map is a standalone React/Express application packaged as an EDA app.
The runtime keeps the original cable-map experience: topology canvas, tables,
front-panel view, and export/API endpoints. EDA installs the runtime as an
in-cluster service and exposes it through the EDA HTTP proxy.

## Repository Layout

- `src/`, `server.ts`, `eda.ts`: Cable Map web UI and server.
- `Dockerfile`: Runtime image for the in-cluster service.
- `eda-app/PROJECT`: EDA Builder project metadata.
- `eda-app/cable_map/manifest.yaml`: EDA app manifest.
- `eda-app/cable_map/resources/`: Kubernetes resources installed by EDA.
- `eda-app/cable_map/ui/`: Native EDA launcher view.
- `eda-app/cable_map/docs/`: App catalog documentation.

This repository intentionally does not keep the generated EDA CRD/script
scaffold. The app does not define EDA APIs or custom script handlers; it only
installs Kubernetes resources and a launcher view.

## Local Development

```sh
pnpm install
pnpm dev
```

For a production build:

```sh
pnpm build
pnpm build:server
pnpm start
```

## Runtime Image

Build and publish the runtime image first, because the EDA app manifest
references it as a dependency:

```sh
docker build -t ghcr.io/eda-labs/cable-map-runtime:v0.1.0 .
docker push ghcr.io/eda-labs/cable-map-runtime:v0.1.0
```

## EDA App Package

From `eda-app/`, publish the EDA app artifact into the catalog with
`edabuilder`:

```sh
edabuilder release https://github.com/<github-user>/catalog.git \
  --git-branch main \
  --clone-location /tmp/cable-map-release \
  --app manifest=cable_map/manifest.yaml,context=.,version=v0.1.0,image=ghcr.io/eda-labs/cable-map:v0.1.0
```

The app installs:

- a service account
- a deployment running the runtime image
- a ClusterIP service on port 8080
- an EDA `HttpProxy` named `cable-map` with `authType: atDestination`
- an EDA launcher card under `Topology > Cable Map`

The browser entrypoint is relative to the EDA host:

```text
/core/httpproxy/v1/cable-map/
```
