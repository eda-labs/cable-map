import express, { type NextFunction, type Request, type Response } from 'express';
import type { Browser } from 'puppeteer';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getTopology, createTopologyStream, createNamespaceStream, listNamespaces, type TopologyStream } from './eda.js';

const serverDir = dirname(fileURLToPath(import.meta.url));
const DIST = join(serverDir, '..', 'dist');
const PORT = Number(process.env.PORT || 8080);

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const asyncHandler =
  (handler: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    void handler(req, res).catch(next);
  };

const app = express();
const DEFAULT_NS = process.env.EDA_NAMESPACE || 'eda';

// The live set of EDA namespaces (one cluster-wide watch shared by everything below).
const namespaces = createNamespaceStream();

// One watch-backed topology stream per namespace selection ('' == All Namespaces), created on
// demand. The All stream tracks the live namespace set, so a namespace added later starts
// streaming without a refresh.
const streams = new Map<string, TopologyStream>();
async function streamFor(ns: string): Promise<TopologyStream> {
  let s = streams.get(ns);
  if (!s) {
    if (ns) {
      s = createTopologyStream([ns]);
    } else {
      const initial = namespaces.current().length ? namespaces.current() : await listNamespaces();
      s = createTopologyStream(initial.length ? initial : [DEFAULT_NS]);
      const all = s;
      namespaces.subscribe((list) => all.setNamespaces(list.length ? list : [DEFAULT_NS]));
    }
    streams.set(ns, s);
  }
  return s;
}

const sseHeaders = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',   // don't let a proxy buffer the stream
};

app.get('/healthz', (_req: Request, res: Response) => {
  res.status(200).json({ ok: true });
});

// The EDA namespaces available to pick from (one-shot).
app.get('/api/namespaces', asyncHandler(async (_req: Request, res: Response) => {
  try {
    res.json(await listNamespaces());
  } catch (e) {
    res.status(502).json({ error: errMsg(e) });
  }
}));

// Live namespace list over SSE — the picker updates as namespaces are created/deleted.
app.get('/api/namespaces/stream', (req: Request, res: Response) => {
  res.set(sseHeaders);
  res.flushHeaders?.();
  res.write('retry: 3000\n\n');
  const send = (list: string[]) => res.write(`data: ${JSON.stringify(list)}\n\n`);
  const unsubscribe = namespaces.subscribe(send);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(keepAlive); unsubscribe(); });
});

// Always the real EDA API — no demo/fallback data. On failure the UI shows a
// placeholder ("Didn't fetch anything from EDA"). ?ns=<namespace> (omit -> all).
app.get('/api/topology', asyncHandler(async (req: Request, res: Response) => {
  const ns = String(req.query.ns || '');
  try {
    const stream = await streamFor(ns);
    res.json(stream.current() ?? await getTopology(ns ? [ns] : await listNamespaces()));
  } catch (e) {
    res.status(502).json({ error: errMsg(e) });
  }
}));

// Live topology over Server-Sent Events: the current snapshot on connect, then a fresh
// payload whenever the watched CRDs change. EventSource handles reconnection on the client.
app.get('/api/topology/stream', asyncHandler(async (req: Request, res: Response) => {
  const stream = await streamFor(String(req.query.ns || ''));
  res.set(sseHeaders);
  res.flushHeaders?.();
  res.write('retry: 3000\n\n');
  const send = (topo: unknown) => res.write(`data: ${JSON.stringify(topo)}\n\n`);
  const unsubscribe = stream.subscribe(send);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(keepAlive); unsubscribe(); });
}));

// Render the front-panel + cable-table print page(s) to a single PDF.
// ?nodes=leaf1,spine1  (omit -> all nodes). Multi-node = multi-page.
app.get('/pdf', asyncHandler(async (req: Request, res: Response) => {
  let browser: Browser | undefined;
  try {
    const { default: puppeteer } = await import('puppeteer');
    const nodes = String(req.query.nodes || '');
    const url = `http://127.0.0.1:${PORT}/print${nodes ? `?nodes=${encodeURIComponent(nodes)}` : ''}`;
    // --disable-dev-shm-usage: containers have a tiny /dev/shm that crashes Chromium.
    browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle0' });
    await page.evaluateHandle('document.fonts.ready');   // embed NokiaPureText, not the fallback
    const pdf = await page.pdf({ printBackground: true, format: 'A4', landscape: true,
      margin: { top: '0.5in', bottom: '0.5in', left: '0.5in', right: '0.5in' } });
    res.set('content-type', 'application/pdf')
       .set('content-disposition', `inline; filename="cablemap${nodes ? '-' + nodes.replace(/,/g, '_') : ''}.pdf"`)
       .send(Buffer.from(pdf));
  } catch (e) {
    res.status(500).json({ error: errMsg(e) });
  } finally {
    if (browser) await browser.close();
  }
}));

// SPA: serve built app; /print and / both fall through to index.html (client routes).
app.use(express.static(DIST));
app.get('*', (_req: Request, res: Response) => res.sendFile(join(DIST, 'index.html')));

app.listen(PORT, () => console.log(`cablemap on http://127.0.0.1:${PORT}`));
