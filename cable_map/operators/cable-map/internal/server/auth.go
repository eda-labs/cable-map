package server

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	edkkube "eda.dev/edk/pkg/utils/kubernetes"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

const (
	keycloakRealm     = "eda"
	keycloakClientID  = "eda"
	keycloakProxyPath = "/core/proxy/v1/identity"
	appProxyPrefix    = "/core/httpproxy/v1/cable-map"
	oauthCallbackPath = "/oauth/callback"

	sessionCookieName = "cm_session"
	stateCookieName   = "cm_oauth_state"
	sessionTTL        = 8 * time.Hour
	sessionCheckTTL   = 5 * time.Second
	httpTimeout       = 20 * time.Second

	allowedRolesEnv     = "ALLOWED_ROLES"
	defaultAllowedRoles = "cable-map-viewer,system-administrator"
	viewerRoleName      = "cable-map-viewer"
	viewerRealmRole     = "edarole_cable-map-viewer"
)

type authManager struct {
	namespace  string
	signingKey []byte

	kubeOnce sync.Once
	kube     kubernetes.Interface
	kubeErr  error

	mu           sync.Mutex
	tlsConfig    *tls.Config
	clientSecret string
	adminToken   string
	adminExpiry  time.Time
	sessions     map[string]*authSession

	exchangeCodeFunc    func(context.Context, string, *http.Request) (map[string]any, error)
	introspectTokenFunc func(context.Context, string) (map[string]any, error)
}

type authSession struct {
	user         string
	token        string
	externalBase string
	checkedAt    time.Time
}

type sessionPayload struct {
	User string `json:"u"`
	ID   string `json:"sid"`
	Exp  int64  `json:"exp"`
}

type statusError struct {
	code int
	body string
}

func (e *statusError) Error() string {
	return fmt.Sprintf("keycloak returned HTTP %d: %s", e.code, e.body)
}

func (e *statusError) statusCode() int {
	return e.code
}

func newAuthManager() *authManager {
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		panic(fmt.Sprintf("generate auth signing key: %v", err))
	}
	namespace := strings.TrimSpace(os.Getenv("POD_NAMESPACE"))
	if namespace == "" {
		namespace = "eda-system"
	}
	return &authManager{namespace: namespace, signingKey: key, sessions: map[string]*authSession{}}
}

func (a *authManager) enabled() bool {
	return os.Getenv("CABLE_MAP_DISABLE_AUTH") != "1" &&
		os.Getenv("CABLEMAP_DISABLE_AUTH") != "1"
}

func (a *authManager) wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !a.enabled() || publicAuthPath(r.URL.Path) || publicContentPath(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		if a.userFromRequest(r) != "" {
			next.ServeHTTP(w, r)
			return
		}
		a.clearSession(r)
		w.Header().Add("Set-Cookie", a.cookie(sessionCookieName, "", -1).String())
		if apiPath(r.URL.Path) {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"ok": false, "error": "not authenticated"})
			return
		}
		a.redirectToLogin(w, r)
	})
}

func publicAuthPath(path string) bool {
	return path == "/healthz" || path == "/oauth/login" ||
		path == "/oauth/callback" || path == "/oauth/logout" ||
		path == "/oauth/session"
}

func publicContentPath(path string) bool {
	return !apiPath(path) && path != "/pdf"
}

func apiPath(path string) bool {
	return path == "/api" || strings.HasPrefix(path, "/api/")
}

func (a *authManager) handleLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	a.redirectToLogin(w, r)
}

