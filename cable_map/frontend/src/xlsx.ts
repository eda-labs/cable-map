import type { Cell } from 'write-excel-file/browser';
import type { LagInfo, Topology } from './domain/topology/contract';
import { portIdx } from './domain/ports/interfaceNames';
import { edgeRemote } from './edge-remote';

// readable LAG classification for the spreadsheet's LAG column
const lagLabel = (lag?: LagInfo): string =>
  !lag ? '' : lag.isl ? 'ISL-LAG' : lag.multihomed ? 'ESI' : 'LAG';

// one sheet per node, so the Node column is redundant (the sheet name is the node)
const HEADERS = ['Port', 'Type', 'LAG', 'Remote node', 'Remote port', 'Description', 'LLDP neighbor', 'LLDP'];
const WIDTHS = [16, 8, 9, 18, 16, 30, 22, 9];

// Excel sheet names: <=31 chars, none of \ / ? * [ ] :, and unique. Returns a per-call namer.
function sheetNamer(): (id: string) => string {
  const used = new Set<string>();
  return (id) => {
    const base = (id.replace(/[\\/?*[\]:]/g, '_').slice(0, 31) || 'node');
    let name = base;
    for (let i = 1; used.has(name.toLowerCase()); i++) {
      const suffix = `~${i}`;
      name = base.slice(0, 31 - suffix.length) + suffix;
    }
    used.add(name.toLowerCase());
    return name;
  };
}

// Export the per-node cable tables as a workbook with ONE SHEET PER NODE (the same data the
// on-screen table and PDF show). Done fully client-side from the already-loaded topology; the
// library is lazy-loaded on first use.
export async function exportXlsx(topo: Topology, nodeIds: string[]): Promise<void> {
  const { default: writeXlsxFile } = await import('write-excel-file/browser');

  const header: Cell[] = HEADERS.map((h) => ({ value: h, fontWeight: 'bold' }));
  const columns = WIDTHS.map((width) => ({ width }));
  const name = sheetNamer();
  const byName = new Map(topo.nodes.map((n) => [n.name, n]));

  const sheets = nodeIds.map((id) => ({
    sheet: name(id),
    columns,
    data: [
      header,
      ...(byName.get(id)?.table ?? [])
        .toSorted((a, b) => (portIdx(a.label) ?? 0) - (portIdx(b.label) ?? 0))
        .map((r): Cell[] => [
          r.label,
          r.type === 'interSwitch' ? 'ISL' : r.type,
          lagLabel(r.lag ? topo.lags[r.lag] : undefined) || null,
          r.type === 'edge' ? (edgeRemote.get(id, r.label, 'node') || null) : (r.remoteNode || r.peer || null),
          r.type === 'edge' ? (edgeRemote.get(id, r.label, 'port') || null) : (r.remotePort || null),
          r.desc || null,
          r.lldpPeer || null,
          r.lldpStatus && r.lldpStatus !== 'none' ? r.lldpStatus : null,
        ]),
    ],
  }));

  const tag = nodeIds.length && nodeIds.length < topo.nodes.length ? `-${nodeIds.join('_')}` : '';
  const file = await writeXlsxFile(sheets);
  await file.toFile(`cable-map${tag}.xlsx`);
}
