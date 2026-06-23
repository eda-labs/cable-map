import { useEffect, useRef, type MouseEvent } from 'react';
import { Box, Link } from '@mui/material';
import { DataGrid, useGridApiRef, type GridColDef } from '@mui/x-data-grid';
import { portIdx, type Node, type Row } from './api';
import { edgeRemote } from './edge-remote';
import RemoteCell from './RemoteCell';

type GridRow = {
  id: string; label: string; port: number; typeLabel: string; lag?: string;
  desc: string; isEdge: boolean; remoteNode: string; remotePort: string;
  peer?: string; lldpPeer?: string; lldpStatus?: string;
};

// Filterable/sortable MUI-X grid of one node's cable table (EDA-styled). Used in the interactive
// drawer; the PDF keeps the plain table since DataGrid is virtualized/headless-unfriendly.
export default function NodeCableGrid({ node, rows, hovered, onHoverPort, onOpenNode }: {
  node: Node; rows: Row[]; hovered: number | null;
  onHoverPort: (p: number | null) => void; onOpenNode?: (id: string) => void;
}) {
  const apiRef = useGridApiRef();
  const rootRef = useRef<HTMLDivElement>(null);
  const overGrid = useRef(false);
  const gridRows: GridRow[] = rows.map((r) => {
    const isEdge = r.type === 'edge';
    return {
      id: r.label, label: r.label, port: portIdx(r.label) ?? 0,
      typeLabel: r.type === 'interSwitch' ? 'ISL' : r.type, lag: r.lag,
      desc: r.desc, isEdge,
      remoteNode: isEdge ? edgeRemote.get(node.id, r.label, 'node') : (r.remoteNode || r.peer || ''),
      remotePort: isEdge ? edgeRemote.get(node.id, r.label, 'port') : (r.remotePort || ''),
      peer: r.peer, lldpPeer: r.lldpPeer, lldpStatus: r.lldpStatus,
    };
  });

  const columns: GridColDef<GridRow>[] = [
    {
      field: 'label', headerName: 'Port', width: 130,
      sortComparator: (a, b) => (portIdx(a as string) ?? 0) - (portIdx(b as string) ?? 0),
    },
    {
      field: 'typeLabel', headerName: 'Type', width: 100,
      renderCell: ({ row }) => (
        <>{row.typeLabel}{row.lag && <Box component="span" color="warning.main">{' (LAG)'}</Box>}</>
      ),
    },
    { field: 'desc', headerName: 'Description', flex: 1, minWidth: 150 },
    {
      field: 'remoteNode', headerName: 'Remote node', width: 170,
      renderCell: ({ row }) =>
        row.isEdge
          ? <RemoteCell nodeId={node.id} port={row.label} field="node" placeholder="remote node…" editable />
          : !row.remoteNode ? null
            : (onOpenNode && !row.peer
                ? <Link component="button" underline="hover" sx={{ font: 'inherit' }} onClick={() => onOpenNode(row.remoteNode)}>{row.remoteNode}</Link>
                : <Box component="span" color={row.peer ? 'text.secondary' : undefined}>{row.remoteNode}</Box>),
    },
    {
      field: 'remotePort', headerName: 'Remote port', width: 140,
      renderCell: ({ row }) =>
        row.isEdge
          ? <RemoteCell nodeId={node.id} port={row.label} field="port" placeholder="remote port…" editable />
          : (row.remotePort || null),
    },
    {
      field: 'lldpPeer', headerName: 'LLDP neighbor', width: 180,
      renderCell: ({ row }) =>
        row.lldpStatus === 'mismatch'
          ? <Box component="span" color="error.main" sx={{ fontWeight: 600 }}>⚠ {row.lldpPeer}</Box>
          : row.lldpPeer ? <Box component="span" color="success.main">{row.lldpPeer}</Box> : null,
    },
  ];

  // port<->row hover cross-highlight, done at the DOM level so it survives DataGrid's row memoization:
  // row hover -> port via event delegation on the wrapper; hovered port -> row via a data-id CSS rule.
  const hoveredLabel = gridRows.find((r) => r.port === hovered)?.label;
  // scroll the hovered row into view. DataGrid virtualizes rows, so we scroll its virtual scroller
  // to the computed row offset — apiRef.scrollToIndexes jumps instantly, so go to the scroller
  // element directly for `behavior: 'smooth'`. Only scrolls when the row is off-view, and never when
  // the hover originates from the table itself (pointer over the grid) — only from the front panel.
  useEffect(() => {
    const api = apiRef.current;
    const scroller = rootRef.current?.querySelector('.MuiDataGrid-virtualScroller') as HTMLElement | null;
    if (overGrid.current || !hoveredLabel || !api?.getSortedRowIds || !scroller) return;
    const idx = api.getSortedRowIds().indexOf(hoveredLabel);
    if (idx < 0) return;
    const rowH = (scroller.querySelector('.MuiDataGrid-row') as HTMLElement | null)?.offsetHeight || 36;
    const target = idx * rowH;
    const { scrollTop, clientHeight } = scroller;
    if (target < scrollTop || target + rowH > scrollTop + clientHeight) {
      scroller.scrollTo({ top: target - (clientHeight - rowH) / 2, behavior: 'smooth' });
    }
  }, [hoveredLabel, apiRef]);

  const onMouseOver = (e: MouseEvent<HTMLElement>) => {
    overGrid.current = true;
    const id = (e.target as HTMLElement).closest('.MuiDataGrid-row')?.getAttribute('data-id');
    onHoverPort(id ? portIdx(id) ?? null : null);
  };
  const onMouseLeave = () => { overGrid.current = false; onHoverPort(null); };

  return (
    <Box ref={rootRef} onMouseOver={onMouseOver} onMouseLeave={onMouseLeave}
      sx={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex' }}>
      <DataGrid
        apiRef={apiRef}
        rows={gridRows}
        columns={columns}
        density="compact"
        disableRowSelectionOnClick
        hideFooter
        initialState={{ sorting: { sortModel: [{ field: 'label', sort: 'asc' }] } }}
        sx={{
          border: 0, height: '100%', width: '100%', fontSize: '0.875rem',
          bgcolor: 'transparent',
          // solid header/pinned surface = the EDA panel (background.paper). Opaque so rows don't
          // bleed under the sticky header on scroll; matches the drawer so it looks blended.
          '--DataGrid-containerBackground': 'var(--mui-palette-background-paper)',
          // grid borders/separators default to --mui-palette-TableCell-border (near-black); use the
          // EDA divider instead.
          '--DataGrid-t-color-border-base': 'var(--mui-palette-divider)',
          '& .MuiDataGrid-withBorderColor': { borderColor: 'var(--mui-palette-divider)' },
          '& .MuiDataGrid-columnSeparator': { color: 'var(--mui-palette-divider)' },
          '& .MuiDataGrid-columnHeaderTitle': { fontWeight: 500 },
          ...(hoveredLabel && {
            [`& .MuiDataGrid-row[data-id="${hoveredLabel}"], & .MuiDataGrid-row[data-id="${hoveredLabel}"]:hover`]:
              { bgcolor: 'action.selected' },
          }),
        }}
      />
    </Box>
  );
}
