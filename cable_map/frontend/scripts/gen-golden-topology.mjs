import fs from 'node:fs';

const OUT = new URL('../cable_map/operators/cable-map/internal/topology/testdata/golden-topology.json', import.meta.url);

const LEAF_COUNT = 80;
const SPINE_COUNT = 16;
const SUPERSPINE_COUNT = 4;
const POD_SIZE = 20;
const FOUR_CHANNEL_BREAKOUT_PAIR_COUNT = 6;
const EIGHT_CHANNEL_BREAKOUT_PAIR_COUNT = 1;
const BREAKOUT_PAIR_COUNT = FOUR_CHANNEL_BREAKOUT_PAIR_COUNT + EIGHT_CHANNEL_BREAKOUT_PAIR_COUNT;
const BREAKOUT_PARENT_PORT = 8;

const LEAF_PLATFORM = '7220 IXR-D3L';
const SPINE_PLATFORM = '7220 IXR-H4';
const SUPERSPINE_PLATFORM = '7220 IXR-H5-64D';

const pad = (value, width) => String(value).padStart(width, '0');
const iface = (port) => `ethernet-1-${port}`;
const breakoutIface = (port, channel) => `ethernet-1-${port}-${channel}`;

const nodes = [];
const byName = new Map();
const links = [];
const lags = {};

function makeRaw(name, role, platform, labels) {
  return {
    apiVersion: 'core.eda.nokia.com/v1',
    kind: 'TopoNode',
    metadata: { name, namespace: 'demo', labels },
    spec: { platform, operatingSystem: 'srl' },
  };
}

function addNode(name, role, platform, labels) {
  const node = {
    name,
    platform,
    os: 'srl',
    role,
    namespace: 'demo',
    version: 'dev-golden',
    labels,
    table: [],
    raw: makeRaw(name, role, platform, labels),
  };
  nodes.push(node);
  byName.set(name, node);
  return node;
}

function row({ label, desc = '', remoteNode = '', remotePort = '', type, lag, peer, lldpStatus = 'ok', lldpPeer: peerText }) {
  const out = { label, desc, remoteNode, remotePort, type, lldpStatus };
  if (lag) out.lag = lag;
  if (peer) out.peer = peer;
  if (peerText) out.lldpPeer = peerText;
  return out;
}

function lldpFor(index) {
  if (index % 193 === 0) return 'none';
  if (index % 97 === 0) return 'mismatch';
  return 'ok';
}

function lldpPeerText(status, node, port) {
  if (status === 'none') return undefined;
  return status === 'mismatch' ? `${node} ${port}-unexpected` : `${node} ${port}`;
}

function addFabricLag(name, node, members, remoteNode) {
  lags[name] = {
    name,
    lacp: true,
    isl: true,
    multihomed: false,
    mode: 'AllActive',
    members: members.map((port) => ({ node, port })),
    nodes: [node],
    remoteNode,
  };
  delete lags[name].remoteNode;
}

function addEndpointLag(name, members, multihomed) {
  lags[name] = {
    name,
    lacp: true,
    isl: false,
    multihomed,
    mode: 'AllActive',
    members,
    nodes: [...new Set(members.map((m) => m.node))],
  };
}

function leafUsesBreakout(leafIndex) {
  return leafIndex < BREAKOUT_PAIR_COUNT * 2;
}

function breakoutChannelsForPair(pair) {
  if (pair < FOUR_CHANNEL_BREAKOUT_PAIR_COUNT) return 4;
  if (pair < BREAKOUT_PAIR_COUNT) return 8;
  return 0;
}

function breakoutChannelsForLeaf(leafIndex) {
  return breakoutChannelsForPair(Math.floor(leafIndex / 2));
}

function breakoutLagChannels(pair) {
  return breakoutChannelsForPair(pair) > 4 ? [2, 7] : [2, 3];
}

function leafFabricPort(leafIndex, bundle, member) {
  const port = bundle * 4 + member + 1;
  return leafUsesBreakout(leafIndex) && port === BREAKOUT_PARENT_PORT ? 9 : port;
}

for (let i = 0; i < SUPERSPINE_COUNT; i += 1) {
  addNode(`super-${pad(i, 2)}`, 'superspine', SUPERSPINE_PLATFORM, {
    'eda.nokia.com/role': 'superspine',
    'eda.nokia.com/plane': `plane-${pad(i % 4, 2)}`,
    'eda.nokia.com/golden': 'dev-fixture',
  });
}

for (let i = 0; i < SPINE_COUNT; i += 1) {
  const pod = Math.floor(i / 4);
  addNode(`spine-${pad(i, 3)}`, 'spine', SPINE_PLATFORM, {
    'eda.nokia.com/role': 'spine',
    'eda.nokia.com/pod': `pod-${pad(pod, 2)}`,
    'eda.nokia.com/plane': `plane-${pad(i % 4, 2)}`,
    'eda.nokia.com/golden': 'dev-fixture',
  });
}

