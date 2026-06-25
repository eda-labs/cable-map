// Derives src/frontpanel-meta.json from the stencil SVGs in public/frontpanel/. The SVGs are the
// single source of truth: ports = count of data-port cages; rows = distinct horizontal bands of their
// centres; layout = each port's normalised centre+size (0–1) within the cage bounding box, so the
// canvas node can place ports at their real on-panel locations. Re-run after editing/adding a stencil:
//   node scripts/gen-frontpanel-meta.mjs   (or: pnpm gen:frontpanel-meta)
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Diagonal affine (no rotation/skew) mapping a point inner->parent: (a·x+e, d·y+f).
const ID = { a: 1, d: 1, e: 0, f: 0 }
const compose = (o, i) => ({ a: o.a * i.a, d: o.d * i.d, e: o.a * i.e + o.e, f: o.d * i.f + o.f })
const nums = (s) => [...s.matchAll(/-?\d+\.?\d*/g)].map((m) => +m[0])
const round = (n) => +n.toFixed(4)
const pk = (p) => p.split('-').map(Number)
// inner->parent transform for a nested <svg> viewport: uniform xMidYMid-meet scale, then centre.
// Composites stack cards as nested viewports, so cage coords must be mapped through these to reach
// root space; a flat read would mix per-card coordinate systems.
function viewport(tag) {
  const at = (n) => +(tag.match(new RegExp(`\\b${n}="([^"]+)"`))?.[1] ?? 0)
  const x = at('x'), y = at('y'), W = at('width'), H = at('height')
  const vb = tag.match(/viewBox="([^"]+)"/)?.[1].split(/[\s,]+/).map(Number) ?? [0, 0, W, H]
  const [vx, vy, vw, vh] = vb
  const s = Math.min(W / vw, H / vh)
  return { a: s, d: s, e: x + (W - s * vw) / 2 - s * vx, f: y + (H - s * vh) / 2 - s * vy }
}

function readFrontpanelMeta(dir) {
  const out = {}
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.svg'))) {
    const svg = readFileSync(`${dir}/${file}`, 'utf8')
    // Walk svg-open / svg-close / path tags in document order, keeping a stack of the cumulative
    // nested-viewport transform so each cage's coords land in root space (matters for composites).
    // data-port is "<port>" on fixed chassis, "<slot>-<port>" on modular composites (each slot
    // restarts its counter, matching EDA's ethernet-<slot>-<port> naming).
    const cages = []
    const stack = []
    for (const m of svg.matchAll(/<svg\b[^>]*>|<\/svg>|<path\b[^>]*>/g)) {
      const tag = m[0]
      if (tag[1] === '/') { stack.pop(); continue }
      if (tag.startsWith('<svg')) { stack.push(stack.length === 0 ? ID : compose(stack[stack.length - 1], viewport(tag))); continue }
      const port = tag.match(/data-port="([^"]+)"/)?.[1]; if (!port) continue
      const pts = nums(tag.match(/\bd="([^"]+)"/)?.[1] ?? ''); if (pts.length < 4) continue
      const xs = [], yy = []
      for (let i = 0; i + 1 < pts.length; i += 2) { xs.push(pts[i]); yy.push(pts[i + 1]) }
      let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...yy), y1 = Math.max(...yy)
      const tm = tag.match(/transform="matrix\(([^)]+)\)"/)
      if (tm) { const p = tm[1].split(',').map(Number); x0 = p[0] * x0 + p[4]; x1 = p[0] * x1 + p[4]; y0 = p[3] * y0 + p[5]; y1 = p[3] * y1 + p[5] }
      const T = stack[stack.length - 1] ?? ID
      x0 = T.a * x0 + T.e; x1 = T.a * x1 + T.e; y0 = T.d * y0 + T.f; y1 = T.d * y1 + T.f
      cages.push({ p: port, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) })
    }
    if (!cages.length) continue
    // rows = distinct horizontal cage bands. The gap threshold is relative to the median cage height
    // so it works across exporters: Cairo coords run 0–1368 (cages ~30 tall), the flat SR-1/X-series
    // run 0–170 (cages ~3.5 tall) — an absolute threshold would collapse the flat panels to one row.
    const medH = cages.map((c) => c.h).toSorted((a, b) => a - b)[Math.floor(cages.length / 2)] || 1
    const ys = cages.map((c) => c.cy).toSorted((a, b) => a - b)
    let rows = 0, prev = -Infinity
    for (const y of ys) { if (y - prev > medH * 0.5) rows++; prev = y }
    // frame = the cage bounding box, so the ports fill the canvas panel with no chassis-body whitespace
    // around them. (Cage coords are already resolved to root space above, incl. composites.)
    const fx = Math.min(...cages.map((c) => c.cx - c.w / 2)), maxX = Math.max(...cages.map((c) => c.cx + c.w / 2))
    const fy = Math.min(...cages.map((c) => c.cy - c.h / 2)), maxY = Math.max(...cages.map((c) => c.cy + c.h / 2))
    const fw = (maxX - fx) || 1, fh = (maxY - fy) || 1
    // slotted (modular) when any cage id carries a "<slot>-" prefix; sort by slot then port
    const slotted = cages.some((c) => c.p.includes('-'))
    const layout = cages.map((c) => ({ p: c.p, x: round((c.cx - fx) / fw), y: round((c.cy - fy) / fh), w: round(c.w / fw), h: round(c.h / fh) }))
      .toSorted((a, b) => { const A = pk(a.p), B = pk(b.p); return (A[0] - B[0]) || ((A[1] ?? 0) - (B[1] ?? 0)) })
    out[file.slice(0, -4)] = { ports: cages.length, rows, aspect: round(fw / fh), slotted, layout }
  }
  return out
}

const dir = fileURLToPath(new URL('../public/frontpanel', import.meta.url))
const out = fileURLToPath(new URL('../src/frontpanel-meta.json', import.meta.url))
const meta = readFrontpanelMeta(dir)
writeFileSync(out, JSON.stringify(meta, null, 0) + '\n')
console.log(`wrote ${Object.keys(meta).length} platforms to src/frontpanel-meta.json`)
