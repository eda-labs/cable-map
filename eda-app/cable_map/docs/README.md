# Cable Map

Cable Map installs an in-cluster web service that renders live EDA topology
links as a cable map with node front-panel detail, cable tables, and PDF export.

The browser entry point is the EDA API server HTTP proxy:

```text
/core/httpproxy/v1/cable-map/
```

The EDA navigation entry opens that same-origin path from a stock launcher card.
The app metadata intentionally uses a relative URL, so it works with the
actual EDA hostname used in each environment.

The runtime reads `TopoNode`, `TopoLink`, and `Interface` resources from the EDA
namespace using its Kubernetes service account.

Installed resources:

- `ServiceAccount`, `ClusterRole`, and `ClusterRoleBinding` for read-only EDA
  resource access.
- `Deployment` named `cable-map`.
- Internal `Service` named `cable-map` on port `8080`.
- EDA `HttpProxy` named `cable-map` with `authType: atDestination`.
- EDA launcher view under `Topology > Cable Map`.

The app does not install a public `NodePort`, `LoadBalancer`, or patched EDA UI
proxy.
