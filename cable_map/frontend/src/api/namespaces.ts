import { authenticatedUrl } from './client';

// Live EDA namespace list — the picker updates as namespaces are created/deleted.
export function streamNamespaces(onList: (names: string[]) => void, onError?: (msg: string) => void): () => void {
  const es = new EventSource(authenticatedUrl('api/namespaces/stream'));
  es.addEventListener('message', (ev) => {
    try { onList(JSON.parse(ev.data) as string[]); } catch { /* ignore malformed frame */ }
  });
  es.addEventListener('error', () => onError?.('namespace stream disconnected — reconnecting…'));
  return () => es.close();
}
