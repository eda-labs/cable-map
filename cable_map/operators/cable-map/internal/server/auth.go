package server

// Stateless auth: the EDA HttpProxy runs in `atDestination` mode, so the proxy forwards the document
// load unauthenticated (letting the SPA boot) and forwards the keycloak-js bearer token "as is" on
// API calls. We validate that token against EDA's JWKS — signature + expiry + an allowed realm role —
// with no confidential client, introspection, session store, or role provisioning.

import (
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const (
	identityPath        = "/core/proxy/v1/identity"
	authRealm           = "eda"
	edaAPICACertPath    = "/var/run/eda/tls/eda-api/ca.crt" // mounted from the eda-api-ca secret
	defaultAllowedRoles = "cable-map-viewer,system-administrator"
)

type authManager struct {
	disabled bool
	jwksURL  string
	client   *http.Client
	allowed  []string

	mu        sync.RWMutex
	keys      map[string]*rsa.PublicKey
	refreshed time.Time
}

func newAuthManager() *authManager {
	a := &authManager{
		disabled: os.Getenv("CABLE_MAP_DISABLE_AUTH") != "" || os.Getenv("CABLEMAP_DISABLE_AUTH") != "",
		allowed:  splitRoles(envOr("ALLOWED_ROLES", defaultAllowedRoles)),
		keys:     map[string]*rsa.PublicKey{},
	}
	ns := envOr("POD_NAMESPACE", "eda-system")
	a.jwksURL = "https://eda-api." + ns + ".svc" + identityPath + "/realms/" + authRealm + "/protocol/openid-connect/certs"
	a.client = &http.Client{Timeout: 10 * time.Second, Transport: &http.Transport{TLSClientConfig: edaAPITLS()}}
	return a
}

func (a *authManager) enabled() bool { return !a.disabled }

// edaAPITLS trusts the mounted eda-api CA so JWKS fetches from eda-api.<ns>.svc verify; falls back to
// the system pool if the CA isn't mounted (e.g. auth disabled in local dev).
func edaAPITLS() *tls.Config {
	pool, _ := x509.SystemCertPool()
	if pool == nil {
		pool = x509.NewCertPool()
	}
	if pem, err := os.ReadFile(edaAPICACertPath); err == nil {
		pool.AppendCertsFromPEM(pem)
	}
	return &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
}

// wrap gates /api/* and /pdf with a valid EDA bearer token. The SPA, /healthz and other static paths
// stay public — the document must load unauthenticated so keycloak-js can run and obtain a token.
// Loopback requests (the operator's own chromedp /pdf render hitting 127.0.0.1) are exempt.
func (a *authManager) wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !a.enabled() || !protectedPath(r.URL.Path) || isLoopback(r) {
			next.ServeHTTP(w, r)
			return
		}
		if a.authenticate(r) {
			next.ServeHTTP(w, r)
			return
		}
		writeJSON(w, http.StatusUnauthorized, map[string]any{"ok": false, "error": "not authenticated"})
	})
}

func protectedPath(p string) bool {
	return p == "/pdf" || p == "/api" || strings.HasPrefix(p, "/api/")
}

func isLoopback(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// authenticate verifies the request's bearer token (Authorization header, or the ?access_token= query
// param that SSE EventSource must use since it can't set headers) against EDA's JWKS, and checks it
// carries an allowed role.
func (a *authManager) authenticate(r *http.Request) bool {
	tok := bearerToken(r.Header.Get("Authorization"))
	if tok == "" {
		tok = r.URL.Query().Get("access_token")
	}
	if tok == "" {
		return false
	}
	claims := jwt.MapClaims{}
	if _, err := jwt.ParseWithClaims(tok, claims, a.keyfunc, jwt.WithValidMethods([]string{"RS256"})); err != nil {
		return false
	}
	return a.isAllowed(rolesFromClaims(claims))
}

func (a *authManager) keyfunc(t *jwt.Token) (any, error) {
	kid, _ := t.Header["kid"].(string)
	if k := a.lookupKey(kid); k != nil {
		return k, nil
	}
	if err := a.refreshKeys(); err != nil { // unknown kid → keys may have rotated
		return nil, err
	}
	if k := a.lookupKey(kid); k != nil {
		return k, nil
	}
	return nil, fmt.Errorf("unknown signing key %q", kid)
}

func (a *authManager) lookupKey(kid string) *rsa.PublicKey {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.keys[kid]
}

// refreshKeys re-fetches the JWKS, rate-limited so an unknown/forged kid can't hammer keycloak.
func (a *authManager) refreshKeys() error {
	a.mu.Lock()
	if time.Since(a.refreshed) < 30*time.Second {
		a.mu.Unlock()
		return nil
	}
	a.refreshed = time.Now()
	a.mu.Unlock()

	resp, err := a.client.Get(a.jwksURL)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	var doc struct {
		Keys []struct{ Kid, Kty, N, E string } `json:"keys"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil {
		return err
	}
	keys := make(map[string]*rsa.PublicKey, len(doc.Keys))
	for _, k := range doc.Keys {
		if k.Kty != "RSA" {
			continue
		}
		if pk, err := rsaPublicKey(k.N, k.E); err == nil {
			keys[k.Kid] = pk
		}
	}
	a.mu.Lock()
	a.keys = keys
	a.mu.Unlock()
	return nil
}

func rsaPublicKey(nB64, eB64 string) (*rsa.PublicKey, error) {
	nb, err := base64.RawURLEncoding.DecodeString(nB64)
	if err != nil {
		return nil, err
	}
	eb, err := base64.RawURLEncoding.DecodeString(eB64)
	if err != nil {
		return nil, err
	}
	e := 0
	for _, b := range eb {
		e = e<<8 | int(b)
	}
	return &rsa.PublicKey{N: new(big.Int).SetBytes(nb), E: e}, nil
}

// isAllowed matches the token's realm roles against the allow-list, accepting either the bare role or
// its EDA `edarole_` prefixed form.
func (a *authManager) isAllowed(roles []string) bool {
	have := make(map[string]bool, len(roles))
	for _, r := range roles {
		have[r] = true
	}
	for _, want := range a.allowed {
		if have[want] || have["edarole_"+want] {
			return true
		}
		if strings.HasPrefix(want, "edarole_") && have[strings.TrimPrefix(want, "edarole_")] {
			return true
		}
	}
	return false
}

func rolesFromClaims(claims jwt.MapClaims) []string {
	realmAccess, _ := claims["realm_access"].(map[string]any)
	raw, _ := realmAccess["roles"].([]any)
	out := make([]string, 0, len(raw))
	for _, x := range raw {
		if s, ok := x.(string); ok && s != "" {
			out = append(out, s)
		}
	}
	return out
}

func bearerToken(header string) string {
	scheme, rest, ok := strings.Cut(header, " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") {
		return ""
	}
	return strings.TrimSpace(rest)
}

func splitRoles(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func envOr(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}
