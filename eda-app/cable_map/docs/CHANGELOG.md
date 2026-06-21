# Changelog

## v0.1.0

- Package Cable Map as an EDA app with an embedded runtime container.
- Install ServiceAccount, RBAC, Deployment, internal Service, HttpProxy, and an
  EDA launcher view.
- Launch the UI through the same-origin EDA HTTP proxy path
  `/core/httpproxy/v1/cable-map/`.
- Configure `HttpProxy/cable-map` with `authType: atDestination`.
- Keep the app free of public NodePort services and EDA API/UI service patches.
