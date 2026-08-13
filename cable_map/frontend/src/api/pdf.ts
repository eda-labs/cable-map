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

// streamPdfJob polls the job status until it reaches a terminal state. We poll rather than use SSE
// because the EDA httpproxy in front of the app buffers/drops streamed responses, which made the
// progress stream endlessly "reconnect" on the deployed path.
export function streamPdfJob(
  id: string,
  onEvent: (event: PdfProgressEvent) => void,
  onReconnect: (message: string) => void,
): () => void {
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const poll = async () => {
    if (closed) return;
    try {
      const res = await authenticatedFetch(`api/pdf/jobs/${encodeURIComponent(id)}/status`);
      if (res.status === 404) {
        closed = true;
        onEvent({
          status: 'error',
          phase: 'PDF export failed',
          message: 'PDF job is no longer available; the service may have restarted. Please retry.',
        });
        return;
      }
      if (!res.ok) throw new Error(`status ${res.status}`);
      const event = await res.json() as PdfProgressEvent;
      if (closed) return;
      onEvent(event);
      if (event.status !== 'running') {
        closed = true;
        return;
      }
    } catch {
      if (!closed) onReconnect('Waiting for PDF…');
    }
    if (!closed) timer = setTimeout(() => void poll(), 700);
  };
  void poll();

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
  };
}

export function pdfJobDownloadUrl(id: string): string {
  return authenticatedUrl(`api/pdf/jobs/${encodeURIComponent(id)}/download`);
}

async function pdfErrorMessage(res: Response, fallback: string): Promise<string> {
  const detail = await res.json().then((body) => body?.error).catch(() => '');
  return detail ? `${fallback}: ${detail}` : `${fallback} (HTTP ${res.status})`;
}
