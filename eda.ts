import { readFileSync } from 'node:fs';
import https from 'node:https';

export type TopoNode = { id: string; name: string; platform: string; os: string; role: string };
export type TopoEdge = {
  id: string; source: string; target: string;
  sourcePort: string; targetPort: string; type: string;
};
// LLDP cross-check against the topolink's configured remote: ok = neighbour confirms the
// cabling, mismatch = a different neighbour is wired up, none = no neighbour seen (a host
// port, or a down/unplugged link).
export type LldpStatus = 'ok' | 'mismatch' | 'none';
export type CableRow = {
  label: string; desc: string; remoteNode: string; remotePort: string; type: string;
  lag?: string;   // LAG resource name (lag-…) when this port is bundled into a port-channel
  peer?: string;  // endpoint/server label for edge links whose remote node is external (empty)
  lldpStatus?: LldpStatus;
  lldpPeer?: string;   // LLDP-observed neighbour(s), "node port", for the table/tooltip
};
// One LAG/port-channel as EDA models it. `multihomed` is the real ESI test: EDA stamps a
// multihoming stanza (esi:auto) on EVERY generated LAG, so esi alone says nothing — the
// distinguishing signal is whether the member ports span >1 node (true ESI/MH) versus all
// sitting on one box (a plain local LAG).
export type LagInfo = {
  name: string;
  lacp: boolean;       // spec.lag.type === 'LACP' (vs Static)
  isl: boolean;        // role InterSwitch — a switch-to-switch bundle, not a host LAG
  multihomed: boolean; // members span >1 node
  mode: string;        // multihoming.mode, e.g. AllActive
  members: { node: string; port: string }[];
  nodes: string[];     // distinct member nodes
};
export type Topology = {
  nodes: TopoNode[];
  links: TopoEdge[];
  tables: Record<string, CableRow[]>;
  occupied: Record<string, number[]>;
  lags: Record<string, LagInfo>;
};

// minimal shapes of the EDA CRD JSON we read
type Meta = { name: string; labels?: Record<string, string> };
type RawNode = { metadata: Meta; spec?: { platform?: string; operatingSystem?: string }; status?: { platform?: string } };
type LinkEnd = { node?: string; interface?: string; interfaceResource?: string };
type RawLink = { metadata: Meta; spec?: { links?: { type?: string; local?: LinkEnd; remote?: LinkEnd }[] } };
type LagMember = { node?: string; interface?: string };
type IfNeighbor = { node?: string; interface?: string };
type RawIface = {
  metadata: Meta;
  spec?: {
    description?: string;
    type?: string;       // 'LAG' on a port-channel interface
    lag?: { type?: string; multihoming?: { esi?: string; mode?: string } };
    members?: LagMember[];
  };
  // LLDP lives in the operational status: each member port lists the neighbours it sees.
  status?: { members?: { node?: string; interface?: string; neighbors?: IfNeighbor[] }[] };
};

const NS = process.env.EDA_NAMESPACE || 'eda';
const K8S_HOST = 'kubernetes.default.svc';
const K8S_PORT = Number(443);
const SA = '/var/run/secrets/kubernetes.io/serviceaccount';

const GROUP: Record<string, string> = {
  toponodes: 'core.eda.nokia.com',
  topolinks: 'core.eda.nokia.com',
  interfaces: 'interfaces.eda.nokia.com',
};

