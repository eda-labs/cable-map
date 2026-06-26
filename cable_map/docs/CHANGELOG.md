# Changelog

## v0.1.2

- Gate Cable Map data access, streams, and PDF export behind EDA Keycloak SSO.
- Use keycloak-js silent SSO so users already signed into EDA get a per-tab
  token without another credential prompt.
- Use EDA's public `auth` browser client and `/core/proxy/v1/identity` endpoint
  for keycloak-js, while keeping backend validation on the confidential `eda`
  client.
- Serve the silent SSO callback script as a same-origin asset so the strict
  `script-src 'self'` CSP does not block login completion.
- Allow `system-administrator` by default and add a dedicated read-only
  `cable-map-viewer` EDA ClusterRole for non-admin users.
- Add named-secret RBAC for the Keycloak client secret and EDA API CA bundle.

## v0.1.1

- Refresh the Cable Map app and runtime image tags for the v0.1.1 release.

## v0.1.0

- Package Cable Map as an EDA app with an embedded runtime container.
- Install ServiceAccount, RBAC, Deployment, internal Service, HttpProxy, and an
  EDA launcher view.
- Launch the UI through the same-origin EDA HTTP proxy path
  `/core/httpproxy/v1/cable-map/`.
- Configure `HttpProxy/cable-map` with `authType: atDestination`.
- Keep the app free of public NodePort services and EDA API/UI service patches.
