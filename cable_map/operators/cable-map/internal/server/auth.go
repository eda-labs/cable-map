package server

import (
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
	keycloakProxyPath = "/core/httpproxy/v1/keycloak"
	appProxyPrefix    = "/core/httpproxy/v1/cable-map"
	oauthCallbackPath = "/oauth/callback"

	sessionCookieName = "cm_session"
	stateCookieName   = "cm_oauth_state"
	sessionTTL        = 8 * time.Hour
	httpTimeout       = 20 * time.Second

	allowedRolesEnv     = "ALLOWED_ROLES"
	defaultAllowedRoles = "cable-map-viewer,system-administrator"
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

	exchangeCodeFunc    func(context.Context, string, *http.Request) (map[string]any, error)
	introspectTokenFunc func(context.Context, string) (map[string]any, error)
}

type statusError struct {
	code int
	body string
}

func (e *statusError) Error() string {
	return fmt.Sprintf("keycloak returned HTTP %d: %s", e.code, e.body)
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
	return &authManager{namespace: namespace, signingKey: key}
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
	session, err := a.makeSession(user)
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
		writeJSON(w, http.StatusUnauthorized, map[string]any{"ok": false, "error": "not authenticated"})
	case http.MethodPost:
		if !a.enabled() {
			writeJSON(w, http.StatusOK, map[string]any{"ok": true})
			return
		}
		token := bearerToken(r.Header.Get("Authorization"))
		if token == "" {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"ok": false, "error": "missing bearer token"})
			return
		}
		user, roles, err := a.identityFromBearer(r.Context(), token)
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
		session, err := a.makeSession(user)
		if err != nil {
			log.Printf("[auth] session creation failed: %v", err)
			writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": "could not create session"})
			return
		}
		w.Header().Add("Set-Cookie", a.cookie(sessionCookieName, session, int(sessionTTL.Seconds())).String())
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "user": user})
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
	return a.verifySession(a.cookieValue(r, sessionCookieName))
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
	resp, err := a.postForm(ctx, endpoint, fields, nil)
	if se := (*statusError)(nil); err != nil && errors.As(err, &se) && (se.code == http.StatusBadRequest || se.code == http.StatusUnauthorized) {
		secret, err = a.getClientSecret(ctx, true)
		if err != nil {
			return nil, err
		}
		fields.Set("client_secret", secret)
		return a.postForm(ctx, endpoint, fields, nil)
	}
	return resp, err
}

func (a *authManager) identityFromBearer(ctx context.Context, token string) (string, []string, error) {
	introspection, err := a.introspectToken(ctx, token)
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

func (a *authManager) introspectToken(ctx context.Context, token string) (map[string]any, error) {
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
	return a.postForm(ctx, a.keycloakInternalBase()+"/realms/"+keycloakRealm+"/protocol/openid-connect/token/introspect", fields, nil)
}

func (a *authManager) getClientSecret(ctx context.Context, force bool) (string, error) {
	a.mu.Lock()
	if a.clientSecret != "" && !force {
		secret := a.clientSecret
		a.mu.Unlock()
		return secret, nil
	}
	a.mu.Unlock()

	adminToken, err := a.getAdminToken(ctx)
	if err != nil {
		return "", err
	}
	headers := map[string]string{"Authorization": "Bearer " + adminToken}
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

func (a *authManager) makeSession(username string) (string, error) {
	return a.makeSessionWithExpiry(username, time.Now().Add(sessionTTL))
}

func (a *authManager) makeSessionWithExpiry(username string, expiry time.Time) (string, error) {
	payload := map[string]any{"u": username, "exp": expiry.Unix()}
	bodyBytes, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	body := base64.RawURLEncoding.EncodeToString(bodyBytes)
	return body + "." + a.sign(body), nil
}

func (a *authManager) verifySession(cookie string) string {
	if cookie == "" || !strings.Contains(cookie, ".") {
		return ""
	}
	body, sig, ok := strings.Cut(cookie, ".")
	if !ok || !hmac.Equal([]byte(sig), []byte(a.sign(body))) {
		return ""
	}
	payloadBytes, err := base64.RawURLEncoding.DecodeString(body)
	if err != nil {
		return ""
	}
	var payload struct {
		User string `json:"u"`
		Exp  int64  `json:"exp"`
	}
	if err := json.Unmarshal(payloadBytes, &payload); err != nil {
		return ""
	}
	if payload.User == "" || payload.Exp < time.Now().Unix() {
		return ""
	}
	return payload.User
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
