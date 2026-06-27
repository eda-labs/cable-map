import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BASE } from './api';

// The stencil SVGs are self-describing: each cage <path> carries data-port="N". We read that
// mapping straight from the inlined SVG and colour the cages directly — there is no separate
// index list to keep in sync.

const OCCUPIED = '#00A87E';   // colour for a cabled (occupied) port

type StencilCache =
  | { state: 'pending'; promise: Promise<string | null> }
  | { state: 'ready'; svg: string }
  | { state: 'missing' };

const stencilCache = new Map<string, StencilCache>();

const stencilUrl = (platform: string) => `${BASE}frontpanel/${encodeURIComponent(platform)}.svg`;

function loadStencil(platform: string): Promise<string | null> {
  const cached = stencilCache.get(platform);
  if (cached?.state === 'ready') return Promise.resolve(cached.svg);
  if (cached?.state === 'missing') return Promise.resolve(null);
  if (cached?.state === 'pending') return cached.promise;

  const promise = fetch(stencilUrl(platform))
    .then((r) => { if (!r.ok) throw new Error('no stencil'); return r.text(); })
    .then((svg) => {
      stencilCache.set(platform, { state: 'ready', svg });
      return svg;
    })
    .catch(() => {
      stencilCache.set(platform, { state: 'missing' });
      return null;
    });
  stencilCache.set(platform, { state: 'pending', promise });
  return promise;
}

export function preloadFrontPanel(platform: string): Promise<boolean> {
  return loadStencil(platform).then((svg) => svg != null);
}