func (a *authManager) handleCallback(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	code := r.URL.Query().Get("code")
	state := r.URL.Query().Get("state")
	expected := a.cookieValue(r, stateCookieName)
	if code == "" || state == "" || expected == "" || state != expected {
		http.Error(w, "sign-in failed: invalid state", http.StatusBadRequest)
		return
	}
	token, err := a.exchangeCode(r.Context(), code, r)
	if err != nil {
		log.Printf("[auth] OIDC code exchange failed: %v", err)
		http.Error(w, "sign-in failed: could not complete authentication", http.StatusBadGateway)
		return
	}
	user, roles := tokenIdentity(token)
	if user == "" {
		http.Error(w, "sign-in failed: invalid token", http.StatusBadGateway)
		return
	}
	if !a.isAllowed(roles) {
		log.Printf("[auth] access denied: %s lacks allowed role (have=%v need-any-of=%v)", user, roles, a.allowedRoles())
		a.denyPage(w, user)
		return
	}
	accessToken, _ := token["access_token"].(string)
	session, err := a.issueSession(user, accessToken, r)
	if err != nil {
		log.Printf("[auth] session creation failed: %v", err)
		http.Error(w, "sign-in failed: could not create session", http.StatusInternalServerError)
		return
	}
	w.Header().Add("Set-Cookie", a.cookie(sessionCookieName, session, int(sessionTTL.Seconds())).String())
	w.Header().Add("Set-Cookie", a.cookie(stateCookieName, "", -1).String())
	http.Redirect(w, r, appProxyPrefix+"/", http.StatusFound)
}

func (a *authManager) handleLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	a.clearSession(r)
	w.Header().Add("Set-Cookie", a.cookie(sessionCookieName, "", -1).String())
	w.Header().Add("Set-Cookie", a.cookie(stateCookieName, "", -1).String())
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprintf(w, `<!doctype html><html><head><title>Signed out</title></head><body><h1>Signed out</h1><p>You are still signed in to EDA.</p><p><a href="%s/oauth/login">Sign in again</a></p></body></html>`, appProxyPrefix)
}

func (a *authManager) handleSession(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		if !a.enabled() || a.userFromRequest(r) != "" {
			writeJSON(w, http.StatusOK, map[string]any{"ok": true})
			return
		}
		a.clearSession(r)
		w.Header().Add("Set-Cookie", a.cookie(sessionCookieName, "", -1).String())
		writeJSON(w, http.StatusUnauthorized, map[string]any{"ok": false, "error": "not authenticated"})
	case http.MethodPost:
		if !a.enabled() {
			writeJSON(w, http.StatusOK, map[string]any{"ok": true})
			return
		}
		token := sessionExchangeToken(r)
		if token == "" {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"ok": false, "error": "missing bearer token"})
			return
		}
		user, roles, err := a.identityFromBearer(r.Context(), token, externalBase(r))
		if err != nil {
			log.Printf("[auth] bearer token validation failed: %v", err)
			writeJSON(w, http.StatusUnauthorized, map[string]any{"ok": false, "error": "invalid token"})
			return
		}
		if !a.isAllowed(roles) {
			log.Printf("[auth] access denied: %s lacks allowed role (have=%v need-any-of=%v)", user, roles, a.allowedRoles())
			writeJSON(w, http.StatusForbidden, map[string]any{"ok": false, "error": "access denied"})
			return
		}
		session, err := a.issueSession(user, token, r)
		if err != nil {
			log.Printf("[auth] session creation failed: %v", err)
			writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": "could not create session"})
			return
		}
		w.Header().Add("Set-Cookie", a.cookie(sessionCookieName, session, int(sessionTTL.Seconds())).String())
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "user": user})
	case http.MethodDelete:
		a.clearSession(r)
		w.Header().Add("Set-Cookie", a.cookie(sessionCookieName, "", -1).String())
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (a *authManager) redirectToLogin(w http.ResponseWriter, r *http.Request) {
	if !a.enabled() {
		http.Redirect(w, r, appProxyPrefix+"/", http.StatusFound)
		return
	}
	state := newState()
	authURL, err := a.authorizeURL(r, state)
	if err != nil {
		log.Printf("[auth] cannot build authorize URL: %v", err)
		http.Error(w, "sign-in is unavailable: cannot reach EDA Keycloak", http.StatusServiceUnavailable)
		return
	}
	w.Header().Add("Set-Cookie", a.cookie(stateCookieName, state, 600).String())
	http.Redirect(w, r, authURL, http.StatusFound)
}

