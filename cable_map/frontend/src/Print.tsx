import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchTopology, BASE, type Topology } from './api';
import NodeView from './NodeView';
import { edgeRemote } from './edge-remote';
import './print.css';

// Printable page: one node per page (front panel + cable table). The PDF backend (chromedp) hits
// /print?nodes=a,b,c and waits for [data-print-ready="1"] before printing. That flag is only set once
// EVERY front panel has finished loading (stencil fetched + inlined, or fallen back) — otherwise the
// PDF can capture before the larger SVG panels load, dropping them.
export default function Print() {
  const [topo, setTopo] = useState<Topology | null>(null);
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const namespace = params.get('ns') ?? '';
  useEffect(() => { fetchTopology(namespace).then(setTopo); }, [namespace]);
  useEffect(() => {
    const p = params.get('remote');
    if (p) { try { edgeRemote.hydrate(JSON.parse(p)); } catch { /* malformed param */ } }
  }, [params]);
  // the app sets color-scheme:dark globally, which makes the PDF page background
  // black outside the content — force a white, light-scheme page for printing.
  useEffect(() => {
    document.documentElement.style.colorScheme = 'light';
    document.body.style.backgroundColor = '#fff';
  }, []);

  const nodes = useMemo(() => {
    if (!topo) return [];
    const want = params.get('nodes');
    const ids = want ? want.split(',').filter(Boolean) : topo.nodes.map((n) => n.name);
    return ids.map((id) => topo.nodes.find((n) => n.name === id)).filter((n) => !!n);
  }, [params, topo]);

  // signal readiness only after every front panel reports done (ready or missing)
  const total = nodes.length;
  const loaded = useRef(0);
  const [ready, setReady] = useState(false);
  const onPanelReady = useCallback(() => {
    loaded.current += 1;
    if (loaded.current >= total) setReady(true);
  }, [total]);
  useEffect(() => { if (topo && total === 0) setReady(true); }, [topo, total]);

  if (!topo) return <div>loading…</div>;

  return (
    <div className="print-root" data-print-ready={ready ? '1' : '0'}>
      {nodes.map((n) => (
        <section key={n.name} className="page">
          <div className="page-head">
            <div className="title">{n.name} <span>{n.platform}</span></div>
            <div className="page-brand">
              <img src={`${BASE}eda.svg`} alt="EDA" />
              <span className="cap">Cable Map</span>
            </div>
          </div>
          <NodeView node={n} rows={n.table}
            interactive={false} showHeader={false} onPanelReady={onPanelReady} />
        </section>
      ))}
    </div>
  );
}
