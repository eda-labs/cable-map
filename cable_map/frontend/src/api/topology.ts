import type { Topology } from '../domain/topology/contract';
import { authenticatedFetch, authenticatedUrl } from './client';

export async function fetchTopology(namespace = ''): Promise<Topology> {
  const qs = namespace ? `?ns=${encodeURIComponent(namespace)}` : '';
  const res = await authenticatedFetch(`api/topology${qs}`);
  if (!res.ok) throw new Error(`topology ${res.status}: ${(await res.json()).error || ''}`);
  return res.json();
}

export function streamTopology(namespace: string, onTopo: (t: Topology) => void, onError: (msg: string) => void): () => void {
  let closed = false;
  void fetchTopology(namespace)
    .then((t) => { if (!closed) onTopo(t); })
    .catch((e) => { if (!closed) onError(String((e as Error).message || e)); });

  const es = new EventSource(authenticatedUrl(`api/topology/stream?ns=${encodeURIComponent(namespace)}`));
  es.addEventListener('message', (ev) => {
    if (closed || !ev.data) return;
    try { onTopo(JSON.parse(ev.data) as Topology); } catch (e) { onError(String((e as Error).message || e)); }
  });
  es.addEventListener('error', () => { if (!closed) onError('live stream disconnected — reconnecting…'); });
  return () => { closed = true; es.close(); };
}
