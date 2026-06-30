import { authenticatedFetch, authenticatedUrl } from './client';

export type PdfJobRequest = {
  namespace?: string;
  nodes?: string[];
  remote?: Record<string, string>;
  stencils?: Record<string, string>;
};

export type PdfProgressEvent = {
  status: 'running' | 'ready' | 'error';
  phase: string;
  detail?: string;
  percent?: number;
  indeterminate?: boolean;
  message?: string;
};

export async function startPdfJob(request: PdfJobRequest): Promise<string> {
  const res = await authenticatedFetch('api/pdf/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!res.ok) throw new Error(await pdfErrorMessage(res, 'PDF export failed'));
  const body = await res.json() as { id?: string };
  if (!body.id) throw new Error('PDF export failed: missing job id');
  return body.id;
}

export function streamPdfJob(
  id: string,
  onEvent: (event: PdfProgressEvent) => void,
  onReconnect: (message: string) => void,
): () => void {
  let closed = false;
  const es = new EventSource(authenticatedUrl(`api/pdf/jobs/${encodeURIComponent(id)}/events`));
  es.addEventListener('message', (ev) => {
    if (closed || !ev.data) return;
    try {
      const event = JSON.parse(ev.data) as PdfProgressEvent;
      onEvent(event);
      if (event.status !== 'running') {
        closed = true;
        es.close();
      }
    } catch {
      onReconnect('PDF progress update was unreadable');
    }
  });
  es.addEventListener('error', () => {
    if (!closed) onReconnect('PDF progress stream reconnecting...');
  });
  return () => {
    closed = true;
    es.close();
  };
}

export function pdfJobDownloadUrl(id: string): string {
  return authenticatedUrl(`api/pdf/jobs/${encodeURIComponent(id)}/download`);
}

async function pdfErrorMessage(res: Response, fallback: string): Promise<string> {
  const detail = await res.json().then((body) => body?.error).catch(() => '');
  return detail ? `${fallback}: ${detail}` : `${fallback} (HTTP ${res.status})`;
}
