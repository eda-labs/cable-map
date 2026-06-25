# Cable Map

-{{% import 'icons.html' as icons %}}-

| <nbsp> {: .hide-th } |                                             |
| -------------------- | ------------------------------------------- |
| **Group/Version**    | -{{ app_group }}-/-{{ app_api_version }}-   |
| **Catalog**          | [eda-labs/catalog/cable-map][manifest]      |
| **Source Code**      | [eda-labs/cable-map][source]                |

[manifest]: https://github.com/eda-labs/catalog/tree/main/apps/cable-map.eda.labs
[source]: https://github.com/eda-labs/cable-map

Cable Map renders the live EDA physical topology as a cable map. Select a node
to open front-panel detail, cable tables, and PDF export.

## Access

Open Cable Map from `Topology > Cable Map` in the EDA UI. The entry shows a
launcher card whose `View` action opens the proxied Cable Map UI.

The launch path is same-origin and relative:

```text
/core/httpproxy/v1/cable-map/
```

Do not hardcode the EDA hostname, lab loopback address, or API-server port in
app metadata. EDA resolves this path against the current UI origin.

The application installs:

- a `cable-map` Deployment and Service in `eda-system`
- RBAC allowing the service to read EDA topology and interface resources
- an EDA `HttpProxy` at `/core/httpproxy/v1/cable-map/` with
  `authType: atDestination`
- a launcher view under `Topology > Cable Map`

The `cable-map` Service is internal-only on port `8080`. The app does not
install a public `NodePort` service or patch the EDA API/UI services.

## Verification

Use the actual EDA origin for your environment:

```sh
curl -k https://<eda-origin>/core/httpproxy/v1/cable-map/
curl -k https://<eda-origin>/core/httpproxy/v1/cable-map/api/topology
kubectl -n eda-system get httpproxy cable-map -o yaml
kubectl -n eda-system get svc cable-map -o wide
```

The proxy should point at:

```yaml
spec:
  authType: atDestination
  rootUrl: http://cable-map.${EDA_BASE_NAMESPACE}.svc:8080/
```
