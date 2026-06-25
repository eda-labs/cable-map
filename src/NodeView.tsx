import { useEffect, useRef, useState } from 'react';
import {
  Box, Paper, Typography, Table, TableHead, TableBody, TableRow, TableCell, Link,
} from '@mui/material';
import FrontPanel from './FrontPanel';
import RemoteCell from './RemoteCell';
import { portIdx, cageKey, type Node, type Row } from './api';
import { slottedOf } from './graph';

type Props = {
  node: Node;
  rows: Row[];
  showHeader?: boolean;   // drawer shows its own header; print keeps this on
  interactive?: boolean;  // drawer: editable remote cells + hover cross-highlight; print: read-only
  onOpenNode?: (id: string) => void;   // jump to a remote node's drawer
  fillHeight?: boolean;   // drawer: panel fixed, only the table scrolls
  panelMaxHeight?: number | string;    // cap panel height so the table stays visible
  onPanelReady?: () => void;           // print: signals the front panel finished loading
};

// Front panel + cable matrix for one node, with port<->row hover cross-highlighting.
export default function NodeView({ node, rows, showHeader = true, interactive = true, onOpenNode, fillHeight = false, panelMaxHeight, onPanelReady }: Props) {
  const [hovered, setHovered] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // when a port is hovered, bring its row into view (no-op if already visible)
  useEffect(() => {
    if (hovered == null || !scrollRef.current) return;
    scrollRef.current.querySelector(`[data-port="${hovered}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [hovered]);

  // cage ids occupied by this node's cables, derived from the interface names (slot-aware) so the
  // panel highlights match the stencil's data-port on both fixed and modular chassis.
  const slotted = slottedOf(node.platform);
  const occupied = rows.map((r) => cageKey(r.label, slotted)).filter((c): c is string => c != null);
  const sorted = rows.toSorted((a, b) => (portIdx(a.label) ?? 0) - (portIdx(b.label) ?? 0));
  // print leaves empty cells blank (room to write); the drawer shows a dash
  const blank = interactive ? <Box component="span" color="text.disabled">—</Box> : null;

  return (
    <Box sx={fillHeight ? { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } : undefined}>
      {showHeader && (
        <Typography variant="h5" gutterBottom>
          {node.name}{' '}
          <Typography component="span" color="text.secondary" sx={{ fontSize: 14 }}>
            {node.platform}
          </Typography>
        </Typography>
      )}

      <Paper variant="outlined" className="fp-wrap" sx={{ p: 1, width: '100%', bgcolor: 'transparent', flexShrink: 0 }}>
        <FrontPanel platform={node.platform} occupied={occupied}
          hovered={interactive ? hovered : null}
          onHover={interactive ? setHovered : undefined}
          maxHeight={panelMaxHeight} onReady={onPanelReady} />
      </Paper>

      <Box ref={scrollRef} sx={fillHeight ? { flex: 1, minHeight: 0, overflow: 'auto', mt: 2 } : { mt: 2 }}>
        <Table size="small" stickyHeader={fillHeight} sx={{ '& .MuiTableCell-root': { borderColor: 'divider' } }}>
          <TableHead>
            <TableRow>
              {['Port', 'Description', 'Type', 'Remote node', 'Remote port', 'LLDP neighbor'].map((h) => (
                <TableCell key={h} sx={{ fontWeight: 600, bgcolor: 'background.paper' }}>{h}</TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {sorted.map((r) => {
              const cage = cageKey(r.label, slotted);
              const isHot = interactive && hovered != null && cage === hovered;
              return (
                <TableRow key={r.label} hover selected={isHot} data-port={cage ?? undefined}
                  sx={{ scrollMarginTop: '40px' }}  /* clear the sticky header on scroll-into-view */
                  onMouseEnter={() => interactive && cage && setHovered(cage)}
                  onMouseLeave={() => interactive && setHovered(null)}>
                  <TableCell>{r.label}</TableCell>
                  <TableCell>{r.desc || blank}</TableCell>
                  <TableCell>
                    {r.type === 'interSwitch' ? 'ISL' : r.type === 'edge' ? 'edge' : r.type}
                    {r.lag && <Box component="span" color="warning.main">{' (LAG)'}</Box>}
                  </TableCell>
                  {r.type === 'edge' ? (
                    <>
                      <TableCell>
                        <RemoteCell nodeId={node.name} port={r.label} field="node" placeholder="remote node…" editable={interactive} />
                      </TableCell>
                      <TableCell>
                        <RemoteCell nodeId={node.name} port={r.label} field="port" placeholder="remote port…" editable={interactive} />
                      </TableCell>
                    </>
                  ) : (
                    <>
                      <TableCell>
                        {r.remoteNode
                          ? (onOpenNode
                              ? <Link component="button" underline="hover" sx={{ font: 'inherit' }}
                                  onClick={() => onOpenNode(r.remoteNode)}>{r.remoteNode}</Link>
                              : r.remoteNode)
                          : r.peer
                            ? <Box component="span" color="text.secondary">{r.peer}</Box>
                            : blank}
                      </TableCell>
                      <TableCell>
                        {r.remotePort || blank}
                      </TableCell>
                    </>
                  )}
                  <TableCell>
                    {r.lldpStatus === 'mismatch'
                      ? <Box component="span" color="error.main" sx={{ fontWeight: 600 }}>⚠ {r.lldpPeer}</Box>
                      : r.lldpPeer
                        ? <Box component="span" color="success.main">{r.lldpPeer}</Box>
                        : blank}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Box>
    </Box>
  );
}
