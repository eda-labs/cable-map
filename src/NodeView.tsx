import { useEffect, useRef, useState } from 'react';
import {
  Box, Paper, Typography, Table, TableHead, TableBody, TableRow, TableCell, Link,
} from '@mui/material';
import FrontPanel from './FrontPanel';
import NodeCableGrid from './NodeCableGrid';
import RemoteCell from './RemoteCell';
import { portIdx, type Node, type Row } from './api';

type Props = {
  node: Node;
  rows: Row[];
  occupied: number[];
  showHeader?: boolean;   // drawer shows its own header; print keeps this on
  interactive?: boolean;  // drawer: filterable MUI-X grid + hover cross-highlight; print: plain table
  onOpenNode?: (id: string) => void;   // jump to a remote node's drawer
  fillHeight?: boolean;   // drawer: panel fixed, only the table scrolls
  panelMaxHeight?: number | string;    // cap panel height so the table stays visible
};

// Front panel + cable matrix for one node, with port<->row hover cross-highlighting.
export default function NodeView({ node, rows, occupied, showHeader = true, interactive = true, onOpenNode, fillHeight = false, panelMaxHeight }: Props) {
  const [hovered, setHovered] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // when a port is hovered, bring its row into view (no-op if already visible / in grid mode)
  useEffect(() => {
    if (hovered == null || !scrollRef.current) return;
    scrollRef.current.querySelector(`[data-port="${hovered}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [hovered]);

  const sorted = rows.toSorted((a, b) => (portIdx(a.label) ?? 0) - (portIdx(b.label) ?? 0));

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
          maxHeight={panelMaxHeight} />
      </Paper>

      <Box ref={scrollRef} sx={fillHeight ? { flex: 1, minHeight: 0, mt: 2, display: 'flex' } : { mt: 2 }}>
        {interactive ? (
          <NodeCableGrid node={node} rows={rows} hovered={hovered} onHoverPort={setHovered} onOpenNode={onOpenNode} />
        ) : (
          <Table size="small" sx={{ '& .MuiTableCell-root': { borderColor: 'divider' } }}>
            <TableHead>
              <TableRow>
                {['Port', 'Description', 'Type', 'Remote node', 'Remote port', 'LLDP neighbor'].map((h) => (
                  <TableCell key={h} sx={{ fontWeight: 600, bgcolor: 'background.paper' }}>{h}</TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {sorted.map((r) => (
                <TableRow key={r.label}>
                  <TableCell>{r.label}</TableCell>
                  <TableCell>{r.desc || null}</TableCell>
                  <TableCell>
                    {r.type === 'interSwitch' ? 'ISL' : r.type === 'edge' ? 'edge' : r.type}
                    {r.lag && <Box component="span" color="warning.main">{' (LAG)'}</Box>}
                  </TableCell>
                  {r.type === 'edge' ? (
                    <>
                      <TableCell><RemoteCell nodeId={node.id} port={r.label} field="node" placeholder="remote node…" editable={false} /></TableCell>
                      <TableCell><RemoteCell nodeId={node.id} port={r.label} field="port" placeholder="remote port…" editable={false} /></TableCell>
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
                            : null}
                      </TableCell>
                      <TableCell>{r.remotePort || null}</TableCell>
                    </>
                  )}
                  <TableCell>
                    {r.lldpStatus === 'mismatch'
                      ? <Box component="span" color="error.main" sx={{ fontWeight: 600 }}>⚠ {r.lldpPeer}</Box>
                      : r.lldpPeer
                        ? <Box component="span" color="success.main">{r.lldpPeer}</Box>
                        : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Box>
    </Box>
  );
}
