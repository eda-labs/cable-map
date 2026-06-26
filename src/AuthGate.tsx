import { useEffect, useState, type ReactNode } from 'react';
import Keycloak from 'keycloak-js';
import { BASE } from './api';

type AuthState = 'checking' | 'ready' | 'denied' | 'error';

let sessionPromise: Promise<void> | null = null;

function authDisabledForLocalDev(): boolean {
  if (import.meta.env.VITE_CABLE_MAP_AUTH === '1') return false;
  return import.meta.env.DEV && /^(localhost|127\.|0\.0\.0\.0)$/.test(window.location.hostname);
}

async function hasCableMapSession(): Promise<boolean> {
  const res = await fetch(`${BASE}oauth/session`, { cache: 'no-store' });
  return res.ok;
}

function keycloakClient(): Keycloak {
  return new Keycloak({
    url: `${window.location.origin}/core/httpproxy/v1/keycloak`,
    realm: 'eda',
    clientId: 'eda',
  });
}

async function establishCableMapSession(): Promise<void> {
  if (authDisabledForLocalDev()) return;
  if (await hasCableMapSession()) return;

  const keycloak = keycloakClient();
  const authenticated = await keycloak.init({
    onLoad: 'check-sso',
    pkceMethod: 'S256',
    checkLoginIframe: true,
    silentCheckSsoRedirectUri: new URL(`${BASE}silent-check-sso.html`, window.location.href).href,
  });

  if (!authenticated) {
    void keycloak.login({ redirectUri: window.location.href });
    return new Promise(() => {});
  }

  await keycloak.updateToken(30);
  const token = keycloak.token;
  if (!token) throw new Error('Keycloak did not return an access token');

  const res = await fetch(`${BASE}oauth/session`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (res.status === 403) throw new Error('access denied');
  if (!res.ok) throw new Error(`session exchange failed: ${res.status}`);
}

function ensureCableMapSession(): Promise<void> {
  sessionPromise ??= establishCableMapSession();
  return sessionPromise;
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>('checking');

  useEffect(() => {
    let mounted = true;
    ensureCableMapSession()
      .then(() => { if (mounted) setState('ready'); })
      .catch((err) => {
        if (!mounted) return;
        setState(String((err as Error).message || err).includes('access denied') ? 'denied' : 'error');
      });
    return () => { mounted = false; };
  }, []);

  if (state === 'ready') return <>{children}</>;
  if (state === 'denied') return <div style={{ padding: 24 }}>Access denied</div>;
  if (state === 'error') return <div style={{ padding: 24 }}>Sign-in unavailable</div>;
  return <div style={{ padding: 24 }}>Signing in...</div>;
}
