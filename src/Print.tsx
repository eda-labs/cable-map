import { useEffect, useState } from 'react';
import { fetchTopology, BASE, type Topology } from './api';
import NodeView from './NodeView';
import { edgeRemote } from './edge-remote';
import './print.css';

// Printable page: one node per page (front panel + cable table). Puppeteer hits
// /print?nodes=a,b,c and prints to PDF. The data-ready flag lets networkidle0 wait.
export default function Print() {
  const [topo, setTopo] = useState<Topology | null>(null);
  useEffect(() => { fetchTopology().then(setTopo); }, []);
  useEffect(() => {
    const p = new URLSearchParams(location.search).get('remote');
    if (p) { try { edgeRemote.hydrate(JSON.parse(p)); } catch { /* malformed param */ } }
  }, []);
  // the app sets color-scheme:dark globally, which makes the PDF page background
  // black outside the content — force a white, light-scheme page for printing.
  useEffect(() => {
    document.documentElement.style.colorScheme = 'light';
    document.body.style.backgroundColor = '#fff';
  }, []);
  if (!topo) return <div>loading…</div>;

  const want = new URLSearchParams(location.search).get('nodes');
  const ids = want ? want.split(',').filter(Boolean) : topo.nodes.map((n) => n.id);
  const nodes = ids.map((id) => topo.nodes.find((n) => n.id === id)).filter(Boolean);

  return (
    <div className="print-root" data-print-ready="1">
      {nodes.map((n) => (
        <section key={n!.id} className="page">
          <div className="page-head">
            <div className="title">{n!.name} <span>{n!.platform}</span></div>
            <div className="page-brand">
              <img src={`${BASE}eda.svg`} alt="EDA" />
              <span className="cap">Cable Map</span>
            </div>
          </div>
          <NodeView node={n!} rows={topo.tables[n!.id] || []} occupied={topo.occupied[n!.id] || []}
            interactive={false} showHeader={false} />
        </section>
      ))}
    </div>
  );
}