function getJson(path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: K8S_HOST, port: K8S_PORT, path, method: 'GET',
        ca: readFileSync(`${SA}/ca.crt`),
        headers: { authorization: `Bearer ${readFileSync(`${SA}/token`, 'utf8').trim()}` },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if ((res.statusCode ?? 0) >= 400) return reject(new Error(`k8s ${path} ${res.statusCode}: ${body.slice(0, 200)}`));
          try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function list<T>(plural: string, ns: string): Promise<T[]> {
  const data = await getJson(`/apis/${GROUP[plural]}/v1/namespaces/${ns}/${plural}`) as { items?: T[] };
  return data.items || [];
}

// EDA namespaces (core.eda.nokia.com/Namespace) — each name is also the k8s namespace its
// topology lives in. Falls back to the namespaces that actually hold toponodes if the base
// RBAC can't read the Namespace CRD.
export async function listNamespaces(): Promise<string[]> {
  try {
    const data = await getJson('/apis/core.eda.nokia.com/v1/namespaces') as { items?: { metadata: { name: string } }[] };
    const names = (data.items ?? []).map((i) => i.metadata.name);
    if (names.length) return names;
  } catch { /* fall through to the toponode-derived list */ }
  try {
    const data = await getJson('/apis/core.eda.nokia.com/v1/toponodes') as { items?: { metadata: { namespace?: string } }[] };
    const names = [...new Set((data.items ?? []).map((i) => i.metadata.namespace).filter((n): n is string => !!n))];
    if (names.length) return names;
  } catch { /* fall through to the default */ }
  return [NS];
}

// numeric port index from an interface name (ethernet-1-12 / ethernet-1/12 -> 12).
export function portIndex(iface: string | undefined): number | null {
  const m = String(iface || '').match(/\d+\D+(\d+)\s*$/);   // last two numbers: slot, port
  return m ? Number(m[1]) : null;
}
// the interface name exactly as EDA returns it (e.g. ethernet-1-1).
export const portLabel = (iface: string | undefined): string => String(iface || '');

// Edge links to hosts carry no remote node (the server is outside the fabric); the only
// place the endpoint's identity lives is the topolink's own name. Strip the known node
// prefixes and the link-role token to get a compact label, e.g.
//   "leaf1-leaf2-mh-lag-server-d" -> "server-d", "leaf1-edge-server-a" -> "server-a".
const ROLE_PREFIX = /^(edge|local-lag|mh-lag|esi-lag|isl-lag|lag)-/;
export function peerLabel(linkName: string, nodes: Set<string>): string {
  let s = linkName;
  for (let changed = true; changed; ) {
    changed = false;
    for (const n of nodes) {
      if (s.startsWith(`${n}-`)) { s = s.slice(n.length + 1); changed = true; break; }
    }
  }
  return s.replace(ROLE_PREFIX, '') || linkName;
}

// LLDP reports interfaces with a slash (ethernet-1/32); topolinks/members use a dash
// (ethernet-1-32). Normalise so the two can be compared.
const normIf = (s: string | undefined): string => String(s || '').replace(/\//g, '-');

// Fetch from the live EDA API, then build.
export async function getTopology(nsList: string[] = [NS]): Promise<Topology> {
  const nodes: RawNode[] = [], links: RawLink[] = [], ifaces: RawIface[] = [];
  await Promise.all(nsList.map(async (ns) => {
    const [n, l, i] = await Promise.all([
      list<RawNode>('toponodes', ns),
      list<RawLink>('topolinks', ns),
      list<RawIface>('interfaces', ns).catch(() => [] as RawIface[]),
    ]);
    nodes.push(...n); links.push(...l); ifaces.push(...i);
  }));
  return buildTopology(nodes, links, ifaces);
}

// Pure: raw CRD item arrays -> {nodes, links, tables, occupied}. (Exported so a
// dev snapshot can be built from any source without touching the REST path.)
export function buildTopology(nodes: RawNode[], links: RawLink[], ifaces: RawIface[] = []): Topology {
  const descOf = new Map<string, string>();
  const lags: Record<string, LagInfo> = {};
  // node|interface  ->  the neighbours LLDP saw on that physical port
  const lldpByPort = new Map<string, { node: string; port: string }[]>();
  for (const f of ifaces) {
    if (f.spec?.description) descOf.set(f.metadata.name, f.spec.description);
    for (const m of f.status?.members ?? []) {
      const nbrs = (m.neighbors ?? []).filter((n) => n.node).map((n) => ({ node: n.node!, port: normIf(n.interface) }));
      if (m.node && m.interface && nbrs.length) lldpByPort.set(`${m.node}|${normIf(m.interface)}`, nbrs);
    }
    if (f.spec?.type === 'LAG') {
      const members = (f.spec.members || []).map((m) => ({ node: m.node || '', port: portLabel(m.interface) }));
      const memberNodes = [...new Set(members.map((m) => m.node).filter(Boolean))];
      lags[f.metadata.name] = {
        name: f.metadata.name,
        lacp: f.spec.lag?.type === 'LACP',
        isl: (f.metadata.labels?.['eda.nokia.com/role'] || '') === 'InterSwitch',
        multihomed: memberNodes.length > 1,
        mode: f.spec.lag?.multihoming?.mode || '',
        members,
        nodes: memberNodes,
      };
    }
  }

  const outNodes: TopoNode[] = nodes.map((n) => ({
    id: n.metadata.name,
    name: n.metadata.name,
    platform: n.spec?.platform || n.status?.platform || '',
    os: n.spec?.operatingSystem || '',
    role: n.metadata.labels?.['eda.nokia.com/role'] || '',
  }));
  const known = new Set(outNodes.map((n) => n.id));

  const edges: TopoEdge[] = [];
  const tables: Record<string, CableRow[]> = {};
  const occupied: Record<string, Set<number>> = {};

  const add = (node: string | undefined, port: string | undefined, remote: LinkEnd, type: string, linkName: string, iface?: string) => {
    if (!node) return;
    const row: CableRow = {
      label: portLabel(port), desc: descOf.get(portLabel(port)) || '',
      remoteNode: remote.node || '', remotePort: remote.interface ? portLabel(remote.interface) : '',
      type,
    };
    if (iface && iface.startsWith('lag-')) row.lag = iface;
    if (type === 'edge' && !remote.node) row.peer = peerLabel(linkName, known);
    // LLDP cross-check: does the neighbour this port actually sees match the configured remote?
    const observed = lldpByPort.get(`${node}|${normIf(port)}`) ?? [];
    if (observed.length) {
      row.lldpPeer = observed.map((n) => `${n.node} ${n.port}`).join(', ');
      if (type === 'interSwitch' && remote.node) {
        const expNode = remote.node, expPort = normIf(remote.interface);
        row.lldpStatus = observed.some((n) => n.node === expNode && n.port === expPort) ? 'ok' : 'mismatch';
      } else {
        row.lldpStatus = 'ok';   // a neighbour is present and nothing configured contradicts it
      }
    } else {
      row.lldpStatus = 'none';
    }
    (tables[node] ||= []).push(row);
    const idx = portIndex(port);
    if (idx) (occupied[node] ||= new Set()).add(idx);
  };

  for (const l of links) {
    for (const { local = {}, remote = {}, type = '' } of l.spec?.links || []) {
      add(local.node, local.interface, remote, type, l.metadata.name, local.interfaceResource);
      add(remote.node, remote.interface, local, type, l.metadata.name, remote.interfaceResource);
      if (local.node && remote.node && known.has(local.node) && known.has(remote.node)) {
        edges.push({
          id: l.metadata.name, source: local.node, target: remote.node,
          sourcePort: portLabel(local.interface), targetPort: portLabel(remote.interface), type,
        });
      }
    }
  }

  return {
    nodes: outNodes,
    links: edges,
    tables,
    occupied: Object.fromEntries(Object.entries(occupied).map(([k, v]) => [k, [...v]])),
    lags,
  };
}

// ---- live streaming via Kubernetes watch ------------------------------------------
// We already hold list+watch RBAC on the three CRDs (see service-account.yaml), so rather
// than poll we keep an in-memory cache per resource fed by a long-lived watch, and rebuild
// the topology whenever something relevant changes.
type RawItem = { metadata: { name: string; resourceVersion?: string } };
type WatchEvent = { type: string; object?: RawItem };
const PLURALS = ['toponodes', 'topolinks', 'interfaces'] as const;

async function listWithRV(plural: string, ns: string): Promise<{ items: RawItem[]; rv: string }> {
  const data = await getJson(`/apis/${GROUP[plural]}/v1/namespaces/${ns}/${plural}`) as
    { items?: RawItem[]; metadata?: { resourceVersion?: string } };
  return { items: data.items ?? [], rv: data.metadata?.resourceVersion ?? '0' };
}

// Open a long-lived watch and parse its newline-delimited JSON events (same wire shape the
// vscode-eda SSE reader handles). Resolves when k8s rotates the watch on its timeout.
function watchPath(path: string, onEvent: (e: WatchEvent) => void): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const req = https.request({
      host: K8S_HOST, port: K8S_PORT, path, method: 'GET',
      ca: readFileSync(`${SA}/ca.crt`),
      headers: { authorization: `Bearer ${readFileSync(`${SA}/token`, 'utf8').trim()}` },
    }, (res) => {
      if ((res.statusCode ?? 0) >= 400) { res.resume(); reject(new Error(`watch ${path} ${res.statusCode}`)); return; }
      res.setEncoding('utf8');
      let buf = '';
      res.on('data', (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) try { onEvent(JSON.parse(line) as WatchEvent); } catch { /* ignore partial line */ }
        }
      });
      res.on('end', resolve);
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

const watch = (plural: string, ns: string, rv: string, onEvent: (e: WatchEvent) => void) =>
  watchPath(`/apis/${GROUP[plural]}/v1/namespaces/${ns}/${plural}?watch=true&resourceVersion=${rv}&allowWatchBookmarks=true&timeoutSeconds=1800`, onEvent);

// The set of EDA namespaces, kept live by a cluster-wide watch of the Namespace CRD so the
// picker updates the moment one is created/deleted. Falls back to polling the toponode-derived
// list when the base RBAC can't watch the CRD.
const NS_PATH = '/apis/core.eda.nokia.com/v1/namespaces';
export type NamespaceStream = { subscribe: (cb: (names: string[]) => void) => () => void; current: () => string[] };

export function createNamespaceStream(): NamespaceStream {
  const names = new Set<string>();
  const listeners = new Set<(n: string[]) => void>();
  let current: string[] = [];
  let lastJson = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  let started = false;

  const rebuild = () => {
    timer = null;
    const sorted = [...names].toSorted();
    const json = JSON.stringify(sorted);
    if (json === lastJson) return;
    lastJson = json; current = sorted;
    for (const l of listeners) l(sorted);
  };
  const schedule = () => { if (!timer) timer = setTimeout(rebuild, 200); };

  /* eslint-disable no-await-in-loop */
  async function run(): Promise<void> {
    for (;;) {
      try {
        const data = await getJson(NS_PATH) as { items?: { metadata: { name: string } }[]; metadata?: { resourceVersion?: string } };
        names.clear();
        for (const i of data.items ?? []) names.add(i.metadata.name);
        schedule();
        await watchPath(`${NS_PATH}?watch=true&resourceVersion=${data.metadata?.resourceVersion ?? '0'}&allowWatchBookmarks=true&timeoutSeconds=1800`, (e) => {
          const name = e.object?.metadata?.name;
          if (!name) return;
          if (e.type === 'DELETED') names.delete(name);
          else if (e.type === 'ADDED' || e.type === 'MODIFIED') names.add(name);
          else return;
          schedule();
        });
      } catch (e) {
        console.error('[ns-stream]:', e instanceof Error ? e.message : e);
        try { names.clear(); for (const n of await listNamespaces()) names.add(n); schedule(); } catch { /* keep last */ }
        await new Promise((r) => setTimeout(r, 5000));   // CRD not watchable → poll the fallback
      }
    }
  }
  /* eslint-enable no-await-in-loop */

  return {
    subscribe(cb) {
      if (!started) { started = true; void run(); }
      listeners.add(cb);
      if (current.length) cb(current);
      return () => { listeners.delete(cb); };
    },
    current: () => current,
  };
}

export type TopologyStream = {
  subscribe: (cb: (t: Topology) => void) => () => void;
  current: () => Topology | null;
  setNamespaces: (nsList: string[]) => void;   // "All Namespaces" updates this as ns come/go
};

// Live caches → debounced, de-duplicated rebuild → fan-out to SSE subscribers. Watches each
// (namespace, resource) so "All Namespaces" simply merges several namespaces into one map.
// The stringify guard means chatty interface status updates (counters etc.) that don't change
// our derived topology never reach the browser.
export function createTopologyStream(nsList: string[]): TopologyStream {
  const caches = new Map<string, Map<string, RawItem>>();   // `${ns}|${plural}` -> name -> item
  const cacheOf = (ns: string, plural: string) => {
    const k = `${ns}|${plural}`;
    let m = caches.get(k);
    if (!m) { m = new Map(); caches.set(k, m); }
    return m;
  };
  const activeNs = new Set(nsList);
  const merged = (plural: string) => {
    const out: RawItem[] = [];
    for (const ns of activeNs) for (const v of cacheOf(ns, plural).values()) out.push(v);
    return out;
  };

  const listeners = new Set<(t: Topology) => void>();
  let current: Topology | null = null;
  let lastJson = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  let started = false;

  const rebuild = () => {
    timer = null;
    const topo = buildTopology(
      merged('toponodes') as unknown as RawNode[],
      merged('topolinks') as unknown as RawLink[],
      merged('interfaces') as unknown as RawIface[],
    );
    const json = JSON.stringify(topo);
    if (json === lastJson) return;
    lastJson = json; current = topo;
    for (const l of listeners) l(topo);
  };
  const schedule = () => { if (!timer) timer = setTimeout(rebuild, 300); };

  // One runner per (namespace, resource). Loops while its namespace stays active: each pass
  // re-lists then holds open a watch until k8s rotates it. Sequential awaits are the point, so
  // the loop genuinely depends on each step. A namespace dropped from the set ends its runners.
  /* eslint-disable no-await-in-loop */
  async function run(ns: string, plural: string): Promise<void> {
    const cache = cacheOf(ns, plural);
    while (activeNs.has(ns)) {
      try {
        const { items, rv } = await listWithRV(plural, ns);
        if (!activeNs.has(ns)) break;
        cache.clear();
        for (const it of items) cache.set(it.metadata.name, it);
        schedule();
        await watch(plural, ns, rv, (e) => {
          const name = e.object?.metadata?.name;
          if (!name) return;
          if (e.type === 'DELETED') cache.delete(name);
          else if (e.type === 'ADDED' || e.type === 'MODIFIED') cache.set(name, e.object!);
          else return;
          schedule();
        });
      } catch (e) {
        if (!activeNs.has(ns)) break;
        console.error(`[stream] ${ns}/${plural}:`, e instanceof Error ? e.message : e);
        await new Promise((r) => setTimeout(r, 2000));   // 410 Gone / blip → re-list + rewatch
      }
    }
  }
  /* eslint-enable no-await-in-loop */

  const startNs = (ns: string) => { for (const p of PLURALS) void run(ns, p); };

  const setNamespaces = (next: string[]) => {
    const wanted = new Set(next);
    for (const ns of wanted) if (!activeNs.has(ns)) { activeNs.add(ns); if (started) startNs(ns); }
    const remove: string[] = [];
    for (const ns of activeNs) if (!wanted.has(ns)) remove.push(ns);
    for (const ns of remove) {
      activeNs.delete(ns);                       // its runners exit on the next loop check
      for (const p of PLURALS) cacheOf(ns, p).clear();
    }
    schedule();
  };

  const start = () => {
    if (started) return;
    started = true;
    for (const ns of activeNs) startNs(ns);
  };

  return {
    subscribe(cb) {
      start();
      listeners.add(cb);
      if (current) cb(current);
      return () => { listeners.delete(cb); };
    },
    current: () => current,
    setNamespaces,
  };
}
