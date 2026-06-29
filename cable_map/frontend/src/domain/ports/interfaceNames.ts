const srosConnector = (label: string) => label.match(/(?:^|[/_-])c(\d+)(?:[/_-]|$)/i)?.[1] ?? null;

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
// Native SROS 1/1/c6/1 maps to "1-6" when slotted and "6" otherwise.
export function cageKey(label: string, slotted: boolean): string | null {
  const ns = label.match(/\d+/g);
  if (!ns) return null;
  const connector = srosConnector(label);
  const port = connector ?? (ns.length >= 2 ? ns[1] : ns[0]);
  if (slotted) return ns.length >= 2 ? `${ns[0]}-${port}` : port;
  return port;
}

// Breakout channel (1-based) if this interface is a broken-out sub-port, else null.
export function breakoutChannel(label: string): number | null {
  const nativeSros = label.match(/(?:^|[/_-])c\d+[/_-](\d+)$/i);
  if (nativeSros) return Number(nativeSros[1]);
  const ns = label.match(/\d+/g);
  return ns && ns.length >= 3 ? Number(ns[2]) : null;
}

// ethernet-1-12 -> "1-12" (matches the on-panel cage labelling)
export function shortPortLabel(iface: string): string {
  return iface.replace(/^ethernet-/, '').replace(/^et-/, '');
}
