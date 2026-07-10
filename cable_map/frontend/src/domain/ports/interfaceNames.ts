const srosConnector = (label: string) => label.match(/(?:^|[/_-])c(\d+)(?:[/_-]|$)/i)?.[1] ?? null;

export type PortAddress = {
  kind: 'sros-native' | 'eda-physical' | 'ethernet';
  slot?: number;
  mda?: number;
  connector?: number;
  port: number;
  channel?: number;
};

const nativeSrosRE = /^(\d+)\/(\d+)\/c(\d+)(?:\/(\d+))?$/i;
const edaPhysicalRE = /^(?:ethernet-)?(\d+)-([a-z])-(\d+)(?:-(\d+))?$/i;

const mdaNumber = (letter: string): number => letter.toLowerCase().charCodeAt(0) - 96;
const mdaLetter = (number: number): string | null =>
  number >= 1 && number <= 26 ? String.fromCharCode(96 + number) : null;

// Parse the three interface forms the UI needs to correlate:
// native SR OS (1/1/c1/1), EDA physical (ethernet-1-a-1-1), and SR Linux ethernet-1-1[-1].
export function parsePortAddress(label: string): PortAddress | null {
  const value = label.trim();
  const native = nativeSrosRE.exec(value);
  if (native) {
    return {
      kind: 'sros-native',
      slot: Number(native[1]),
      mda: Number(native[2]),
      connector: Number(native[3]),
      port: Number(native[3]),
      channel: native[4] == null ? undefined : Number(native[4]),
    };
  }

  const physical = edaPhysicalRE.exec(value);
  if (physical) {
    return {
      kind: 'eda-physical',
      slot: Number(physical[1]),
      mda: mdaNumber(physical[2]),
      connector: Number(physical[3]),
      port: Number(physical[3]),
      channel: physical[4] == null ? undefined : Number(physical[4]),
    };
  }

  const ns = value.match(/\d+/g)?.map(Number);
  if (!ns?.length) return null;
  return {
    kind: 'ethernet',
    slot: ns.length >= 2 ? ns[0] : undefined,
    port: ns.length >= 2 ? ns[1] : ns[0],
    channel: ns.length >= 3 ? ns[2] : undefined,
  };
}

// Native SR OS -> EDA's physical connector/channel spelling, without the redundant ethernet prefix.
export function edaPhysicalAlias(label: string): string | null {
  const address = parsePortAddress(label);
  if (!address || address.kind !== 'sros-native' || address.slot == null || address.mda == null || address.connector == null) return null;
  const letter = mdaLetter(address.mda);
  if (!letter) return null;
  return `${address.slot}-${letter}-${address.connector}${address.channel == null ? '' : `-${address.channel}`}`;
}

export function detailedPortLabel(label: string): string {
  const alias = edaPhysicalAlias(label);
  return alias ? `${label} (${alias})` : label;
}

// EDA/SROS interface name -> front-panel cage index. For SRL names like ethernet-1-12,
// the cage is the 2nd number. For native SROS connector names like 1/1/c12/1, the cage
// is the c-number; the following number is a breakout channel and must not be captured.
export function portIdx(label: string): number | null {
  const connector = srosConnector(label);
  if (connector != null) return Number(connector);
  const ns = label.match(/\d+/g);
  if (!ns) return null;
  return Number(ns.length >= 2 ? ns[1] : ns[0]);
}

// Front-panel cage id matching the stencil's data-port. On modular (slotted) chassis a cage is
// addressed per slot, so the key is "<slot>-<port>"; on fixed chassis it's just the port.
// Native SROS 1/1/c6/1 maps to the stencil's panel-slot/cage key when modular and "6" otherwise.
export function cageKey(label: string, slotted: boolean, platform = ''): string | null {
  const address = parsePortAddress(label);
  if (!address) return null;
  if (!slotted) return String(address.connector ?? address.port);

  if ((address.kind === 'sros-native' || address.kind === 'eda-physical') && address.mda != null) {
    // SR-1/SR-1s composites number their two MDA bays 1/2. SR-2s/SR-2se flatten
    // XCM 1 a/b and XCM 2 a/b into the stencil's four panel slots 1..4.
    const panelSlot = /^7750 SR-2s(?:\s|$)|^7750 SR-2se(?:\s|$)/.test(platform)
      ? 2 * Math.max(0, (address.slot ?? 1) - 1) + address.mda
      : /^7750 SR-1(?:s)?(?:\s|$)/.test(platform)
        ? address.mda
        : address.slot ?? address.mda;
    return `${panelSlot}-${address.connector ?? address.port}`;
  }

  return address.slot == null ? String(address.port) : `${address.slot}-${address.port}`;
}

// Breakout channel (1-based) if this interface is a broken-out sub-port, else null.
export function breakoutChannel(label: string): number | null {
  return parsePortAddress(label)?.channel ?? null;
}

// ethernet-1-12 -> "1-12" (matches the on-panel cage labelling)
export function shortPortLabel(iface: string): string {
  return iface.replace(/^ethernet-/, '').replace(/^et-/, '');
}
