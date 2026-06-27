// Losslessly minifies the front-panel stencils in public/frontpanel/ in place. The composites are
// generated large (~1–4 MB) with pretty-print whitespace, trailing zeros, and editor metadata; this
// strips that without touching the geometry, so the PDF/canvas render identically but the operator
// bundle + chromedp render are far smaller/faster. Run LAST, after gen-frontpanel-meta.mjs:
//   node scripts/minify-frontpanel.mjs
// SVGO rewrites path `d` to relative/shorthand commands, which gen-frontpanel-meta's absolute-coord
// bbox parser can't read — so always (re)generate the meta from the clean SVGs first, then minify.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { optimize } from 'svgo';

const DIR = 'public/frontpanel';
// floatPrecision 6 keeps the 5-decimal source coords intact (only sub-micron viewBox float-noise is
// trimmed); the win is whitespace + trailing zeros + editor metadata, not coordinate rounding.
const config = {
  js2svg: { pretty: false },
  floatPrecision: 6,
  plugins: [
    { name: 'preset-default', params: { overrides: {
      cleanupIds: false,        // ids are isolated per nested card; url(#…)/href refs must survive
      mergePaths: false,        // every cage is its own <path data-port>
      removeHiddenElems: false,
    } } },
  ],
};

// sodipodi:/inkscape: attrs AND elements (e.g. <sodipodi:namedview>) use namespaces these exports
// never declare — invalid strict XML that SVGO's parser rejects, and it doesn't reliably strip them
// either. They're inert editor cruft (browsers ignore sodipodi:role etc.), so remove both forms by
// hand before optimizing.
const stripEditor = (s) => s
  .replace(/<(sodipodi|inkscape):[\w-]+\b[^>]*\/>/g, '')                   // self-closing elements
  .replace(/<(sodipodi|inkscape):([\w-]+)\b[^>]*>[\s\S]*?<\/\1:\2>/g, '')  // paired elements
  .replace(/\s+(sodipodi|inkscape):[\w-]+="[^"]*"/g, '');                  // editor attributes

let before = 0, after = 0, n = 0, failed = [];
for (const f of readdirSync(DIR).filter((x) => x.endsWith('.svg'))) {
  const p = `${DIR}/${f}`;
  const s = readFileSync(p, 'utf8');
  const sz = Buffer.byteLength(s);
  try {
    const r = optimize(stripEditor(s), { ...config, path: p });
    writeFileSync(p, r.data);
    before += sz;
    after += Buffer.byteLength(r.data);
    n++;
  } catch (e) {
    failed.push(`${f}: ${e.message.split('\n')[0]}`);
  }
}
const mb = (b) => (b / 1048576).toFixed(0);
console.log(`minified ${n} svgs: ${mb(before)} MB -> ${mb(after)} MB (${(100 - (after / before) * 100).toFixed(0)}% smaller)`);
if (failed.length) console.log(`FAILED (${failed.length}):\n  ${failed.join('\n  ')}`);