// The Cairo-exported stencils reuse generic ids (clip1, glyph0-1, …). Inlining several panels into
// one document (e.g. the PDF print page, one panel per node) makes their url(#…) / href="#…" refs
// collide and resolve to the first panel — clipping/borrowing the wrong shapes. Namespace per inline.
let inlineSeq = 0;
const isolateIds = (svg: string): string => {
  const uid = `fp${inlineSeq++}`;
  return svg
    .replace(/\bid="([^"]+)"/g, `id="${uid}-$1"`)
    .replace(/(\bhref)="#([^"]+)"/g, `$1="#${uid}-$2"`)
    .replace(/url\(#([^)]+)\)/g, `url(#${uid}-$1)`);
};

const applyMaxHeight = (svg: SVGSVGElement, maxHeight: number | string | undefined) => {
  svg.style.maxHeight = maxHeight == null ? ''
    : typeof maxHeight === 'number' ? `${maxHeight}px` : maxHeight;
};

const inlineStencil = (el: HTMLDivElement, svgText: string, maxHeight: number | string | undefined) => {
  el.innerHTML = isolateIds(svgText);
  const svg = el.querySelector('svg');
  if (!svg) return;
  // some stencils (Inkscape/EMF exports) ship width/height but no viewBox, so they can't
  // scale — synthesise one from the rendered content bounds before stripping the size.
  if (!svg.getAttribute('viewBox')) {
    try { const b = svg.getBBox(); svg.setAttribute('viewBox', `${b.x} ${b.y} ${b.width} ${b.height}`); } catch { /* not yet laid out */ }
  }
  svg.removeAttribute('width'); svg.removeAttribute('height');
  svg.style.width = '100%'; svg.style.height = 'auto'; svg.style.display = 'block';
  svg.style.margin = '0 auto';
  applyMaxHeight(svg, maxHeight);
};

type Props = {
  platform: string;
  occupied: string[];            // cage ids matching data-port ("<port>" or "<slot>-<port>")
  hovered?: string | null;
  onHover?: (port: string | null) => void;
  width?: number | string;
  // cap the rendered height so tall multi-RU chassis (e.g. 7220 IXR-H2) don't
  // fill the whole drawer; the SVG scales down and centres within this height.
  maxHeight?: number | string;
  // fired once the stencil has finished loading (inlined or fallen back) — the print page waits
  // for every panel before signalling data-print-ready, so the PDF never captures empty panels.
  onReady?: () => void;
};

export default function FrontPanel({ platform, occupied, hovered = null, onHover, width = '100%', maxHeight, onReady }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>('loading');
  const onReadyRef = useRef(onReady);
  const maxHeightRef = useRef(maxHeight);
  const notifiedForRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    onReadyRef.current = onReady;
    maxHeightRef.current = maxHeight;
  });

  // inline the stencil for this platform; fall back to a schematic if there is no SVG
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancelled = false;

    const notifyReady = () => {
      if (notifiedForRef.current === platform) return;
      notifiedForRef.current = platform;
      onReadyRef.current?.();
    };

    const cached = stencilCache.get(platform);
    if (cached?.state === 'ready') {
      inlineStencil(el, cached.svg, maxHeightRef.current);
      setState('ready');
      notifyReady();
      return () => { cancelled = true; };
    }
    if (cached?.state === 'missing') {
      el.innerHTML = '';
      setState('missing');
      notifyReady();
      return () => { cancelled = true; };
    }

    el.innerHTML = '';
    setState('loading');
    void loadStencil(platform).then((txt) => {
      if (cancelled) return;
      if (!txt) {
        el.innerHTML = '';
        setState('missing');
        notifyReady();
        return;
      }
      inlineStencil(el, txt, maxHeightRef.current);
      setState('ready');
      notifyReady();
    });
    return () => { cancelled = true; };
  }, [platform]);

  // apply / update the height cap (cheap: no re-inlining when the drawer resizes)
  useEffect(() => {
    if (state !== 'ready' || !ref.current) return;
    const svg = ref.current.querySelector('svg');
    if (!svg) return;
    applyMaxHeight(svg, maxHeight);
  }, [state, maxHeight]);

  // colour the cages from their embedded data-port on state/hover change
  useEffect(() => {
    if (state !== 'ready' || !ref.current) return;
    const cages = [...ref.current.querySelectorAll('svg path[data-port]')] as SVGPathElement[];
    const occ = new Set(occupied);
    const cleanups: Array<() => void> = [];
    for (const el of cages) {
      const port = el.dataset.port ?? '';
      const isOcc = occ.has(port);
      const isHot = hovered === port;
      el.style.vectorEffect = 'non-scaling-stroke';
      // some stencils draw connector graphics over the cage, hiding the fill. raise filled cages above
      // the decoration but below the port labels. Cairo stencils group cages (text lives outside the
      // group) so a group-local appendChild suffices; flat Inkscape stencils interleave cages, pins and
      // text as svg siblings, so lift the cage above every path by inserting it before the label block.
      if (isOcc) {
        const parent = el.parentNode as Element | null;
        const label = parent?.tagName.toLowerCase() === 'svg' ? parent.querySelector(':scope > text[data-added]') : null;
        if (label) parent!.insertBefore(el, label);
        else parent?.appendChild(el);
      }
      el.style.cursor = isOcc ? 'pointer' : '';
      // hovered port -> full blue fill; otherwise occupied -> single occupied colour
      el.style.fill = isHot ? '#6098FF' : isOcc ? OCCUPIED : '';
      el.style.fillOpacity = '';
      el.style.stroke = isOcc ? 'rgba(0,0,0,0.5)' : '';
      el.style.strokeWidth = isOcc ? '0.75px' : '';
      if (isOcc) {
        const onEnter = () => onHover?.(port);
        const onLeave = () => onHover?.(null);
        el.addEventListener('mouseenter', onEnter);
        el.addEventListener('mouseleave', onLeave);
        cleanups.push(() => {
          el.removeEventListener('mouseenter', onEnter);
          el.removeEventListener('mouseleave', onLeave);
        });
      }
    }
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [state, occupied, hovered, onHover]);

  if (state !== 'missing') {
    return <div className="fp" ref={ref} style={{ width, lineHeight: 0 }} />;
  }

  // Fallback: generated schematic for platforms with no stencil (always fixed/numeric ports).
  const occ = new Set(occupied);
  const maxPort = Math.max(32, ...occupied.map(Number).filter((n) => !Number.isNaN(n)), 0);
  return (
    <div className="fp-schematic" style={{ width }}>
      <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 4 }}>{platform || 'unknown'} — schematic (no stencil)</div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(maxPort, 32)}, 1fr)`, gap: 3 }}>
        {Array.from({ length: maxPort }, (_, i) => String(i + 1)).map((port) => {
          const isOcc = occ.has(port);
          return (
            <div key={port} title={`1/${port}`}
              onMouseEnter={() => isOcc && onHover?.(port)} onMouseLeave={() => isOcc && onHover?.(null)}
              style={{
                aspectRatio: '1 / 1.3', borderRadius: 2, fontSize: 9,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: isOcc ? OCCUPIED : '#2a2f3a',
                outline: hovered === port ? '2px solid #6098FF' : '1px solid #444',
                color: '#cbd5e1', cursor: isOcc ? 'pointer' : 'default',
              }}>{port}</div>
          );
        })}
      </div>
    </div>
  );
}
