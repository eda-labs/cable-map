package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func newTestAuth() *authManager {
	return &authManager{
		namespace:  "eda-system",
		signingKey: []byte("01234567890123456789012345678901"),
	}
}

func TestAuthMiddlewarePublicHealthz(t *testing.T) {
	t.Setenv("ALLOWED_ROLES", defaultAllowedRoles)
	auth := newTestAuth()
	wrapped := auth.wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/healthz" {
			t.Fatalf("unexpected path %q", r.URL.Path)
		}
		w.WriteHeader(http.StatusNoContent)
	}))

	rr := httptest.NewRecorder()
	wrapped.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "https://eda.example/healthz", nil))
	if rr.Code != http.StatusNoContent {
		t.Fatalf("status=%d want %d", rr.Code, http.StatusNoContent)
	}
}

func TestAuthMiddlewareUnauthenticatedAPI(t *testing.T) {
	auth := newTestAuth()
	wrapped := auth.wrap(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("handler should not run")
	}))

	rr := httptest.NewRecorder()
	wrapped.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "https://eda.example/api/topology", nil))
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d want %d", rr.Code, http.StatusUnauthorized)
	}
	if !strings.Contains(rr.Body.String(), "not authenticated") {
		t.Fatalf("body=%q, want not authenticated", rr.Body.String())
	}
}

func TestAuthMiddlewareUnauthenticatedUILoadsShell(t *testing.T) {
	auth := newTestAuth()
	wrapped := auth.wrap(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
	}))

	rr := httptest.NewRecorder()
	wrapped.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "https://eda.example/", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d want %d", rr.Code, http.StatusOK)
	}
}

func TestAuthMiddlewareUnauthenticatedPDFRedirectsToKeycloak(t *testing.T) {
	auth := newTestAuth()
	wrapped := auth.wrap(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("handler should not run")
	}))
	req := httptest.NewRequest(http.MethodGet, "https://eda.example/", nil)
	req.URL.Path = "/pdf"
	req.Header.Set("X-Forwarded-Host", "eda.example")
	req.Header.Set("X-Forwarded-Proto", "https")

	rr := httptest.NewRecorder()
	wrapped.ServeHTTP(rr, req)
	if rr.Code != http.StatusFound {
		t.Fatalf("status=%d want %d", rr.Code, http.StatusFound)
	}
	location := rr.Header().Get("Location")
	if !strings.HasPrefix(location, "https://eda.example/core/httpproxy/v1/keycloak/realms/eda/protocol/openid-connect/auth?") {
		t.Fatalf("redirect location=%q", location)
	}
	if !strings.Contains(location, "redirect_uri=https%3A%2F%2Feda.example%2Fcore%2Fhttpproxy%2Fv1%2Fcable-map%2Foauth%2Fcallback") {
		t.Fatalf("redirect location missing callback: %q", location)
	}
	if got := rr.Result().Cookies(); len(got) != 1 || got[0].Name != stateCookieName {
		t.Fatalf("cookies=%v, want state cookie", got)
	}
}

func TestAuthMiddlewareValidSessionPasses(t *testing.T) {
	auth := newTestAuth()
	session, err := auth.makeSession("admin")
	if err != nil {
		t.Fatal(err)
	}
	wrapped := auth.wrap(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusAccepted)
	}))
	req := httptest.NewRequest(http.MethodGet, "https://eda.example/api/topology", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: session})

	rr := httptest.NewRecorder()
	wrapped.ServeHTTP(rr, req)
	if rr.Code != http.StatusAccepted {
		t.Fatalf("status=%d want %d", rr.Code, http.StatusAccepted)
	}
}

func TestAuthMiddlewareDisabledPasses(t *testing.T) {
	t.Setenv("CABLE_MAP_DISABLE_AUTH", "1")
	auth := newTestAuth()
	wrapped := auth.wrap(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusAccepted)
	}))

	rr := httptest.NewRecorder()
	wrapped.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "https://eda.example/api/topology", nil))
	if rr.Code != http.StatusAccepted {
		t.Fatalf("status=%d want %d", rr.Code, http.StatusAccepted)
	}
}

