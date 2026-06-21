# Cable Map

Cable Map installs a small in-cluster web service that renders EDA topology
links as a cable map with node front-panel detail and PDF export.

The service is exposed through the EDA API server at:

```text
/core/httpproxy/v1/cable-map/
```

The runtime reads `TopoNode`, `TopoLink`, and `Interface` resources from the EDA
namespace using its Kubernetes service account.
