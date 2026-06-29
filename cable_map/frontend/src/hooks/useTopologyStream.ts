import { useEffect, useState } from 'react';
import { streamNamespaces, streamTopology, type Topology } from '../api';
import { preloadFrontPanel } from '../FrontPanel';

// Owns the live EDA connection: the namespace list, the selected namespace, and the topology
// snapshot/stream for it. Reconnecting on namespace change clears the topology first so stale
// data never lingers, and preloads each platform's front-panel stencil.
export function useTopologyStream() {
  const [topo, setTopo] = useState<Topology | null>(null);
  const [err, setErr] = useState('');
  const [namespace, setNamespace] = useState('');
  const [namespaces, setNamespaces] = useState<string[]>([]);
  const [namespacesReady, setNamespacesReady] = useState(false);

  // the EDA namespaces to choose from — streamed so the picker updates live.
  useEffect(() => streamNamespaces((next) => {
    setNamespaces(next);
    setNamespacesReady(true);
    setErr('');
    setNamespace((current) => (current && next.includes(current) ? current : (next[0] ?? '')));
  }, (msg) => {
    setNamespacesReady(true);
    setErr(msg);
  }), []);

  // live topology stream for the selected namespace — pushes the snapshot then live updates.
  useEffect(() => {
    setTopo(null);
    if (!namespace) {
      setErr((current) => current || (namespacesReady ? 'no namespaces with topology resources' : ''));
      return;
    }
    return streamTopology(namespace, (t) => { setTopo(t); setErr(''); }, setErr);
  }, [namespace, namespacesReady]);

  useEffect(() => {
    if (!topo) return;
    for (const platform of new Set(topo.nodes.map((node) => node.platform).filter(Boolean))) {
      void preloadFrontPanel(platform);
    }
  }, [topo]);

  return { topo, err, namespace, setNamespace, namespaces, namespacesReady };
}