func bearerToken(header string) string {
	scheme, token, ok := strings.Cut(strings.TrimSpace(header), " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") {
		return ""
	}
	return strings.TrimSpace(token)
}

func sessionExchangeToken(r *http.Request) string {
	if token := bearerToken(r.Header.Get("Authorization")); token != "" {
		return token
	}
	ct := strings.ToLower(strings.TrimSpace(strings.Split(r.Header.Get("Content-Type"), ";")[0]))
	switch ct {
	case "application/json":
		var payload struct {
			Token string `json:"token"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&payload); err == nil {
			return strings.TrimSpace(payload.Token)
		}
	case "application/x-www-form-urlencoded", "multipart/form-data":
		if err := r.ParseForm(); err == nil {
			return strings.TrimSpace(r.Form.Get("token"))
		}
	}
	return ""
}

func (a *authManager) denyPage(w http.ResponseWriter, user string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusForbidden)
	fmt.Fprintf(w, `<!doctype html><html><head><title>Access denied</title></head><body><h1>Access denied</h1><p>You are signed in to EDA as <b>%s</b>, but Cable Map requires one of these roles: <b>%s</b>.</p><p><a href="%s/oauth/logout">Sign out</a></p></body></html>`,
		htmlEscape(user), htmlEscape(strings.Join(a.allowedRoles(), ", ")), appProxyPrefix)
}

func (a *authManager) cookie(name, value string, maxAge int) *http.Cookie {
	c := &http.Cookie{
		Name:     name,
		Value:    value,
		Path:     appProxyPrefix,
		HttpOnly: true,
		Secure:   true,
		SameSite: http.SameSiteLaxMode,
	}
	if maxAge != 0 {
		c.MaxAge = maxAge
	}
	return c
}

func (a *authManager) cookieValue(r *http.Request, name string) string {
	c, err := r.Cookie(name)
	if err != nil {
		return ""
	}
	return c.Value
}

func (a *authManager) userFromRequest(r *http.Request) string {
	payload, ok := a.verifySessionPayload(a.cookieValue(r, sessionCookieName))
	if !ok {
		return ""
	}
	return a.activeSessionUser(r.Context(), payload)
}

func (a *authManager) allowedRoles() []string {
	raw := strings.TrimSpace(os.Getenv(allowedRolesEnv))
	if raw == "" {
		raw = defaultAllowedRoles
	}
	var out []string
	for _, part := range strings.Split(raw, ",") {
		if role := strings.TrimSpace(part); role != "" {
			out = append(out, role)
		}
	}
	if len(out) == 0 {
		return strings.Split(defaultAllowedRoles, ",")
	}
	return out
}

func (a *authManager) isAllowed(roles []string) bool {
	have := map[string]struct{}{}
	for _, role := range roles {
		role = strings.TrimSpace(role)
		if role != "" {
			have[role] = struct{}{}
		}
	}
	for _, allowed := range a.allowedRoles() {
		if _, ok := have[allowed]; ok {
			return true
		}
		if _, ok := have["edarole_"+allowed]; ok {
			return true
		}
		if strings.HasPrefix(allowed, "edarole_") {
			if _, ok := have[strings.TrimPrefix(allowed, "edarole_")]; ok {
				return true
			}
		}
	}
	return false
}

func (a *authManager) authorizeURL(r *http.Request, state string) (string, error) {
	base := externalBase(r)
	if base == "" {
		return "", fmt.Errorf("missing external host")
	}
	q := url.Values{}
	q.Set("client_id", keycloakClientID)
	q.Set("response_type", "code")
	q.Set("scope", "openid")
	q.Set("redirect_uri", a.redirectURI(r))
	q.Set("state", state)
	return base + keycloakProxyPath + "/realms/" + keycloakRealm + "/protocol/openid-connect/auth?" + q.Encode(), nil
}

func (a *authManager) redirectURI(r *http.Request) string {
	return externalBase(r) + appProxyPrefix + oauthCallbackPath
}

func externalBase(r *http.Request) string {
	if override := strings.TrimRight(strings.TrimSpace(os.Getenv("EXTERNAL_URL")), "/"); override != "" {
		return override
	}
	host := firstCSV(r.Header.Get("X-Forwarded-Host"))
	if host == "" {
		host = r.Host
	}
	if host == "" {
		host = firstCSV(r.Header.Get("Host"))
	}
	if host == "" {
		return ""
	}
	proto := firstCSV(r.Header.Get("X-Forwarded-Proto"))
	if proto == "" {
		proto = "https"
	}
	return proto + "://" + host
}

func forwardedHeadersForBase(base string) map[string]string {
	u, err := url.Parse(strings.TrimSpace(base))
	if err != nil || u.Host == "" {
		return nil
	}
	proto := u.Scheme
	if proto == "" {
		proto = "https"
	}
	return map[string]string{
		"Host":              u.Host,
		"X-Forwarded-Host":  u.Host,
		"X-Forwarded-Proto": proto,
	}
}

func firstCSV(v string) string {
	if i := strings.IndexByte(v, ','); i >= 0 {
		v = v[:i]
	}
	return strings.TrimSpace(v)
}

func (a *authManager) exchangeCode(ctx context.Context, code string, r *http.Request) (map[string]any, error) {
	if a.exchangeCodeFunc != nil {
		return a.exchangeCodeFunc(ctx, code, r)
	}
	fields := url.Values{}
	fields.Set("grant_type", "authorization_code")
	fields.Set("code", code)
	fields.Set("redirect_uri", a.redirectURI(r))
	fields.Set("client_id", keycloakClientID)
	secret, err := a.getClientSecret(ctx, false)
	if err != nil {
		return nil, err
	}
	fields.Set("client_secret", secret)
	endpoint := a.keycloakInternalBase() + "/realms/" + keycloakRealm + "/protocol/openid-connect/token"
	resp, err := a.postForm(ctx, endpoint, fields, forwardedHeadersForBase(externalBase(r)))
	if se := (*statusError)(nil); err != nil && errors.As(err, &se) && (se.code == http.StatusBadRequest || se.code == http.StatusUnauthorized) {
		secret, err = a.getClientSecret(ctx, true)
		if err != nil {
			return nil, err
		}
		fields.Set("client_secret", secret)
		return a.postForm(ctx, endpoint, fields, forwardedHeadersForBase(externalBase(r)))
	}
	return resp, err
}

func (a *authManager) identityFromBearer(ctx context.Context, token, externalBase string) (string, []string, error) {
	introspection, err := a.introspectToken(ctx, token, externalBase)
	if err != nil {
		return "", nil, err
	}
	active, _ := introspection["active"].(bool)
	if !active {
		return "", nil, fmt.Errorf("token is not active")
	}
	user, roles := tokenIdentity(map[string]any{"access_token": token})
	if user == "" {
		user = stringClaim(introspection, "preferred_username")
		if user == "" {
			user = stringClaim(introspection, "username")
		}
		if user == "" {
			user = stringClaim(introspection, "sub")
		}
	}
	if len(roles) == 0 {
		roles = rolesFromClaims(introspection)
	}
	if user == "" {
		return "", nil, fmt.Errorf("token identity is missing user")
	}
	return user, roles, nil
}

func (a *authManager) introspectToken(ctx context.Context, token, externalBase string) (map[string]any, error) {
	if a.introspectTokenFunc != nil {
		return a.introspectTokenFunc(ctx, token)
	}
	secret, err := a.getClientSecret(ctx, false)
	if err != nil {
		return nil, err
	}
	fields := url.Values{}
	fields.Set("client_id", keycloakClientID)
	fields.Set("client_secret", secret)
	fields.Set("token", token)
	return a.postForm(ctx, a.keycloakInternalBase()+"/realms/"+keycloakRealm+"/protocol/openid-connect/token/introspect", fields, forwardedHeadersForBase(externalBase))
}

func (a *authManager) ensureAssignableRoles(ctx context.Context) error {
	role, err := a.ensureRealmRole(ctx, viewerRealmRole, "Read-only access to the Cable Map topology viewer.")
	if err != nil {
		return err
	}
	group, err := a.ensureGroup(ctx, viewerRoleName, "Cable Map viewer group. Members receive the cable-map-viewer role.")
	if err != nil {
		return err
	}
	return a.ensureGroupRealmRole(ctx, group, role)
}

func (a *authManager) ensureRealmRole(ctx context.Context, name, description string) (map[string]any, error) {
	headers, err := a.adminHeaders(ctx)
	if err != nil {
		return nil, err
	}
	endpoint := a.keycloakInternalBase() + "/admin/realms/" + keycloakRealm + "/roles/" + url.PathEscape(name)
	role, err := a.getJSON(ctx, endpoint, headers)
	if err == nil {
		if out, ok := role.(map[string]any); ok {
			return out, nil
		}
		return nil, fmt.Errorf("unexpected Keycloak role response")
	}
	var se *statusError
	if !errors.As(err, &se) || se.statusCode() != http.StatusNotFound {
		return nil, err
	}
	payload := map[string]any{"name": name, "description": description}
	if err := a.postJSON(ctx, a.keycloakInternalBase()+"/admin/realms/"+keycloakRealm+"/roles", payload, headers); err != nil {
		return nil, err
	}
	role, err = a.getJSON(ctx, endpoint, headers)
	if err != nil {
		return nil, err
	}
	out, ok := role.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("unexpected Keycloak role response")
	}
	return out, nil
}

func (a *authManager) ensureGroup(ctx context.Context, name, description string) (map[string]any, error) {
	headers, err := a.adminHeaders(ctx)
	if err != nil {
		return nil, err
	}
	group, err := a.findGroup(ctx, name, headers)
	if err != nil {
		return nil, err
	}
	if group != nil {
		return group, nil
	}
	payload := map[string]any{
		"name": name,
		"attributes": map[string][]string{
			"description": []string{description},
		},
	}
	if err := a.postJSON(ctx, a.keycloakInternalBase()+"/admin/realms/"+keycloakRealm+"/groups", payload, headers); err != nil {
		return nil, err
	}
	group, err = a.findGroup(ctx, name, headers)
	if err != nil {
		return nil, err
	}
	if group == nil {
		return nil, fmt.Errorf("Keycloak group %q was not found after creation", name)
	}
	return group, nil
}

func (a *authManager) findGroup(ctx context.Context, name string, headers map[string]string) (map[string]any, error) {
	raw, err := a.getJSON(ctx, a.keycloakInternalBase()+"/admin/realms/"+keycloakRealm+"/groups?briefRepresentation=false&search="+url.QueryEscape(name), headers)
	if err != nil {
		return nil, err
	}
	groups, ok := raw.([]any)
	if !ok {
		return nil, fmt.Errorf("unexpected Keycloak groups response")
	}
	for _, item := range groups {
		group, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if groupName, _ := group["name"].(string); groupName == name {
			return group, nil
		}
	}
	return nil, nil
}

func (a *authManager) ensureGroupRealmRole(ctx context.Context, group, role map[string]any) error {
	groupID, _ := group["id"].(string)
	roleID, _ := role["id"].(string)
	roleName, _ := role["name"].(string)
	if groupID == "" || roleID == "" || roleName == "" {
		return fmt.Errorf("Keycloak group/role response missing id or name")
	}
	headers, err := a.adminHeaders(ctx)
	if err != nil {
		return err
	}
	mapped, err := a.getJSON(ctx, a.keycloakInternalBase()+"/admin/realms/"+keycloakRealm+"/groups/"+url.PathEscape(groupID)+"/role-mappings/realm", headers)
	if err != nil {
		return err
	}
	if roles, ok := mapped.([]any); ok {
		for _, item := range roles {
			if existing, ok := item.(map[string]any); ok {
				if name, _ := existing["name"].(string); name == roleName {
					return nil
				}
			}
		}
	}
	return a.postJSON(ctx,
		a.keycloakInternalBase()+"/admin/realms/"+keycloakRealm+"/groups/"+url.PathEscape(groupID)+"/role-mappings/realm",
		[]map[string]any{{"id": roleID, "name": roleName}},
		headers,
	)
}

func (a *authManager) adminHeaders(ctx context.Context) (map[string]string, error) {
	adminToken, err := a.getAdminToken(ctx)
	if err != nil {
		return nil, err
	}
	return map[string]string{"Authorization": "Bearer " + adminToken}, nil
}

func (a *authManager) getClientSecret(ctx context.Context, force bool) (string, error) {
	a.mu.Lock()
	if a.clientSecret != "" && !force {
		secret := a.clientSecret
		a.mu.Unlock()
		return secret, nil
	}
	a.mu.Unlock()

	headers, err := a.adminHeaders(ctx)
	if err != nil {
		return "", err
	}
	clients, err := a.getJSON(ctx, a.keycloakInternalBase()+"/admin/realms/"+keycloakRealm+"/clients?clientId="+url.QueryEscape(keycloakClientID), headers)
	if err != nil {
		return "", err
	}
	clientList, ok := clients.([]any)
	if !ok || len(clientList) == 0 {
		return "", fmt.Errorf("Keycloak client %q not found", keycloakClientID)
	}
	client, ok := clientList[0].(map[string]any)
	if !ok {
		return "", fmt.Errorf("unexpected Keycloak client response")
	}
	id, _ := client["id"].(string)
	if id == "" {
		return "", fmt.Errorf("Keycloak client %q has no id", keycloakClientID)
	}
	secretResp, err := a.getJSON(ctx, a.keycloakInternalBase()+"/admin/realms/"+keycloakRealm+"/clients/"+url.PathEscape(id)+"/client-secret", headers)
	if err != nil {
		return "", err
	}
	secretObj, ok := secretResp.(map[string]any)
	if !ok {
		return "", fmt.Errorf("unexpected Keycloak client-secret response")
	}
	secret, _ := secretObj["value"].(string)
	if secret == "" {
		return "", fmt.Errorf("Keycloak client %q secret is empty", keycloakClientID)
	}
	a.mu.Lock()
	a.clientSecret = secret
	a.mu.Unlock()
	return secret, nil
}

func (a *authManager) getAdminToken(ctx context.Context) (string, error) {
	now := time.Now()
	a.mu.Lock()
	if a.adminToken != "" && a.adminExpiry.After(now.Add(30*time.Second)) {
		token := a.adminToken
		a.mu.Unlock()
		return token, nil
	}
	a.mu.Unlock()

	secret, err := a.readSecret(ctx, "keycloak-admin-secret")
	if err != nil {
		return "", err
	}
	username := string(secret["username"])
	password := string(secret["password"])
	if username == "" || password == "" {
		return "", fmt.Errorf("keycloak-admin-secret missing username/password")
	}
	fields := url.Values{}
	fields.Set("grant_type", "password")
	fields.Set("client_id", "admin-cli")
	fields.Set("username", username)
	fields.Set("password", password)
	resp, err := a.postForm(ctx, a.keycloakInternalBase()+"/realms/master/protocol/openid-connect/token", fields, nil)
	if err != nil {
		return "", err
	}
	token, _ := resp["access_token"].(string)
	if token == "" {
		return "", fmt.Errorf("Keycloak admin token response missing access_token")
	}
	expiresIn := int64(60)
	if v, ok := resp["expires_in"].(float64); ok && v > 0 {
		expiresIn = int64(v)
	}
	a.mu.Lock()
	a.adminToken = token
	a.adminExpiry = now.Add(time.Duration(expiresIn) * time.Second)
	a.mu.Unlock()
	return token, nil
}

func (a *authManager) postForm(ctx context.Context, endpoint string, fields url.Values, headers map[string]string) (map[string]any, error) {
	var out map[string]any
	err := a.doJSON(ctx, http.MethodPost, endpoint, strings.NewReader(fields.Encode()), headers, &out, "application/x-www-form-urlencoded")
	return out, err
}

func (a *authManager) postJSON(ctx context.Context, endpoint string, payload any, headers map[string]string) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	return a.doJSON(ctx, http.MethodPost, endpoint, bytes.NewReader(body), headers, nil, "application/json")
}

func (a *authManager) getJSON(ctx context.Context, endpoint string, headers map[string]string) (any, error) {
	var out any
	err := a.doJSON(ctx, http.MethodGet, endpoint, nil, headers, &out, "")
	return out, err
}

func (a *authManager) doJSON(ctx context.Context, method, endpoint string, body io.Reader, headers map[string]string, out any, contentType string) error {
	tlsConfig, err := a.keycloakTLSConfig(ctx)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	for k, v := range headers {
		if strings.EqualFold(k, "Host") {
			req.Host = v
			continue
		}
		req.Header.Set(k, v)
	}
	client := &http.Client{
		Timeout: httpTimeout,
		Transport: &http.Transport{
			TLSClientConfig: tlsConfig,
		},
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return &statusError{code: resp.StatusCode, body: strings.TrimSpace(string(msg))}
	}
	if out == nil {
		_, _ = io.Copy(io.Discard, resp.Body)
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func (a *authManager) keycloakInternalBase() string {
	return "https://eda-api." + a.namespace + ".svc" + keycloakProxyPath
}

func (a *authManager) keycloakTLSConfig(ctx context.Context) (*tls.Config, error) {
	a.mu.Lock()
	if a.tlsConfig != nil {
		cfg := a.tlsConfig.Clone()
		a.mu.Unlock()
		return cfg, nil
	}
	a.mu.Unlock()

	secret, err := a.readSecret(ctx, "eda-api-ca")
	if err != nil {
		return nil, err
	}
	pool, err := x509.SystemCertPool()
	if err != nil || pool == nil {
		pool = x509.NewCertPool()
	}
	if pem := secret["ca.crt"]; len(pem) > 0 {
		pool.AppendCertsFromPEM(pem)
	}
	cfg := &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
	a.mu.Lock()
	a.tlsConfig = cfg
	a.mu.Unlock()
	return cfg.Clone(), nil
}

func (a *authManager) readSecret(ctx context.Context, name string) (map[string][]byte, error) {
	client, err := a.kubernetesClient()
	if err != nil {
		return nil, err
	}
	secret, err := client.CoreV1().Secrets(a.namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, err
	}
	return secret.Data, nil
}

func (a *authManager) kubernetesClient() (kubernetes.Interface, error) {
	a.kubeOnce.Do(func() {
		cfg, err := edkkube.NewConfig()
		if err != nil {
			a.kubeErr = err
			return
		}
		a.kube, a.kubeErr = kubernetes.NewForConfig(cfg)
	})
	return a.kube, a.kubeErr
}

func (a *authManager) issueSession(username, token string, r *http.Request) (string, error) {
	if username == "" || token == "" {
		return "", fmt.Errorf("session requires user and token")
	}
	sid := ""
	if payload, ok := a.verifySessionPayload(a.cookieValue(r, sessionCookieName)); ok && payload.User == username {
		sid = payload.ID
	}
	if sid == "" {
		sid = newState()
	}
	session, err := a.makeSessionWithID(username, sid, time.Now().Add(sessionTTL))
	if err != nil {
		return "", err
	}
	a.mu.Lock()
	if a.sessions == nil {
		a.sessions = map[string]*authSession{}
	}
	a.sessions[sid] = &authSession{
		user:         username,
		token:        token,
		externalBase: externalBase(r),
		checkedAt:    time.Now(),
	}
	a.mu.Unlock()
	return session, nil
}

func (a *authManager) activeSessionUser(ctx context.Context, payload *sessionPayload) string {
	if payload == nil || payload.User == "" || payload.ID == "" {
		return ""
	}
	now := time.Now()
	a.mu.Lock()
	session := a.sessions[payload.ID]
	if session == nil || session.user != payload.User || session.token == "" {
		a.mu.Unlock()
		return ""
	}
	if now.Sub(session.checkedAt) < sessionCheckTTL {
		user := session.user
		a.mu.Unlock()
		return user
	}
	token := session.token
	base := session.externalBase
	a.mu.Unlock()

	user, roles, err := a.identityFromBearer(ctx, token, base)
	if err != nil || user != payload.User || !a.isAllowed(roles) {
		if err != nil {
			log.Printf("[auth] session token validation failed: %v", err)
		}
		a.mu.Lock()
		delete(a.sessions, payload.ID)
		a.mu.Unlock()
		return ""
	}
	a.mu.Lock()
	if session := a.sessions[payload.ID]; session != nil {
		session.checkedAt = now
	}
	a.mu.Unlock()
	return user
}

func (a *authManager) clearSession(r *http.Request) {
	payload, ok := a.verifySessionPayload(a.cookieValue(r, sessionCookieName))
	if !ok || payload.ID == "" {
		return
	}
	a.mu.Lock()
	delete(a.sessions, payload.ID)
	a.mu.Unlock()
}

func (a *authManager) makeSession(username string) (string, error) {
	return a.makeSessionWithExpiry(username, time.Now().Add(sessionTTL))
}

func (a *authManager) makeSessionWithExpiry(username string, expiry time.Time) (string, error) {
	return a.makeSessionWithID(username, newState(), expiry)
}

func (a *authManager) makeSessionWithID(username, id string, expiry time.Time) (string, error) {
	payload := sessionPayload{User: username, ID: id, Exp: expiry.Unix()}
	bodyBytes, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	body := base64.RawURLEncoding.EncodeToString(bodyBytes)
	return body + "." + a.sign(body), nil
}

func (a *authManager) verifySession(cookie string) string {
	payload, ok := a.verifySessionPayload(cookie)
	if !ok {
		return ""
	}
	return payload.User
}

func (a *authManager) verifySessionPayload(cookie string) (*sessionPayload, bool) {
	if cookie == "" || !strings.Contains(cookie, ".") {
		return nil, false
	}
	body, sig, ok := strings.Cut(cookie, ".")
	if !ok || !hmac.Equal([]byte(sig), []byte(a.sign(body))) {
		return nil, false
	}
	payloadBytes, err := base64.RawURLEncoding.DecodeString(body)
	if err != nil {
		return nil, false
	}
	var payload sessionPayload
	if err := json.Unmarshal(payloadBytes, &payload); err != nil {
		return nil, false
	}
	if payload.User == "" || payload.ID == "" || payload.Exp < time.Now().Unix() {
		return nil, false
	}
	return &payload, true
}

func (a *authManager) sign(body string) string {
	mac := hmac.New(sha256.New, a.signingKey)
	mac.Write([]byte(body))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func tokenIdentity(tokenResp map[string]any) (string, []string) {
	raw, _ := tokenResp["access_token"].(string)
	claims := decodeJWT(raw)
	if claims == nil || claims.Exp < time.Now().Unix() {
		return "", nil
	}
	user := claims.PreferredUsername
	if user == "" {
		user = claims.Subject
	}
	return user, claims.RealmAccess.Roles
}

func stringClaim(claims map[string]any, name string) string {
	value, _ := claims[name].(string)
	return value
}

func rolesFromClaims(claims map[string]any) []string {
	realmAccess, _ := claims["realm_access"].(map[string]any)
	rawRoles, _ := realmAccess["roles"].([]any)
	roles := make([]string, 0, len(rawRoles))
	for _, raw := range rawRoles {
		if role, ok := raw.(string); ok && role != "" {
			roles = append(roles, role)
		}
	}
	return roles
}

type jwtClaims struct {
	Exp               int64  `json:"exp"`
	PreferredUsername string `json:"preferred_username"`
	Subject           string `json:"sub"`
	RealmAccess       struct {
		Roles []string `json:"roles"`
	} `json:"realm_access"`
}

func decodeJWT(token string) *jwtClaims {
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return nil
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil
	}
	var claims jwtClaims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return nil
	}
	return &claims
}

func newState() string {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		panic(fmt.Sprintf("generate oauth state: %v", err))
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

func htmlEscape(s string) string {
	repl := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&#34;", "'", "&#39;")
	return repl.Replace(s)
}
