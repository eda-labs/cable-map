import { useEffect, useState, type ReactNode } from 'react';
import { initAuth } from './auth';

type AuthState = 'checking' | 'ready' | 'error';

let authPromise: Promise<void> | null = null;
function ensureAuth(): Promise<void> {
  authPromise ??= initAuth();
  return authPromise;
}

// Gates the app on keycloak-js obtaining a token (silently, via the EDA SSO session). Authorization
// (the cable-map-viewer role) is enforced by the backend on API calls, not here.
export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>('checking');

  useEffect(() => {
    let mounted = true;
    ensureAuth()
      .then(() => { if (mounted) setState('ready'); })
      .catch(() => { if (mounted) setState('error'); });
    return () => { mounted = false; };
  }, []);

  if (state === 'ready') return <>{children}</>;
  if (state === 'error') return <div style={{ padding: 24 }}>Sign-in unavailable</div>;
  return <div style={{ padding: 24 }}>Signing in...</div>;
}
