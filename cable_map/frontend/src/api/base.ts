// Vite base (trailing slash) prefixes same-origin URLs so they resolve under the
// EDA HttpProxy sub-path as well as at the root.
export const BASE = import.meta.env.BASE_URL;

export function appPath(path: string): string {
  return `${BASE}${path.replace(/^\/+/, '')}`;
}

// EventSource can't set an Authorization header, so the keycloak-js token rides as a query param on
// SSE/navigation URLs; the backend accepts ?access_token= equivalently to a bearer header.
export function withTokenQuery(url: string, token: string): string {
  if (!token) return url;
  return `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`;
}
