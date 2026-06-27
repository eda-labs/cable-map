// keycloak-js token plumbing. Behind EDA's HttpProxy (atDestination) the SPA document loads
// unauthenticated; this then runs keycloak-js' hidden-iframe check-sso against the EDA Keycloak SSO
// session and obtains a per-tab, in-memory JWT (never persisted). api.ts attaches it as a bearer on
// fetches and as ?access_token= on SSE (EventSource can't set headers).
import Keycloak from 'keycloak-js';

const BASE = import.meta.env.BASE_URL;
const isLoopback = (h: string) => h === 'localhost' || h === '0.0.0.0' || h === '::1' || h.startsWith('127.');

let kc: Keycloak | null = null;
let latest = '';

// Auth is skipped in local dev (no EDA Keycloak) and in the loopback /print render (the operator's
// own chromedp hits 127.0.0.1, which the backend exempts) — running keycloak-js there would try to
// redirect the headless browser to a login it can't complete.
function authSkipped(): boolean {
  if (import.meta.env.VITE_CABLE_MAP_AUTH === '1') return false;
  if (isLoopback(window.location.hostname) && window.location.pathname.startsWith('/print')) return true;
  return import.meta.env.DEV && isLoopback(window.location.hostname);
}

export async function initAuth(): Promise<void> {
  if (authSkipped()) return;
  kc = new Keycloak({ url: `${window.location.origin}/core/proxy/v1/identity`, realm: 'eda', clientId: 'auth' });
  kc.onTokenExpired = () => { void refresh(); };
  const authenticated = await kc.init({
    onLoad: 'check-sso',
    pkceMethod: 'S256',
    checkLoginIframe: true,
    silentCheckSsoRedirectUri: new URL(`${BASE}silent-check-sso.html`, window.location.href).href,
  });
  if (!authenticated) {
    await kc.login({ redirectUri: window.location.href });
    return new Promise<void>(() => {}); // navigating to the IdP; never resolves
  }
  latest = kc.token ?? '';
  // Keep a fresh token cached so SSE URLs (built synchronously) always carry a valid one.
  window.setInterval(() => { void refresh(); }, 30_000);
}

async function refresh(): Promise<void> {
  if (!kc) return;
  try {
    await kc.updateToken(60);
    latest = kc.token ?? '';
  } catch {
    await kc.login({ redirectUri: window.location.href });
  }
}

// Last-known access token, synchronous (for SSE / window.open URLs). '' when auth is skipped.
export function currentToken(): string {
  return latest;
}

// Authorization header for fetch(), refreshing first if the token is near expiry.
export async function authHeader(): Promise<Record<string, string>> {
  if (!kc) return {};
  await refresh();
  return latest ? { Authorization: `Bearer ${latest}` } : {};
}
