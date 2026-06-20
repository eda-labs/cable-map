// EDA REST data layer. Reads toponodes/topolinks/interfaces from the EDA API and
// builds the topology + per-node cable tables.
//
// Auth: either a static EDA_TOKEN, or a confidential client (EDA_CLIENT_ID +
// EDA_CLIENT_SECRET) the backend exchanges for a token via client_credentials and
// caches/refreshes itself. In-cluster, mount the eda-api client secret into these.
//
// TLS: no code — point Node at the EDA CA with NODE_EXTRA_CA_CERTS=/path/ca.crt
// (prod), or NODE_TLS_REJECT_UNAUTHORIZED=0 for the self-signed playground.

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
// the in-cluster EDA API service (svc :443 -> :9443)
const API = 'https://eda-api.eda-system.svc';
const REALM = process.env.EDA_REALM || 'eda';
const TOKEN_URL = process.env.EDA_TOKEN_URL ||
  `${API}/core/proxy/v1/identity/realms/${REALM}/protocol/openid-connect/token`;
const CLIENT_ID = process.env.EDA_CLIENT_ID || '';
const CLIENT_SECRET = process.env.EDA_CLIENT_SECRET || '';
const STATIC_TOKEN = process.env.EDA_TOKEN || '';

const GROUP: Record<string, string> = {
  toponodes: 'core.eda.nokia.com',
  topolinks: 'core.eda.nokia.com',
  interfaces: 'interfaces.eda.nokia.com',
};

let cached = { token: '', exp: 0 };
async function bearer(): Promise<string> {
  if (STATIC_TOKEN) return STATIC_TOKEN;
  if (cached.token && Date.now() / 1000 < cached.exp - 30) return cached.token;
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('no EDA auth: set EDA_TOKEN, or EDA_CLIENT_ID + EDA_CLIENT_SECRET');
  }
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
  });
  if (!res.ok) throw new Error(`token ${res.status}: ${await res.text()}`);
  const j = await res.json() as { access_token: string; expires_in?: number };
  cached = { token: j.access_token, exp: Date.now() / 1000 + (j.expires_in || 300) };
  return cached.token;
}

async function list<T>(plural: string): Promise<T[]> {
  const url = `${API}/apps/${GROUP[plural]}/v1/namespaces/${NS}/${plural}`;
  const get = async () => fetch(url, { headers: { authorization: `Bearer ${await bearer()}` } });
  let res = await get();
  if (res.status === 401 && !STATIC_TOKEN) {   // token expired mid-flight: refresh once
    cached = { token: '', exp: 0 };
    res = await get();
  }
  if (!res.ok) throw new Error(`EDA ${plural} ${res.status}: ${await res.text()}`);
  return (await res.json() as { items?: T[] }).items || [];
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
