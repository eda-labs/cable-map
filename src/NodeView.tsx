import { useEffect, useRef, useState } from 'react';
import {
  Box, Paper, Typography, Table, TableHead, TableBody, TableRow, TableCell, Link,
} from '@mui/material';
import FrontPanel from './FrontPanel';
import { portIdx, type Node, type Row } from './api';

type Props = {
  node: Node;
  rows: Row[];
  occupied: number[];
  showHeader?: boolean;   // drawer shows its own header; print keeps this on
  interactive?: boolean;  // hover cross-highlight (off for print)
  onOpenNode?: (id: string) => void;   // jump to a remote node's drawer
  fillHeight?: boolean;   // drawer: panel fixed, only the table scrolls
};

// Front panel + cable matrix for one node, with port<->row hover cross-highlighting.
export default function NodeView({ node, rows, occupied, showHeader = true, interactive = true, onOpenNode, fillHeight = false }: Props) {
  const [hovered, setHovered] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // when a port is hovered, bring its row into view (no-op if already visible)
  useEffect(() => {
    if (hovered == null || !scrollRef.current) return;
    scrollRef.current.querySelector(`[data-port="${hovered}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [hovered]);

  const sorted = rows.slice().sort((a, b) => (portIdx(a.label) ?? 0) - (portIdx(b.label) ?? 0));
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
          onHover={interactive ? setHovered : undefined} />
      </Paper>

      <Box ref={scrollRef} sx={fillHeight ? { flex: 1, minHeight: 0, overflow: 'auto', mt: 2 } : { mt: 2 }}>
      <Table size="small" stickyHeader={fillHeight} sx={{ '& .MuiTableCell-root': { borderColor: 'divider' } }}>
        <TableHead>
          <TableRow>
            {['Port', 'Description', 'Type', 'Remote node', 'Remote port'].map((h) => (
              <TableCell key={h} sx={{ fontWeight: 600, bgcolor: 'background.paper' }}>{h}</TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {sorted.map((r, i) => {
            const port = portIdx(r.label);
            const isHot = interactive && hovered != null && port === hovered;
            return (
              <TableRow key={i} hover selected={isHot} data-port={port ?? undefined}
                sx={{ scrollMarginTop: '40px' }}  /* clear the sticky header on scroll-into-view */
                onMouseEnter={() => interactive && port && setHovered(port)}
                onMouseLeave={() => interactive && setHovered(null)}>
                <TableCell>{r.label}</TableCell>
                <TableCell>{r.desc || blank}</TableCell>
                <TableCell>{r.type === 'interSwitch' ? 'ISL' : r.type === 'edge' ? 'edge' : r.type}</TableCell>
                <TableCell>
                  {r.remoteNode
                    ? (onOpenNode
                        ? <Link component="button" underline="hover" sx={{ font: 'inherit' }}
                            onClick={() => onOpenNode(r.remoteNode)}>{r.remoteNode}</Link>
                        : r.remoteNode)
                    : blank}
                </TableCell>
                <TableCell>
                  {r.remotePort || blank}
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
