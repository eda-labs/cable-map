import { authHeader, currentToken } from '../auth';
import { appPath, withTokenQuery } from './base';

export function authenticatedUrl(path: string): string {
  return withTokenQuery(appPath(path), currentToken());
}

export async function authenticatedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const auth = await authHeader();
  for (const [key, value] of Object.entries(auth)) headers.set(key, value);
  return fetch(authenticatedUrl(path), { ...init, headers });
}
