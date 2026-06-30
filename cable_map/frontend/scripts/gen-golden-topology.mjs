import fs from 'node:fs';

const GOLDEN_OUT = new URL('../../operators/cable-map/internal/topology/testdata/golden-topology.json', import.meta.url);
const MIXED_SROS_OUT = new URL('../dev/fixtures/mixed-sros-topology.json', import.meta.url);
const LARGE_SCALE_OUT = new URL('../dev/fixtures/large-1000-topology.json', import.meta.url);
const AI_FABRIC_OUT = new URL('../dev/fixtures/ai-fabric-196-topology.json', import.meta.url);

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
const srosIface = (port, channel = 1) => `1/1/c${port}/${channel}`;

function makeRaw(name, platform, os, labels, namespace, components = undefined) {
  const spec = { platform, operatingSystem: os };
  if (components?.length) spec.component = components;
  return {
    apiVersion: 'core.eda.nokia.com/v1',
    kind: 'TopoNode',
    metadata: { name, namespace, labels },
    spec,
  };
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

function addFabricLag(lags, name, node, members) {
  lags[name] = {
    name,
    lacp: true,
    isl: true,
    multihomed: false,
    mode: 'AllActive',
    members: members.map((port) => ({ node, port })),
    nodes: [node],
  };
}

function addEndpointLag(lags, name, members, multihomed) {
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

function portNumber(label) {
  const matches = label.match(/\d+/g);
  if (!matches) return 0;
  if (matches.length >= 2) return Number(matches[1]) * 100 + Number(matches[2] ?? 0);
  return Number(matches[0]) * 100;
}

function sortTables(nodes) {
  for (const node of nodes) {
    node.table = node.table.toSorted((left, right) => portNumber(left.label) - portNumber(right.label) || left.remoteNode.localeCompare(right.remoteNode));
  }
}

function collectLabels(nodes) {
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

function topology(nodes, links, lags) {
  sortTables(nodes);
  return { nodes, links, lags, labels: collectLabels(nodes) };
}

function buildGoldenTopology() {
  const namespace = 'demo';
  const version = 'dev-golden';
  const nodes = [];
  const byName = new Map();
  const links = [];
  const lags = {};

  function addNode(name, role, platform, labels) {
    const node = {
      name,
      platform,
      os: 'srl',
      role,
      namespace,
      version,
      labels,
      table: [],
      raw: makeRaw(name, platform, 'srl', labels, namespace),
    };
    nodes.push(node);
    byName.set(name, node);
    return node;
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

      addFabricLag(lags, localLag, leaf.name, leafMembers);
      addFabricLag(lags, remoteLag, spine.name, spineMembers);
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
    addEndpointLag(lags, localLag, members, false);
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
    addEndpointLag(lags, lag, members, true);

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
        addEndpointLag(lags, breakoutLag, breakoutMembers, true);

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

  return topology(nodes, links, lags);
}

function buildMixedSrosTopology() {
  const namespace = 'dev-mixed-sros';
  const version = 'dev-mixed-sros';
  const nodes = [];
  const byName = new Map();
  const links = [];
  const lags = {};
  const nextPort = new Map();
  let physicalLinkIndex = 0;

  function addNode({ name, role, platform, os = 'srl', labels = {}, components }) {
    const allLabels = {
      'eda.nokia.com/role': role,
      'eda.nokia.com/os': os,
      'eda.nokia.com/dev-fixture': 'mixed-sros',
      ...labels,
    };
    const raw = makeRaw(name, platform, os, allLabels, namespace, components);
    raw.status = {
      platform,
      operatingSystem: os,
      version: os === 'sros' ? '24.7.r1' : '24.7.1',
      'node-state': 'connected',
    };
    const node = {
      name,
      platform,
      os,
      role,
      namespace,
      version,
      labels: allLabels,
      table: [],
      raw,
    };
    nodes.push(node);
    byName.set(name, node);
    return node;
  }

  function port(nodeName, channel = 1) {
    const node = byName.get(nodeName);
    const next = nextPort.get(nodeName) ?? 1;
    nextPort.set(nodeName, next + 1);
    return node.os === 'sros' ? srosIface(next, channel) : iface(next);
  }

  function addLink(aName, bName, desc, options = {}) {
    physicalLinkIndex += 1;
    const a = byName.get(aName);
    const b = byName.get(bName);
    const aPort = port(aName, options.aChannel ?? 1);
    const bPort = port(bName, options.bChannel ?? 1);
    const status = options.lldpStatus ?? lldpFor(physicalLinkIndex);
    const id = options.id ?? `mix-${aName}-${bName}-${physicalLinkIndex}`;

    a.table.push(row({
      label: aPort,
      desc,
      remoteNode: b.name,
      remotePort: bPort,
      type: 'interSwitch',
      lag: options.aLag,
      lldpStatus: status,
      lldpPeer: lldpPeerText(status, b.name, bPort),
    }));
    b.table.push(row({
      label: bPort,
      desc,
      remoteNode: a.name,
      remotePort: aPort,
      type: 'interSwitch',
      lag: options.bLag,
      lldpStatus: status,
      lldpPeer: lldpPeerText(status, a.name, aPort),
    }));
    links.push({
      id,
      source: a.name,
      target: b.name,
      sourcePort: aPort,
      targetPort: bPort,
      type: 'interSwitch',
    });
    return { aPort, bPort };
  }

  function addLaggedLinkPair(aName, bName, label) {
    const aLag = `lag-${label}-${aName}-local`;
    const bLag = `lag-${label}-${bName}-remote`;
    const aPorts = [];
    const bPorts = [];
    for (let member = 1; member <= 2; member += 1) {
      const { aPort, bPort } = addLink(aName, bName, `${label} member ${member}/2`, {
        id: `mix-${label}-${member}`,
        aLag,
        bLag,
      });
      aPorts.push(aPort);
      bPorts.push(bPort);
    }
    addFabricLag(lags, aLag, aName, aPorts);
    addFabricLag(lags, bLag, bName, bPorts);
  }

  function addEdge(nodeName, desc, peer, options = {}) {
    const node = byName.get(nodeName);
    const label = port(nodeName, options.channel ?? 1);
    node.table.push(row({
      label,
      desc,
      remotePort: options.remotePort ?? 'eth0',
      type: 'edge',
      lag: options.lag,
      peer,
      lldpStatus: 'none',
    }));
    return label;
  }

  addNode({
    name: 'mix-core-sr1',
    role: 'superspine',
    platform: '7750 SR-1',
    os: 'sros',
    labels: { 'eda.nokia.com/plane': 'plane-00' },
    components: [
      { kind: 'lineCard', type: 'i48-400g-qsfpdd-1', slot: '1' },
      { kind: 'mda', type: 'me12-100gb-qsfp28', slot: '1' },
      { kind: 'mda', type: 'me6-100gb-qsfp28', slot: '2' },
    ],
  });
  addNode({
    name: 'mix-spine-srl',
    role: 'spine',
    platform: '7220 IXR-H4',
    labels: { 'eda.nokia.com/pod': 'pod-00', 'eda.nokia.com/plane': 'plane-00' },
  });
  addNode({
    name: 'mix-spine-sros',
    role: 'spine',
    platform: '7750 SR-1s',
    os: 'sros',
    labels: { 'eda.nokia.com/pod': 'pod-00', 'eda.nokia.com/plane': 'plane-01' },
    components: [
      { kind: 'mda', type: 'ms18-100gb-qsfp28', slot: '1' },
      { kind: 'mda', type: 'ms4-400gb-qsfpdd+4-100gb-qsfp28', slot: '2' },
    ],
  });
  addNode({
    name: 'mix-border-sr2',
    role: 'borderleaf',
    platform: '7750 SR-2s',
    os: 'sros',
    labels: { 'eda.nokia.com/site': 'dc-a', 'eda.nokia.com/pod': 'edge' },
    components: [
      { kind: 'mda', type: 's36-400gb-qsfpdd', slot: '1' },
      { kind: 'mda', type: 's18-100gb-qsfp28', slot: '2' },
    ],
  });
  addNode({
    name: 'mix-leaf-d3l',
    role: 'leaf',
    platform: '7220 IXR-D3L',
    labels: { 'eda.nokia.com/pod': 'pod-00', 'eda.nokia.com/rack': 'rack-01' },
  });
  addNode({
    name: 'mix-leaf-d2',
    role: 'leaf',
    platform: '7220 IXR-D2',
    labels: { 'eda.nokia.com/pod': 'pod-00', 'eda.nokia.com/rack': 'rack-02' },
  });
  addNode({
    name: 'mix-leaf-h3',
    role: 'leaf',
    platform: '7220 IXR-H3',
    labels: { 'eda.nokia.com/pod': 'pod-00', 'eda.nokia.com/rack': 'rack-03' },
  });
  const sr1Leaf = addNode({
    name: 'mix-leaf-sr1',
    role: 'leaf',
    platform: '7750 SR-1',
    os: 'sros',
    labels: { 'eda.nokia.com/pod': 'pod-00', 'eda.nokia.com/rack': 'rack-04' },
    components: [{ kind: 'lineCard', type: 'i24-800g-qsfpdd-1', slot: '1' }],
  });
  sr1Leaf.breakouts = { 3: { channels: 4, speed: '100G' } };
  addNode({
    name: 'mix-leaf-sr1s',
    role: 'leaf',
    platform: '7750 SR-1s',
    os: 'sros',
    labels: { 'eda.nokia.com/pod': 'pod-00', 'eda.nokia.com/rack': 'rack-05' },
    components: [{ kind: 'mda', type: 'ms16-100gb-sfpdd+4-100gb-qsfp28', slot: '1' }],
  });
  addNode({
    name: 'mix-leaf-sxr',
    role: 'leaf',
    platform: '7730 SXR-1D-32D',
    os: 'srl',
    labels: { 'eda.nokia.com/pod': 'pod-00', 'eda.nokia.com/rack': 'rack-06' },
  });

  const srosVariants = [];
  function addSrosVariant(name, platform, components) {
    addNode({
      name,
      role: 'leaf',
      platform,
      os: 'sros',
      labels: { 'eda.nokia.com/pod': 'sros-variants', 'eda.nokia.com/rack': name },
      components,
    });
    srosVariants.push(name);
  }

  [
    ['mix-sros-sr1-46s', 'i40-200g-sfpdd+6-800g-qsfpdd-1'],
    ['mix-sros-sr1-92s', 'i80-200g-sfpdd+12-400g-qsfpdd-1'],
    ['mix-sros-sr1x-48d', 'i48-800g-qsfpdd-1x'],
    ['mix-sros-sr1x-92s', 'i80-200g-sfpdd+12-800g-qsfpdd-1x'],
    ['mix-sros-sr1se-imm', 'imm36-800g-qsfpdd'],
  ].forEach(([name, type]) => addSrosVariant(name, '7750 SR-1', [{ kind: 'lineCard', type, slot: '1' }]));

  addSrosVariant('mix-sros-sr1-mda-me12-me6', '7750 SR-1', [
    { kind: 'mda', type: 'me12-100gb-qsfp28', slot: '1' },
    { kind: 'mda', type: 'me6-100gb-qsfp28', slot: '2' },
  ]);
  addSrosVariant('mix-sros-sr1-iom-me6', '7750 SR-1', [
    { kind: 'lineCard', type: 'iom-1', slot: '1' },
    { kind: 'mda', type: 'me6-100gb-qsfp28', slot: '1-a' },
    { kind: 'connector', type: 'c10-10g', slot: '1-a-1' },
    { kind: 'connector', type: 'c10-10g', slot: '1-a-2' },
    { kind: 'connector', type: 'c10-10g', slot: '1-a-3' },
    { kind: 'connector', type: 'c10-10g', slot: '1-a-4' },
  ]);
  addSrosVariant('mix-sros-sr1se-direct', '7750 SR-1se');
  addSrosVariant('mix-sros-sr1s-s18', '7750 SR-1s', [{ kind: 'mda', type: 's18-100gb-qsfp28', slot: '1' }]);
  addSrosVariant('mix-sros-sr1s-s36', '7750 SR-1s', [{ kind: 'mda', type: 's36-400gb-qsfpdd', slot: '1' }]);
  addSrosVariant('mix-sros-sr2s-ms16-ms8', '7750 SR-2s', [
    { kind: 'mda', type: 'ms16-100gb-sfpdd+4-100gb-qsfp28', slot: '1' },
    { kind: 'mda', type: 'ms8-100gb-sfpdd+2-100gb-qsfp28', slot: '2' },
  ]);
  addSrosVariant('mix-sros-sr2se-x2-mse6', '7750 SR-2se', [
    { kind: 'mda', type: 'x2-s36-800g-qsfpdd-18.0t', slot: '1' },
    { kind: 'mda', type: 'mse6-800g-qsfpdd', slot: '2' },
  ]);
  addSrosVariant('mix-sros-sr2se-m36-mse24', '7750 SR-2se', [
    { kind: 'mda', type: 'm36-800g-qsfpdd', slot: '1' },
    { kind: 'mda', type: 'mse24-200g-sfpdd', slot: '2' },
  ]);

  addLink('mix-spine-srl', 'mix-core-sr1', 'core uplink');
  addLink('mix-spine-sros', 'mix-core-sr1', 'core uplink');
  addLink('mix-border-sr2', 'mix-spine-srl', 'border fabric');
  addLaggedLinkPair('mix-border-sr2', 'mix-spine-sros', 'border-sros-fabric');

  for (const leaf of ['mix-leaf-d3l', 'mix-leaf-d2', 'mix-leaf-h3', 'mix-leaf-sr1', 'mix-leaf-sr1s', 'mix-leaf-sxr', ...srosVariants]) {
    addLink(leaf, 'mix-spine-srl', 'leaf fabric A');
    addLink(leaf, 'mix-spine-sros', 'leaf fabric B');
  }

  addEdge('mix-leaf-d3l', 'single attached telemetry host', 'telemetry-01');
  const localLag = 'lag-mix-border-tools-local';
  const localMembers = [addEdge('mix-border-sr2', 'tools server bond member 1', 'tools-01', { lag: localLag, remotePort: 'eth0' }),
    addEdge('mix-border-sr2', 'tools server bond member 2', 'tools-01', { lag: localLag, remotePort: 'eth1' })]
    .map((member) => ({ node: 'mix-border-sr2', port: member }));
  addEndpointLag(lags, localLag, localMembers, false);

  const esiLag = 'lag-mix-app01-esi-local';
  const esiMembers = [
    { node: 'mix-leaf-d2', port: addEdge('mix-leaf-d2', 'multihomed app bond member A', 'app01', { lag: esiLag, remotePort: 'eth0' }) },
    { node: 'mix-leaf-sr1', port: addEdge('mix-leaf-sr1', 'multihomed app bond member B', 'app01', { lag: esiLag, remotePort: 'eth1', channel: 2 }) },
  ];
  addEndpointLag(lags, esiLag, esiMembers, true);

  return topology(nodes, links, lags);
}

function buildLargeScaleTopology() {
  const namespace = 'dev-scale-1000';
  const version = 'dev-scale-1000';
  const nodes = [];
  const byName = new Map();
  const links = [];
  const lags = {};
  const nextPort = new Map();
  let physicalLinkIndex = 0;

  function addNode(name, role, platform, labels, os = 'srl') {
    const allLabels = {
      'eda.nokia.com/role': role,
      'eda.nokia.com/os': os,
      'eda.nokia.com/dev-fixture': 'scale-1000',
      ...labels,
    };
    const node = {
      name,
      platform,
      os,
      role,
      namespace,
      version,
      labels: allLabels,
      table: [],
    };
    nodes.push(node);
    byName.set(name, node);
    return node;
  }

  function port(nodeName) {
    const node = byName.get(nodeName);
    const next = nextPort.get(nodeName) ?? 1;
    nextPort.set(nodeName, next + 1);
    return node.os === 'sros' ? srosIface(next) : iface(next);
  }

  function addLink(sourceName, targetName, desc) {
    physicalLinkIndex += 1;
    const source = byName.get(sourceName);
    const target = byName.get(targetName);
    const sourcePort = port(sourceName);
    const targetPort = port(targetName);
    const status = lldpFor(physicalLinkIndex);
    const id = `scale-${physicalLinkIndex}`;

    source.table.push(row({
      label: sourcePort,
      desc,
      remoteNode: target.name,
      remotePort: targetPort,
      type: 'interSwitch',
      lldpStatus: status,
      lldpPeer: lldpPeerText(status, target.name, targetPort),
    }));
    target.table.push(row({
      label: targetPort,
      desc,
      remoteNode: source.name,
      remotePort: sourcePort,
      type: 'interSwitch',
      lldpStatus: status,
      lldpPeer: lldpPeerText(status, source.name, sourcePort),
    }));
    links.push({
      id,
      source: source.name,
      target: target.name,
      sourcePort,
      targetPort,
      type: 'interSwitch',
    });
  }

  function addEdge(nodeName, index) {
    const node = byName.get(nodeName);
    const label = port(nodeName);
    node.table.push(row({
      label,
      desc: 'large scale endpoint',
      remotePort: 'eth0',
      type: 'edge',
      peer: `scale-srv-${pad(index, 4)}`,
      lldpStatus: 'none',
    }));
  }

  for (let i = 0; i < 20; i += 1) {
    addNode(`scale-super-${pad(i, 2)}`, 'superspine', SUPERSPINE_PLATFORM, {
      'eda.nokia.com/plane': `plane-${pad(i, 2)}`,
    });
  }
  for (let i = 0; i < 80; i += 1) {
    addNode(`scale-spine-${pad(i, 3)}`, 'spine', SPINE_PLATFORM, {
      'eda.nokia.com/pod': `pod-${pad(Math.floor(i / 2), 2)}`,
      'eda.nokia.com/plane': `plane-${pad(i % 20, 2)}`,
    });
  }
  for (let i = 0; i < 100; i += 1) {
    addNode(`scale-border-${pad(i, 3)}`, 'borderleaf', '7750 SR-1-48D', {
      'eda.nokia.com/pod': `edge-${pad(Math.floor(i / 10), 2)}`,
      'eda.nokia.com/rack': `border-${pad(i % 10, 2)}`,
    }, 'sros');
  }
  const leafPlatforms = ['7220 IXR-D3L', '7220 IXR-D2', '7220 IXR-D4', '7730 SXR-1D-32D'];
  for (let i = 0; i < 800; i += 1) {
    const srosLeaf = i % 20 === 0;
    addNode(`scale-leaf-${pad(i, 4)}`, 'leaf', srosLeaf ? '7750 SR-1-24D' : leafPlatforms[i % leafPlatforms.length], {
      'eda.nokia.com/pod': `pod-${pad(Math.floor(i / 20), 2)}`,
      'eda.nokia.com/rack': `rack-${pad(i % 20, 2)}`,
    }, srosLeaf ? 'sros' : 'srl');
  }

  for (let i = 0; i < 80; i += 1) {
    addLink(`scale-spine-${pad(i, 3)}`, `scale-super-${pad(i % 20, 2)}`, 'spine core A');
    addLink(`scale-spine-${pad(i, 3)}`, `scale-super-${pad((i + 10) % 20, 2)}`, 'spine core B');
  }
  for (let i = 0; i < 100; i += 1) {
    addLink(`scale-border-${pad(i, 3)}`, `scale-spine-${pad((i * 2) % 80, 3)}`, 'border fabric A');
    addLink(`scale-border-${pad(i, 3)}`, `scale-spine-${pad((i * 2 + 1) % 80, 3)}`, 'border fabric B');
  }
  for (let i = 0; i < 800; i += 1) {
    const pod = Math.floor(i / 20);
    addLink(`scale-leaf-${pad(i, 4)}`, `scale-spine-${pad(pod * 2, 3)}`, 'leaf fabric A');
    addLink(`scale-leaf-${pad(i, 4)}`, `scale-spine-${pad(pod * 2 + 1, 3)}`, 'leaf fabric B');
    addEdge(`scale-leaf-${pad(i, 4)}`, i);
  }

  return topology(nodes, links, lags);
}

function buildAiFabricTopology() {
  const namespace = 'dev-ai-fabric-196';
  const version = 'dev-ai-fabric-196';
  const nodes = [];
  const byName = new Map();
  const links = [];
  const lags = {};
  const leafNextPort = new Map();
  let physicalLinkIndex = 0;

  function addNode(name, role, labels = {}) {
    const allLabels = {
      'eda.nokia.com/role': role,
      'eda.nokia.com/os': 'srl',
      'eda.nokia.com/dev-fixture': 'ai-fabric-196',
      ...labels,
    };
    const node = {
      name,
      platform: '7220 IXR-H2',
      os: 'srl',
      role,
      namespace,
      version,
      labels: allLabels,
      table: [],
      raw: makeRaw(name, '7220 IXR-H2', 'srl', allLabels, namespace),
    };
    nodes.push(node);
    byName.set(name, node);
    return node;
  }

  function leafPort(name) {
    const next = leafNextPort.get(name) ?? 1;
    leafNextPort.set(name, next + 1);
    return iface(next);
  }

  function addLink(sourceName, targetName, sourcePort, targetPort, desc) {
    physicalLinkIndex += 1;
    const source = byName.get(sourceName);
    const target = byName.get(targetName);
    const status = lldpFor(physicalLinkIndex);
    const id = `a${pad(physicalLinkIndex, 5)}`;

    source.table.push(row({
      label: sourcePort,
      desc,
      remoteNode: target.name,
      remotePort: targetPort,
      type: 'interSwitch',
      lldpStatus: status,
      lldpPeer: lldpPeerText(status, target.name, targetPort),
    }));
    target.table.push(row({
      label: targetPort,
      desc,
      remoteNode: source.name,
      remotePort: sourcePort,
      type: 'interSwitch',
      lldpStatus: status,
      lldpPeer: lldpPeerText(status, source.name, sourcePort),
    }));
    links.push({
      id,
      source: source.name,
      target: target.name,
      sourcePort,
      targetPort,
      type: 'interSwitch',
    });
  }

  for (let i = 1; i <= 128; i += 1) {
    addNode(`l${pad(i, 3)}`, 'leaf', {
      'eda.nokia.com/rack': `rack-${pad(i, 3)}`,
    });
  }
  for (let i = 1; i <= 64; i += 1) {
    addNode(`s${pad(i, 3)}`, 'spine', {
      'eda.nokia.com/plane': `plane-${pad(((i - 1) % 16) + 1, 2)}`,
    });
  }
  for (let i = 1; i <= 4; i += 1) {
    addNode(`ss${i}`, 'superspine', {
      'eda.nokia.com/plane': `plane-${pad(i, 2)}`,
    });
  }

  for (let spineIndex = 1; spineIndex <= 64; spineIndex += 1) {
    const spineName = `s${pad(spineIndex, 3)}`;
    const skippedLeaves = new Set();
    const skipStart = ((spineIndex - 1) * 7) % 128;
    for (let offset = 0; offset < 7; offset += 1) {
      skippedLeaves.add(((skipStart + offset) % 128) + 1);
    }

    let spinePort = 1;
    for (let leafIndex = 1; leafIndex <= 128; leafIndex += 1) {
      if (skippedLeaves.has(leafIndex)) continue;
      const leafName = `l${pad(leafIndex, 3)}`;
      addLink(leafName, spineName, leafPort(leafName), iface(spinePort), 'leaf-spine 800G');
      spinePort += 1;
    }

    for (let superIndex = 1; superIndex <= 4; superIndex += 1) {
      addLink(spineName, `ss${superIndex}`, iface(spinePort), iface(spineIndex), 'spine-superspine 800G');
      spinePort += 1;
    }
  }

  return topology(nodes, links, lags);
}

function writeTopology(out, topo) {
  fs.mkdirSync(new URL('.', out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(topo, null, 2)}\n`);
  const rowCount = topo.nodes.reduce((sum, node) => sum + node.table.length, 0);
  console.log(`wrote ${out.pathname}`);
  console.log(`${topo.nodes.length} nodes, ${topo.links.length} fabric links, ${Object.keys(topo.lags).length} lags, ${rowCount} table rows`);
}

writeTopology(GOLDEN_OUT, buildGoldenTopology());
writeTopology(MIXED_SROS_OUT, buildMixedSrosTopology());
writeTopology(LARGE_SCALE_OUT, buildLargeScaleTopology());
writeTopology(AI_FABRIC_OUT, buildAiFabricTopology());
