import { readFileSync } from 'node:fs';
import https from 'node:https';

export type TopoNode = { id: string; name: string; platform: string; os: string; role: string };
export type TopoEdge = {
  id: string; source: string; target: string;
  sourcePort: string; targetPort: string; type: string;
};
export type CableRow = { label: string; desc: string; remoteNode: string; remotePort: string; type: string };
export type Topology = {
  nodes: TopoNode[];
  links: TopoEdge[];
  tables: Record<string, CableRow[]>;
  occupied: Record<string, number[]>;
};

// minimal shapes of the EDA CRD JSON we read
type Meta = { name: string; labels?: Record<string, string> };
type RawNode = { metadata: Meta; spec?: { platform?: string; operatingSystem?: string }; status?: { platform?: string } };
type LinkEnd = { node?: string; interface?: string };
type RawLink = { metadata: Meta; spec?: { links?: { type?: string; local?: LinkEnd; remote?: LinkEnd }[] } };
type RawIface = { metadata: Meta; spec?: { description?: string } };

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
  for (const f of ifaces) {
    if (f.spec?.description) descOf.set(f.metadata.name, f.spec.description);
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

  const add = (node: string | undefined, port: string | undefined, remote: LinkEnd, type = '') => {
    if (!node) return;
    (tables[node] ||= []).push({
      label: portLabel(port), desc: descOf.get(portLabel(port)) || '',
      remoteNode: remote.node || '', remotePort: remote.interface ? portLabel(remote.interface) : '',
      type,
    });
    const idx = portIndex(port);
    if (idx) (occupied[node] ||= new Set()).add(idx);
  };

  for (const l of links) {
    for (const { local = {}, remote = {}, type = '' } of l.spec?.links || []) {
      add(local.node, local.interface, remote, type);
      add(remote.node, remote.interface, local, type);
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
  };
}
