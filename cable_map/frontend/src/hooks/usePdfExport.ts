import { useCallback, useRef, useState } from 'react';
import { authenticatedFetch } from '../api/client';
import type { Topology } from '../domain/topology/contract';
import { edgeRemote } from '../edge-remote';

type PdfState = { status: 'idle' | 'loading' | 'error'; message?: string };

// Owns PDF export state + the download flow. Consumed by both the toolbar and the node drawer;
// the error Snackbar is rendered by App from `pdfState` + `dismissError`. `openPdf` is kept stable
// (refs for the latest inputs) so the memoized toolbar/drawer don't re-render on its identity.
export function usePdfExport({ topo, namespace }: { topo: Topology | null; namespace: string }) {
  const [pdfState, setPdfState] = useState<PdfState>({ status: 'idle' });
  const topoRef = useRef(topo);
  topoRef.current = topo;
  const namespaceRef = useRef(namespace);
  namespaceRef.current = namespace;
  const loadingRef = useRef(false); // guards against a second export starting mid-flight

  const openPdf = useCallback(async (ids: string[]) => {
    if (loadingRef.current) return;
    const currentTopo = topoRef.current;
    const ns = namespaceRef.current;
    const targets = ids.length ? ids : (currentTopo?.nodes.map((n) => n.name) ?? []);
    const params = new URLSearchParams();
    if (ids.length) params.set('nodes', ids.join(','));
    if (ns) params.set('ns', ns);
    const sub = edgeRemote.subset(targets);
    if (Object.keys(sub).length) params.set('remote', JSON.stringify(sub));
    const qs = params.toString();
    loadingRef.current = true;
    setPdfState({ status: 'loading' });
    try {
      const res = await authenticatedFetch(`pdf${qs ? `?${qs}` : ''}`);
      if (!res.ok) {
        const detail = await res.json().then((b) => b?.error).catch(() => '');
        throw new Error(detail ? `PDF export failed: ${detail}` : `PDF export failed (HTTP ${res.status})`);
      }
      const blob = await res.blob();
      if (blob.size === 0) throw new Error('PDF export returned an empty document');
      const name = /filename="?([^"]+)"?/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'cable-map.pdf';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setPdfState({ status: 'idle' });
    } catch (e) {
      // fetch only throws (TypeError) when the request never completed
      const message = e instanceof TypeError ? 'PDF export failed: service unreachable'
        : e instanceof Error ? e.message : 'PDF export failed';
      setPdfState({ status: 'error', message });
    } finally {
      loadingRef.current = false;
    }
  }, []);

  const dismissError = useCallback(() => setPdfState({ status: 'idle' }), []);

  return { pdfState, openPdf, dismissError };
}
