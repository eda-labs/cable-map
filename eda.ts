import { readFileSync } from 'node:fs';
import https from 'node:https';

export type TopoNode = { id: string; name: string; platform: string; os: string; role: string };
export type TopoEdge = {
  id: string; source: string; target: string;
  sourcePort: string; targetPort: string; type: string;
};
export type CableRow = {
  label: string; desc: string; remoteNode: string; remotePort: string; type: string;
  lag?: string;   // LAG resource name (lag-…) when this port is bundled into a port-channel
  peer?: string;  // endpoint/server label for edge links whose remote node is external (empty)
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
type RawIface = {
  metadata: Meta;
  spec?: {
    description?: string;
    type?: string;       // 'LAG' on a port-channel interface
    lag?: { type?: string; multihoming?: { esi?: string; mode?: string } };
    members?: LagMember[];
  };
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
  for (const f of ifaces) {
    if (f.spec?.description) descOf.set(f.metadata.name, f.spec.description);
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