for (let i = 0; i < LEAF_COUNT; i += 1) {
  const pod = Math.floor(i / POD_SIZE);
  const leaf = addNode(`leaf-${pad(i, 4)}`, 'leaf', LEAF_PLATFORM, {
    'eda.nokia.com/role': 'leaf',
    'eda.nokia.com/pod': `pod-${pad(pod, 2)}`,
    'eda.nokia.com/rack': `rack-${pad(i % POD_SIZE, 2)}`,
    'eda.nokia.com/golden': 'dev-fixture',
  });
  if (leafUsesBreakout(i)) {
    leaf.breakouts = {
      [String(BREAKOUT_PARENT_PORT)]: {
        channels: breakoutChannelsForLeaf(i),
        speed: breakoutChannelsForLeaf(i) > 4 ? '50G' : '100G',
      },
    };
  }
}

const spineNextPort = Array.from({ length: SPINE_COUNT }, () => 1);
let physicalLinkIndex = 0;

for (let leafIndex = 0; leafIndex < LEAF_COUNT; leafIndex += 1) {
  const leaf = byName.get(`leaf-${pad(leafIndex, 4)}`);
  const pod = Math.floor(leafIndex / POD_SIZE);
  const leafInPod = leafIndex % POD_SIZE;

  for (let bundle = 0; bundle < 2; bundle += 1) {
    const spineOffset = (leafInPod + bundle * 2) % 4;
    const spineIndex = pod * 4 + spineOffset;
    const spine = byName.get(`spine-${pad(spineIndex, 3)}`);
    const localLag = `lag-${leaf.name}-${spine.name}-fabric-${bundle + 1}-local`;
    const remoteLag = `lag-${leaf.name}-${spine.name}-fabric-${bundle + 1}-remote`;
    const leafMembers = [];
    const spineMembers = [];

    for (let member = 0; member < 4; member += 1) {
      physicalLinkIndex += 1;
      const leafPort = iface(leafFabricPort(leafIndex, bundle, member));
      const spinePort = iface(spineNextPort[spineIndex]);
      spineNextPort[spineIndex] += 1;
      const status = lldpFor(physicalLinkIndex);
      const id = `fabric-${leaf.name}-${spine.name}-${member + 1}`;

      leafMembers.push(leafPort);
      spineMembers.push(spinePort);
      leaf.table.push(row({
        label: leafPort,
        desc: `fabric ${spine.name} member ${member + 1}/4`,
        remoteNode: spine.name,
        remotePort: spinePort,
        type: 'interSwitch',
        lag: localLag,
        lldpStatus: status,
        lldpPeer: lldpPeerText(status, spine.name, spinePort),
      }));
      spine.table.push(row({
        label: spinePort,
        desc: `fabric ${leaf.name} member ${member + 1}/4`,
        remoteNode: leaf.name,
        remotePort: leafPort,
        type: 'interSwitch',
        lag: remoteLag,
        lldpStatus: status,
        lldpPeer: lldpPeerText(status, leaf.name, leafPort),
      }));
      links.push({
        id,
        source: leaf.name,
        target: spine.name,
        sourcePort: leafPort,
        targetPort: spinePort,
        type: 'interSwitch',
      });
    }

    addFabricLag(localLag, leaf.name, leafMembers, spine.name);
    addFabricLag(remoteLag, spine.name, spineMembers, leaf.name);
  }
}

const superspineNextPort = Array.from({ length: SUPERSPINE_COUNT }, () => 1);

for (let spineIndex = 0; spineIndex < SPINE_COUNT; spineIndex += 1) {
  const spine = byName.get(`spine-${pad(spineIndex, 3)}`);
  for (let member = 0; member < 2; member += 1) {
    physicalLinkIndex += 1;
    const superIndex = (spineIndex + member * (SUPERSPINE_COUNT / 2)) % SUPERSPINE_COUNT;
    const superNode = byName.get(`super-${pad(superIndex, 2)}`);
    const spinePort = iface(65 + member);
    const superPort = iface(superspineNextPort[superIndex]);
    superspineNextPort[superIndex] += 1;
    const status = lldpFor(physicalLinkIndex);
    const id = `core-${spine.name}-${superNode.name}-${member + 1}`;

    spine.table.push(row({
      label: spinePort,
      desc: `core ${superNode.name}`,
      remoteNode: superNode.name,
      remotePort: superPort,
      type: 'interSwitch',
      lldpStatus: status,
      lldpPeer: lldpPeerText(status, superNode.name, superPort),
    }));
    superNode.table.push(row({
      label: superPort,
      desc: `core ${spine.name}`,
      remoteNode: spine.name,
      remotePort: spinePort,
      type: 'interSwitch',
      lldpStatus: status,
      lldpPeer: lldpPeerText(status, spine.name, spinePort),
    }));
    links.push({
      id,
      source: spine.name,
      target: superNode.name,
      sourcePort: spinePort,
      targetPort: superPort,
      type: 'interSwitch',
    });
  }
}

