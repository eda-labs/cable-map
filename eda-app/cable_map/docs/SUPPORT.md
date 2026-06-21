# Support

For issues with the Cable Map EDA app, collect:

- `kubectl -n eda-system logs deploy/cable-map`
- `kubectl -n eda-system get httpproxy cable-map -o yaml`
- the failing browser URL under `/core/httpproxy/v1/cable-map/`
