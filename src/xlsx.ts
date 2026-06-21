import type { Cell } from 'write-excel-file/browser';
import type { Topology, LagInfo } from './api';
import { portIdx } from './api';

// readable LAG classification for the spreadsheet's LAG column
const lagLabel = (lag?: LagInfo): string =>
  !lag ? '' : lag.isl ? 'ISL-LAG' : lag.multihomed ? 'ESI' : 'LAG';

const HEADERS = ['Node', 'Port', 'Type', 'LAG', 'Remote node', 'Remote port', 'Description', 'LLDP neighbor', 'LLDP'];
const WIDTHS = [12, 16, 8, 9, 18, 16, 30, 22, 9];

// Flatten the per-node cable tables (selected nodes, in topology order) into one sheet — the
// same data the on-screen table and the PDF show, but as a filterable spreadsheet. Done fully
// client-side from the already-loaded topology; the library is lazy-loaded on first use.
export async function exportXlsx(topo: Topology, nodeIds: string[]): Promise<void> {
  const { default: writeXlsxFile } = await import('write-excel-file/browser');

  const header: Cell[] = HEADERS.map((h) => ({ value: h, fontWeight: 'bold' }));
  const body: Cell[][] = nodeIds.flatMap((id) =>
    (topo.tables[id] ?? [])
      .toSorted((a, b) => (portIdx(a.label) ?? 0) - (portIdx(b.label) ?? 0))
      .map((r): Cell[] => [
        id,
        r.label,
        r.type === 'interSwitch' ? 'ISL' : r.type,
        lagLabel(r.lag ? topo.lags[r.lag] : undefined) || null,
        r.remoteNode || r.peer || null,
        r.remotePort || null,
        r.desc || null,
        r.lldpPeer || null,
        r.lldpStatus && r.lldpStatus !== 'none' ? r.lldpStatus : null,
      ]),
  );

  const tag = nodeIds.length && nodeIds.length < topo.nodes.length ? `-${nodeIds.join('_')}` : '';
  const file = await writeXlsxFile([header, ...body], {
    sheet: 'Cable Map',
    columns: WIDTHS.map((width) => ({ width })),
  });
  await file.toFile(`cablemap${tag}.xlsx`);
}