func TestSessionValidation(t *testing.T) {
	auth := newTestAuth()
	session, err := auth.makeSession("admin")
	if err != nil {
		t.Fatal(err)
	}
	if got := auth.verifySession(session); got != "admin" {
		t.Fatalf("valid session user=%q want admin", got)
	}
	if got := auth.verifySession(session + "x"); got != "" {
		t.Fatalf("tampered session user=%q want empty", got)
	}
	expired, err := auth.makeSessionWithExpiry("admin", time.Now().Add(-time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	if got := auth.verifySession(expired); got != "" {
		t.Fatalf("expired session user=%q want empty", got)
	}
}

func TestRoleMatching(t *testing.T) {
	t.Setenv("ALLOWED_ROLES", "cable-map-viewer,system-administrator")
	auth := newTestAuth()
	for _, roles := range [][]string{
		{"cable-map-viewer"},
		{"edarole_cable-map-viewer"},
		{"system-administrator"},
		{"edarole_system-administrator"},
	} {
		if !auth.isAllowed(roles) {
			t.Fatalf("roles %v should be allowed", roles)
		}
	}
	if auth.isAllowed([]string{"fabric-viewer"}) {
		t.Fatal("unrelated role should not be allowed")
	}
}

func TestTokenIdentity(t *testing.T) {
	token := testJWT("admin", []string{"edarole_system-administrator"}, time.Now().Add(time.Hour))
	user, roles := tokenIdentity(map[string]any{"access_token": token})
	if user != "admin" {
		t.Fatalf("user=%q want admin", user)
	}
	if len(roles) != 1 || roles[0] != "edarole_system-administrator" {
		t.Fatalf("roles=%v", roles)
	}

	expired := testJWT("admin", []string{"edarole_system-administrator"}, time.Now().Add(-time.Hour))
	user, roles = tokenIdentity(map[string]any{"access_token": expired})
	if user != "" || roles != nil {
		t.Fatalf("expired user=%q roles=%v, want empty", user, roles)
	}
}

func TestCallbackAllowsAdminAndSetsSession(t *testing.T) {
	t.Setenv("ALLOWED_ROLES", "cable-map-viewer,system-administrator")
	auth := newTestAuth()
	auth.exchangeCodeFunc = func(_ context.Context, code string, _ *http.Request) (map[string]any, error) {
		if code != "abc" {
			t.Fatalf("code=%q want abc", code)
		}
		return map[string]any{
			"access_token": testJWT("admin", []string{"edarole_system-administrator"}, time.Now().Add(time.Hour)),
		}, nil
	}

	req := httptest.NewRequest(http.MethodGet, "https://eda.example/oauth/callback?code=abc&state=s1", nil)
	req.AddCookie(&http.Cookie{Name: stateCookieName, Value: "s1"})
	rr := httptest.NewRecorder()
	auth.handleCallback(rr, req)
	if rr.Code != http.StatusFound {
		t.Fatalf("status=%d want %d body=%q", rr.Code, http.StatusFound, rr.Body.String())
	}
	if rr.Header().Get("Location") != appProxyPrefix+"/" {
		t.Fatalf("location=%q", rr.Header().Get("Location"))
	}
	var sawSession bool
	for _, c := range rr.Result().Cookies() {
		if c.Name == sessionCookieName {
			sawSession = true
			if got := auth.verifySession(c.Value); got != "admin" {
				t.Fatalf("session user=%q want admin", got)
			}
		}
	}
	if !sawSession {
		t.Fatal("callback did not set session cookie")
	}
}

func TestCallbackDeniesUnrelatedRole(t *testing.T) {
	t.Setenv("ALLOWED_ROLES", "cable-map-viewer,system-administrator")
	auth := newTestAuth()
	auth.exchangeCodeFunc = func(context.Context, string, *http.Request) (map[string]any, error) {
		return map[string]any{
			"access_token": testJWT("viewer", []string{"fabric-viewer"}, time.Now().Add(time.Hour)),
		}, nil
	}

	req := httptest.NewRequest(http.MethodGet, "https://eda.example/oauth/callback?code=abc&state=s1", nil)
	req.AddCookie(&http.Cookie{Name: stateCookieName, Value: "s1"})
	rr := httptest.NewRecorder()
	auth.handleCallback(rr, req)
	if rr.Code != http.StatusForbidden {
		t.Fatalf("status=%d want %d", rr.Code, http.StatusForbidden)
	}
	if strings.Contains(rr.Header().Get("Set-Cookie"), sessionCookieName) {
		t.Fatal("denied callback should not set session cookie")
	}
}

func TestSessionStatus(t *testing.T) {
	auth := newTestAuth()

	rr := httptest.NewRecorder()
	auth.handleSession(rr, httptest.NewRequest(http.MethodGet, "https://eda.example/oauth/session", nil))
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d want %d", rr.Code, http.StatusUnauthorized)
	}

	session, err := auth.makeSession("admin")
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "https://eda.example/oauth/session", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: session})
	rr = httptest.NewRecorder()
	auth.handleSession(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d want %d", rr.Code, http.StatusOK)
	}
}

