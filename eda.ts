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

async function list<T>(plural: string): Promise<T[]> {
  const data = await getJson(`/apis/${GROUP[plural]}/v1/namespaces/${NS}/${plural}`) as { items?: T[] };
  return data.items || [];
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
export async function getTopology(): Promise<Topology> {
  const [nodes, links, ifaces] = await Promise.all([
    list<RawNode>('toponodes'),
    list<RawLink>('topolinks'),
    list<RawIface>('interfaces').catch(() => [] as RawIface[]),
  ]);
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

async function listWithRV(plural: string): Promise<{ items: RawItem[]; rv: string }> {
  const data = await getJson(`/apis/${GROUP[plural]}/v1/namespaces/${NS}/${plural}`) as
    { items?: RawItem[]; metadata?: { resourceVersion?: string } };
  return { items: data.items ?? [], rv: data.metadata?.resourceVersion ?? '0' };
}

// Open a long-lived watch and parse its newline-delimited JSON events (same wire shape the
// vscode-eda SSE reader handles). Resolves when k8s rotates the watch on its timeout.
function watch(plural: string, rv: string, onEvent: (e: WatchEvent) => void): Promise<void> {
  const path = `/apis/${GROUP[plural]}/v1/namespaces/${NS}/${plural}` +
    `?watch=true&resourceVersion=${rv}&allowWatchBookmarks=true&timeoutSeconds=1800`;
  return new Promise<void>((resolve, reject) => {
    const req = https.request({
      host: K8S_HOST, port: K8S_PORT, path, method: 'GET',
      ca: readFileSync(`${SA}/ca.crt`),
      headers: { authorization: `Bearer ${readFileSync(`${SA}/token`, 'utf8').trim()}` },
    }, (res) => {
      if ((res.statusCode ?? 0) >= 400) { res.resume(); reject(new Error(`watch ${plural} ${res.statusCode}`)); return; }
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

export type TopologyStream = {
  subscribe: (cb: (t: Topology) => void) => () => void;
  current: () => Topology | null;
};

// Live caches → debounced, de-duplicated rebuild → fan-out to SSE subscribers. The
// stringify guard means chatty interface status updates (counters etc.) that don't change
// our derived topology never reach the browser.
export function createTopologyStream(): TopologyStream {
  const caches: Record<string, Map<string, RawItem>> = {
    toponodes: new Map(), topolinks: new Map(), interfaces: new Map(),
  };
  const listeners = new Set<(t: Topology) => void>();
  let current: Topology | null = null;
  let lastJson = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  let started = false;

  const rebuild = () => {
    timer = null;
    const topo = buildTopology(
      [...caches.toponodes.values()] as unknown as RawNode[],
      [...caches.topolinks.values()] as unknown as RawLink[],
      [...caches.interfaces.values()] as unknown as RawIface[],
    );
    const json = JSON.stringify(topo);
    if (json === lastJson) return;
    lastJson = json; current = topo;
    for (const l of listeners) l(topo);
  };
  const schedule = () => { if (!timer) timer = setTimeout(rebuild, 300); };

  // Sequential by design: each iteration re-lists then holds open one watch until k8s rotates
  // it (or it errors), so the awaits genuinely depend on each other — not parallelisable.
  /* eslint-disable no-await-in-loop */
  async function run(plural: string): Promise<void> {
    const cache = caches[plural];
    for (;;) {
      try {
        const { items, rv } = await listWithRV(plural);
        cache.clear();
        for (const it of items) cache.set(it.metadata.name, it);
        schedule();
        await watch(plural, rv, (e) => {
          const name = e.object?.metadata?.name;
          if (!name) return;
          if (e.type === 'DELETED') cache.delete(name);
          else if (e.type === 'ADDED' || e.type === 'MODIFIED') cache.set(name, e.object!);
          else return;
          schedule();
        });
      } catch (e) {
        console.error(`[stream] ${plural}:`, e instanceof Error ? e.message : e);
        await new Promise((r) => setTimeout(r, 2000));   // 410 Gone / blip → re-list + rewatch
      }
    }
  }
  /* eslint-enable no-await-in-loop */

  const start = () => {
    if (started) return;
    started = true;
    for (const p of PLURALS) void run(p);
  };

  return {
    subscribe(cb) {
      start();
      listeners.add(cb);
      if (current) cb(current);
      return () => { listeners.delete(cb); };
    },
    current: () => current,
  };
}
