# Cable Map

-{{% import 'icons.html' as icons %}}-

| <nbsp> {: .hide-th } |                                             |
| -------------------- | ------------------------------------------- |
| **Group/Version**    | -{{ app_group }}-/-{{ app_api_version }}-   |
| **Catalog**          | [eda-labs/catalog/cable-map][manifest]      |
| **Source Code**      | [eda-labs/cable-map][source]                |

[manifest]: https://github.com/FloSch62/catalog/tree/main/vendors/eda-labs/apps/cable-map
[source]: https://github.com/eda-labs/cable-map

Cable Map renders the live EDA physical topology as a cable map. Select a node
to open front-panel detail, cable tables, and PDF export.

The application installs:

- a `cable-map` Deployment and Service in `eda-system`
- RBAC allowing the service to read EDA topology and interface resources
- an EDA `HttpProxy` at `/core/httpproxy/v1/cable-map/`
- a dashboard entry under `Topology > Cable Map`