func TestSessionExchangeAllowsAdmin(t *testing.T) {
	t.Setenv("ALLOWED_ROLES", "cable-map-viewer,system-administrator")
	auth := newTestAuth()
	req := httptest.NewRequest(http.MethodPost, "https://eda.example/oauth/session", nil)
	authToken := testJWT("admin", []string{"edarole_system-administrator"}, time.Now().Add(time.Hour))
	req.Header.Set("Authorization", "Bearer "+authToken)
	auth.introspectTokenFunc = func(_ context.Context, token string) (map[string]any, error) {
		if token != authToken {
			t.Fatalf("token mismatch")
		}
		return map[string]any{"active": true}, nil
	}

	rr := httptest.NewRecorder()
	auth.handleSession(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("status=%d want %d body=%q", rr.Code, http.StatusOK, rr.Body.String())
	}
	var sawSession bool
	for _, c := range rr.Result().Cookies() {
		if c.Name == sessionCookieName {
			sawSession = true
			if got := auth.verifySession(c.Value); got != "admin" {
				t.Fatalf("session user=%q want admin", got)
			}
		}
	}
	if !sawSession {
		t.Fatal("session exchange did not set session cookie")
	}
}

func TestSessionExchangeDeniesInactiveToken(t *testing.T) {
	auth := newTestAuth()
	auth.introspectTokenFunc = func(context.Context, string) (map[string]any, error) {
		return map[string]any{"active": false}, nil
	}
	req := httptest.NewRequest(http.MethodPost, "https://eda.example/oauth/session", nil)
	req.Header.Set("Authorization", "Bearer "+testJWT("admin", []string{"edarole_system-administrator"}, time.Now().Add(time.Hour)))

	rr := httptest.NewRecorder()
	auth.handleSession(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d want %d", rr.Code, http.StatusUnauthorized)
	}
}

func TestExternalBase(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "http://internal/", nil)
	req.Header.Set("X-Forwarded-Host", "eda.example, proxy.local")
	req.Header.Set("X-Forwarded-Proto", "https")
	if got := externalBase(req); got != "https://eda.example" {
		t.Fatalf("externalBase=%q", got)
	}
	t.Setenv("EXTERNAL_URL", "https://override.example/")
	if got := externalBase(req); got != "https://override.example" {
		t.Fatalf("externalBase override=%q", got)
	}
}

func testJWT(username string, roles []string, exp time.Time) string {
	header := map[string]any{"alg": "none", "typ": "JWT"}
	payload := map[string]any{
		"preferred_username": username,
		"sub":                username,
		"exp":                exp.Unix(),
		"realm_access": map[string]any{
			"roles": roles,
		},
	}
	return encodeJWTPart(header) + "." + encodeJWTPart(payload) + "."
}

func encodeJWTPart(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
