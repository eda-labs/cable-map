import { useEffect, useState, type ReactNode } from 'react';
import Keycloak from 'keycloak-js';
import { BASE } from './api';

type AuthState = 'checking' | 'ready' | 'denied' | 'error';

let sessionPromise: Promise<void> | null = null;
let keycloak: Keycloak | null = null;
let renewTimer: ReturnType<typeof window.setInterval> | null = null;

function authDisabledForLocalDev(): boolean {
  if (import.meta.env.VITE_CABLE_MAP_AUTH === '1') return false;
  return import.meta.env.DEV && /^(localhost|127\.|0\.0\.0\.0)$/.test(window.location.hostname);
}

function isLoopbackPrint(): boolean {
  return /^(localhost|127\.|0\.0\.0\.0)$/.test(window.location.hostname) && window.location.pathname.startsWith('/print');
}

async function hasCableMapSession(): Promise<boolean> {
  const res = await fetch(`${BASE}oauth/session`, { cache: 'no-store' });
  return res.ok;
}

async function clearCableMapSession(): Promise<void> {
  sessionPromise = null;
  await fetch(`${BASE}oauth/session`, { method: 'DELETE', cache: 'no-store' }).catch(() => {});
}

function keycloakClient(): Keycloak {
  return new Keycloak({
    url: `${window.location.origin}/core/proxy/v1/identity`,
    realm: 'eda',
    clientId: 'auth',
  });
}

async function exchangeCableMapSession(token: string): Promise<void> {
  if (!token) throw new Error('Keycloak did not return an access token');

  const res = await fetch(`${BASE}oauth/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
    cache: 'no-store',
  });
  if (res.status === 403) throw new Error('access denied');
  if (!res.ok) throw new Error(`session exchange failed: ${res.status}`);
}

async function refreshCableMapSession(): Promise<void> {
  if (!keycloak) return;
  await keycloak.updateToken(45);
  if (!keycloak.token) throw new Error('Keycloak did not return an access token');
  await exchangeCableMapSession(keycloak.token);
}

function startSessionRenewal(): void {
  if (renewTimer != null) return;
  renewTimer = window.setInterval(() => {
    void refreshCableMapSession().catch(async () => {
      if (renewTimer != null) {
        window.clearInterval(renewTimer);
        renewTimer = null;
      }
      await clearCableMapSession();
      void keycloak?.login({ redirectUri: window.location.href });
    });
  }, 30_000);
}

async function establishCableMapSession(): Promise<void> {
  if (authDisabledForLocalDev()) return;
  if (isLoopbackPrint() && await hasCableMapSession()) return;

  keycloak ??= keycloakClient();
  keycloak.onAuthLogout = () => {
    void clearCableMapSession().finally(() => { window.location.reload(); });
  };
  keycloak.onTokenExpired = () => {
    void refreshCableMapSession().catch(() => clearCableMapSession());
  };

  const authenticated = await keycloak.init({
    onLoad: 'check-sso',
    pkceMethod: 'S256',
    checkLoginIframe: true,
    checkLoginIframeInterval: 5,
    silentCheckSsoRedirectUri: new URL(`${BASE}silent-check-sso.html`, window.location.href).href,
  });

  if (!authenticated) {
    await clearCableMapSession();
    void keycloak.login({ redirectUri: window.location.href });
    return new Promise(() => {});
  }

  await refreshCableMapSession();
  startSessionRenewal();
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
