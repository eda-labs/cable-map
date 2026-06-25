# Support

For issues with the Cable Map EDA app, collect:

- `kubectl -n eda-system logs deploy/cable-map`
- `kubectl -n eda-system get httpproxy cable-map -o yaml`
- `kubectl -n eda-system get svc cable-map -o wide`
- `kubectl -n eda-system get deploy cable-map -o wide`
- the failing browser URL under `/core/httpproxy/v1/cable-map/`

Expected production shape:

- `HttpProxy/cable-map` uses `authType: atDestination`.
- `HttpProxy/cable-map` points to `http://cable-map.<EDA_BASE_NAMESPACE>.svc:8080/`.
- `Service/cable-map` is internal-only on port `8080`.
- No `Service/cable-map-public` is installed by the app.
- EDA `eda-api` and `try-eda` services keep their stock apiserver selectors.
