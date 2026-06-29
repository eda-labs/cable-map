import { memo, useEffect, useState } from 'react';
import Drawer from '@mui/material/Drawer';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import Tooltip from '@mui/material/Tooltip';
import IconButton from '@mui/material/IconButton';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import CloseIcon from '@mui/icons-material/CloseOutlined';
import SettingsEthernetIcon from '@mui/icons-material/SettingsEthernetOutlined';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import SvgGlyph from './SvgGlyph';
import pdfIcon from '../assets/icons/pdf.svg?raw';
import excelIcon from '../assets/icons/excel.svg?raw';
import type { Node, Topology } from '../domain/topology/contract';
import { exportXlsx } from '../xlsx';
import NodeView from '../NodeView';
import NodeDetails from '../NodeDetails';
import { type Mode } from '../theme';

interface NodeDrawerProps {
  node: Node | undefined;
  onOpenNode: (name: string | null) => void;
  mode: Mode;
  topo: Topology | null;
  pdfLoading: boolean;
  onExportPdf: (ids: string[]) => void;
}

// Memoized: with a stable onExportPdf, typing in the search box (an App state change) no longer
// re-renders the open drawer + its Monaco panel; it still re-renders when `node` changes.
function NodeDrawer({ node, onOpenNode, mode, topo, pdfLoading, onExportPdf }: NodeDrawerProps) {
  const [drawerTab, setDrawerTab] = useState(0);            // 0 = Ports, 1 = Details
  useEffect(() => { setDrawerTab(0); }, [node?.name]);      // reset to Ports when a new node opens
  const [drawerH, setDrawerH] = useState(() => Math.round(window.innerHeight * 0.6));

  // drag the top edge of the drawer to resize its height
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const move = (ev: PointerEvent) =>
      setDrawerH(Math.max(180, Math.min(window.innerHeight - 56, window.innerHeight - ev.clientY)));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <Drawer anchor="bottom" open={!!node} onClose={() => onOpenNode(null)}
      slotProps={{ paper: { sx: { height: drawerH, borderTopLeftRadius: 12, borderTopRightRadius: 12,
        // EDA form-panel surface (formBody) so the drawer + Monaco editor blend like EDA;
        // backgroundImage:none kills MUI's dark elevation overlay that lightens the paper
        bgcolor: mode === 'dark' ? '#1A222E' : '#FFFFFF', backgroundImage: 'none',
        display: 'flex', flexDirection: 'column' } } }}>
      {node && (
        <>
          <Box onPointerDown={startResize} title="Drag to resize"
            sx={{ cursor: 'ns-resize', py: 0.75, display: 'flex', justifyContent: 'center',
              '&:hover .puller': { bgcolor: 'text.secondary' } }}>
            <Box className="puller" sx={{ width: 40, height: 4, bgcolor: 'divider', borderRadius: 2 }} />
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, px: 3, py: 1.5 }}>
            <Typography variant="h6">{node.name}</Typography>
            <Chip size="small" label={node.platform} />
            <Box sx={{ flex: 1 }} />
            <Tooltip title="Download PDF">
              <IconButton size="small" sx={{ color: 'text.primary' }}
                disabled={pdfLoading}
                onClick={() => onExportPdf([node.name])}>
                {pdfLoading
                  ? <CircularProgress size={24} color="primary" /> // keep 24px or the toolbar shifts on swap
                  : <SvgGlyph src={pdfIcon} />}
              </IconButton>
            </Tooltip>
            {topo && (
              <Tooltip title="Download XLSX">
                <IconButton size="small" sx={{ color: 'text.primary' }}
                  onClick={() => { void exportXlsx(topo, [node.name]).catch(console.error); }}>
                  <SvgGlyph src={excelIcon} />
                </IconButton>
              </Tooltip>
            )}
            <IconButton onClick={() => onOpenNode(null)} size="small"><CloseIcon /></IconButton>
          </Box>
          <Divider />
          <Box sx={{ flex: 1, minHeight: 0, display: 'flex' }}>
            <Tabs orientation="vertical" value={drawerTab} onChange={(_, v) => setDrawerTab(v)}
              sx={{ borderRight: 1, borderColor: 'divider', minWidth: 44, flexShrink: 0,
                '& .MuiTab-root': { minWidth: 44, minHeight: 44 },
                '& .MuiSvgIcon-root': { fontSize: 18 } }}>
              <Tab icon={<SettingsEthernetIcon />} aria-label="Ports" />
              <Tab icon={<InfoOutlinedIcon />} aria-label="Details" />
            </Tabs>
            {drawerTab === 0 ? (
              <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, px: 3, py: 2, display: 'flex', flexDirection: 'column' }}>
                <NodeView node={node} rows={node.table}
                  showHeader={false} onOpenNode={onOpenNode} fillHeight
                  panelMaxHeight={Math.round(drawerH * 0.4)} />
              </Box>
            ) : (
              <Box sx={{ flex: 1, minWidth: 0, minHeight: 0 }}>
                <NodeDetails node={node} dark={mode === 'dark'} />
              </Box>
            )}
          </Box>
        </>
      )}
    </Drawer>
  );
}

export default memo(NodeDrawer);
