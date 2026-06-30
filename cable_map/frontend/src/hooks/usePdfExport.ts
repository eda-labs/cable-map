import { useCallback, useEffect, useRef, useState } from 'react';
import { pdfJobDownloadUrl, startPdfJob, streamPdfJob, type PdfProgressEvent } from '../api/pdf';
import type { Topology } from '../domain/topology/contract';
import { edgeRemote } from '../edge-remote';
import { stencilFor, componentsOf } from '../stencil';

export type PdfState =
  | { status: 'idle' }
  | { status: 'loading'; phase: string; detail?: string; percent?: number; indeterminate?: boolean }
  | { status: 'error'; message: string };

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
  const streamCleanupRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      streamCleanupRef.current?.();
    };
  }, []);

  const setSafePdfState = useCallback((next: PdfState) => {
    if (mountedRef.current) setPdfState(next);
  }, []);

  const startBrowserDownload = useCallback((jobId: string) => {
    const a = document.createElement('a');
    a.href = pdfJobDownloadUrl(jobId);
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, []);

  const applyProgress = useCallback((event: PdfProgressEvent, jobId: string) => {
    if (event.status === 'error') {
      loadingRef.current = false;
      streamCleanupRef.current?.();
      streamCleanupRef.current = null;
      setSafePdfState({ status: 'error', message: event.message || 'PDF export failed' });
      return;
    }
    if (event.status === 'ready') {
      loadingRef.current = false;
      streamCleanupRef.current?.();
      streamCleanupRef.current = null;
      setSafePdfState({ status: 'idle' });
      startBrowserDownload(jobId);
      return;
    }
    setSafePdfState({ status: 'loading', phase: event.phase, detail: event.detail, percent: event.percent, indeterminate: event.indeterminate });
  }, [setSafePdfState, startBrowserDownload]);

  const openPdf = useCallback(async (ids: string[]) => {
    if (loadingRef.current) return;
    const currentTopo = topoRef.current;
    const ns = namespaceRef.current;
    const targets = ids.length ? ids : (currentTopo?.nodes.map((n) => n.name) ?? []);
    const sub = edgeRemote.subset(targets);
    const byName = new Map(currentTopo?.nodes.map((n) => [n.name, n]) ?? []);
    const stencils: Record<string, string> = {};
    for (const name of targets) {
      const n = byName.get(name);
      if (!n) continue;
      const resolved = stencilFor(n.platform, componentsOf(n.raw));
      if (resolved !== n.platform) stencils[name] = resolved;
    }
    loadingRef.current = true;
    setSafePdfState({ status: 'loading', phase: 'Starting export', percent: 0 });
    try {
      const jobId = await startPdfJob({
        namespace: ns || undefined,
        nodes: ids.length ? ids : undefined,
        remote: Object.keys(sub).length ? sub : undefined,
        stencils: Object.keys(stencils).length ? stencils : undefined,
      });
      streamCleanupRef.current?.();
      streamCleanupRef.current = streamPdfJob(jobId, (event) => applyProgress(event, jobId), (message) => {
        setSafePdfState({ status: 'loading', phase: 'Waiting for PDF', detail: message, indeterminate: true });
      });
    } catch (e) {
      // fetch only throws (TypeError) when the request never completed
      const message = e instanceof TypeError ? 'PDF export failed: service unreachable'
        : e instanceof Error ? e.message : 'PDF export failed';
      loadingRef.current = false;
      streamCleanupRef.current?.();
      streamCleanupRef.current = null;
      setSafePdfState({ status: 'error', message });
    }
  }, [applyProgress, setSafePdfState]);

  const dismissError = useCallback(() => setSafePdfState({ status: 'idle' }), [setSafePdfState]);

  return { pdfState, openPdf, dismissError };
}