for (let leafIndex = 0; leafIndex < LEAF_COUNT; leafIndex += 1) {
  const leaf = byName.get(`leaf-${pad(leafIndex, 4)}`);
  for (const [offset, suffix] of [[21, 'a'], [22, 'b']]) {
    leaf.table.push(row({
      label: iface(offset),
      desc: `edge server ${suffix}`,
      remotePort: 'eth0',
      type: 'edge',
      peer: `${leaf.name}-srv-${suffix}`,
      lldpStatus: 'none',
    }));
  }

  const localLag = `lag-${leaf.name}-server-bond-local`;
  const members = [23, 24].map((port) => ({ node: leaf.name, port: iface(port) }));
  addEndpointLag(localLag, members, false);
  for (const member of members) {
    leaf.table.push(row({
      label: member.port,
      desc: 'local server bond',
      remotePort: member.port.endsWith('-23') ? 'eth0' : 'eth1',
      type: 'edge',
      lag: localLag,
      peer: `${leaf.name}-bond-server`,
      lldpStatus: 'none',
    }));
  }
}

for (let pair = 0; pair < LEAF_COUNT / 2; pair += 1) {
  const a = byName.get(`leaf-${pad(pair * 2, 4)}`);
  const b = byName.get(`leaf-${pad(pair * 2 + 1, 4)}`);
  const pod = Math.floor((pair * 2) / POD_SIZE);
  const pairInPod = Math.floor(((pair * 2) % POD_SIZE) / 2);
  const lag = `lag-pod-${pad(pod, 2)}-esi-${pad(pairInPod, 2)}-${pad(pair, 3)}-local`;
  const peer = `pod-${pad(pod, 2)}-esi-${pad(pairInPod, 2)}`;
  const members = [a, b].map((node) => ({ node: node.name, port: iface(25) }));
  addEndpointLag(lag, members, true);

  for (const node of [a, b]) {
    node.table.push(row({
      label: iface(25),
      desc: 'multihomed ESI server bond',
      remotePort: node === a ? 'eth0' : 'eth1',
      type: 'edge',
      lag,
      peer,
      lldpStatus: 'none',
    }));
  }

  if (pair < BREAKOUT_PAIR_COUNT) {
    for (const channel of breakoutLagChannels(pair)) {
      const breakoutLag = `lag-pod-${pad(pod, 2)}-esi-${pad(pairInPod, 2)}-${pad(pair, 3)}-bo${channel}-local`;
      const breakoutPeer = `pod-${pad(pod, 2)}-esi-${pad(pairInPod, 2)}-bo${channel}`;
      const breakoutMembers = [a, b].map((node) => ({
        node: node.name,
        port: breakoutIface(BREAKOUT_PARENT_PORT, channel),
      }));
      addEndpointLag(breakoutLag, breakoutMembers, true);

      for (const node of [a, b]) {
        node.table.push(row({
          label: breakoutIface(BREAKOUT_PARENT_PORT, channel),
          desc: `breakout multihomed ESI server bond channel ${channel}`,
          remotePort: node === a ? `eth${channel - 2}` : `eth${channel}`,
          type: 'edge',
          lag: breakoutLag,
          peer: breakoutPeer,
          lldpStatus: 'none',
        }));
      }
    }
  }
}

function portNumber(label) {
  const matches = label.match(/\d+/g);
  if (!matches) return 0;
  if (matches.length >= 2) return Number(matches[1]) * 100 + Number(matches[2] ?? 0);
  return Number(matches[0]) * 100;
}

for (const node of nodes) {
  node.table = node.table.toSorted((left, right) => portNumber(left.label) - portNumber(right.label) || left.remoteNode.localeCompare(right.remoteNode));
}

function collectLabels() {
  const out = {};
  for (const node of nodes) {
    for (const [key, value] of Object.entries(node.labels ?? {})) {
      (out[key] ??= new Set()).add(value);
    }
  }
  return Object.fromEntries(
    Object.entries(out)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, values]) => [key, [...values].toSorted((left, right) => left.localeCompare(right))]),
  );
}

const topology = { nodes, links, lags, labels: collectLabels() };
fs.writeFileSync(OUT, `${JSON.stringify(topology, null, 2)}\n`);

const rowCount = nodes.reduce((sum, node) => sum + node.table.length, 0);
console.log(`wrote ${OUT.pathname}`);
console.log(`${nodes.length} nodes, ${links.length} fabric links, ${Object.keys(lags).length} lags, ${rowCount} table rows`);
