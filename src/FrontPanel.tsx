import { useEffect, useRef, useState } from 'react';
import PORTS from './frontpanel/ports.json';
import { BASE } from './api';

// ports.json: model -> ordered path-indices of the EXISTING cage <path> elements
// in the stencil (column-major). We colour those elements directly; we never draw
// our own overlay rects.
const portMap = PORTS as Record<string, number[]>;

const OCCUPIED = '#00A87E';   // colour for a cabled (occupied) port

type Props = {
  platform: string;
  occupied: number[];
  hovered?: number | null;
  onHover?: (port: number | null) => void;
  width?: number | string;
  // cap the rendered height so tall multi-RU chassis (e.g. 7220 IXR-H2) don't
  // fill the whole drawer; the SVG scales down and centres within this height.
  maxHeight?: number | string;
};

export default function FrontPanel({ platform, occupied, hovered = null, onHover, width = '100%', maxHeight }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false);
  const indices = portMap[platform];

  // inline the stencil once per platform
  useEffect(() => {
    if (!indices || !ref.current) return;
    let cancelled = false;
    setLoaded(false);
    fetch(`${BASE}frontpanel/${encodeURIComponent(platform)}.svg`)
      .then((r) => r.text())
      .then((txt) => {
        if (cancelled || !ref.current) return;
        ref.current.innerHTML = txt;
        const svg = ref.current.querySelector('svg');
        if (svg) {
          svg.removeAttribute('width'); svg.removeAttribute('height');
          svg.style.width = '100%'; svg.style.height = 'auto'; svg.style.display = 'block';
          svg.style.margin = '0 auto';
        }
        setLoaded(true);
      });
    return () => { cancelled = true; };
  }, [platform, indices]);

  // apply / update the height cap (cheap: no re-inlining when the drawer resizes)
  useEffect(() => {
    if (!loaded || !ref.current) return;
    const svg = ref.current.querySelector('svg');
    if (!svg) return;
    svg.style.maxHeight = maxHeight == null ? ''
      : typeof maxHeight === 'number' ? `${maxHeight}px` : maxHeight;
  }, [loaded, maxHeight]);

  // style the existing cage paths on state/hover change
  useEffect(() => {
    if (!loaded || !ref.current || !indices) return;
    const paths = ref.current.querySelectorAll('svg path');
    const occ = new Set(occupied);
    const cleanups: Array<() => void> = [];
    indices.forEach((pathIndex, i) => {
      const el = paths[pathIndex] as SVGPathElement | undefined;
      if (!el) return;
      const port = i + 1;
      const isOcc = occ.has(port);
      const isHot = hovered === port;
      el.dataset.port = String(port);
      el.style.cursor = isOcc ? 'pointer' : '';
      // hovered port -> full blue fill; otherwise occupied -> single occupied colour
      el.style.fill = isHot ? '#6098FF' : isOcc ? OCCUPIED : '';
      el.style.vectorEffect = 'non-scaling-stroke';
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
    });
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [loaded, indices, occupied, hovered, onHover]);

  if (indices) return <div className="fp" ref={ref} style={{ width, lineHeight: 0 }} />;

  // Fallback: generated schematic for platforms with no stencil/port map.
  const occ = new Set(occupied);
  const maxPort = Math.max(32, ...occupied, 0);
  return (
    <div className="fp-schematic" style={{ width }}>
      <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 4 }}>{platform || 'unknown'} — schematic (no stencil)</div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(maxPort, 32)}, 1fr)`, gap: 3 }}>
        {Array.from({ length: maxPort }, (_, i) => i + 1).map((port) => {
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
