import express, { type NextFunction, type Request, type Response } from 'express';
import type { Browser } from 'puppeteer';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getTopology } from './eda.js';

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

app.get('/healthz', (_req: Request, res: Response) => {
  res.status(200).json({ ok: true });
});

// Always the real EDA API — no demo/fallback data. On failure the UI shows a
// placeholder ("Didn't fetch anything from EDA").
app.get('/api/topology', asyncHandler(async (_req: Request, res: Response) => {
  try {
    res.json(await getTopology());
  } catch (e) {
    res.status(502).json({ error: errMsg(e) });
  }
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
