# Support

For issues with the Cable Map EDA app, collect:

- `kubectl -n eda-system logs deploy/cable-map`
- `kubectl -n eda-system get httpproxy cable-map -o yaml`
- `kubectl -n eda-system get svc cable-map -o wide`
- `kubectl -n eda-system get deploy cable-map -o wide`
- `kubectl -n eda-system get role,rolebinding cable-map-auth -o yaml`
- `kubectl -n eda-system get clusterroles.core.eda.nokia.com cable-map-viewer -o yaml`
- the failing browser URL under `/core/httpproxy/v1/cable-map/`

Expected production shape:

- `HttpProxy/cable-map` uses `authType: atDestination`.
- `HttpProxy/cable-map` points to `http://cable-map.<EDA_BASE_NAMESPACE>.svc:8080/`.
- `Deployment/cable-map` has `ALLOWED_ROLES` defaulting to `cable-map-viewer,system-administrator`.
- `Role/cable-map-auth` allows only `get` on `keycloak-admin-secret` and `eda-api-ca`.
- EDA `ClusterRole/cable-map-viewer` grants read-only URL/table/resource access for Cable Map.
- The UI shell is reachable without a Cable Map session; `/api/*` and `/pdf`
  require the backend session cookie created after the keycloak-js token exchange.
- `Service/cable-map` is internal-only on port `8080`.
- No `Service/cable-map-public` is installed by the app.
- EDA `eda-api` and `try-eda` services keep their stock apiserver selectors.
