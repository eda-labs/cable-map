import { memo, useCallback, useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import Tooltip from '@mui/material/Tooltip';
import IconButton from '@mui/material/IconButton';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import Tabs from '@mui/material/Tabs';
import Tab from '@mui/material/Tab';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUpOutlined';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDownOutlined';
import SettingsEthernetIcon from '@mui/icons-material/SettingsEthernetOutlined';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import ArticleOutlinedIcon from '@mui/icons-material/ArticleOutlined';
import SvgGlyph from './SvgGlyph';
import pdfIcon from '../assets/icons/pdf.svg?raw';
import excelIcon from '../assets/icons/excel.svg?raw';
import type { Node, Topology } from '../domain/topology/contract';
import { installGuideForPlatform } from '../domain/platform/installGuides';
import { exportXlsx } from '../xlsx';
import NodeView from '../NodeView';
import NodeDetails from '../NodeDetails';
import { trace } from '../trace';
import { type Mode } from '../theme';
import { type OpenNodeHandler } from './NodeActionsContext';

interface NodeDrawerProps {
  node: Node | undefined;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  resetSizeSignal: number;
  onOpenNode: OpenNodeHandler;
  mode: Mode;
  topo: Topology | null;
  pdfLoading: boolean;
  onExportPdf: (ids: string[]) => void;
  onHeightChange: (height: number) => void;
}

// A persistent bottom sheet: always present as a slim, draggable handle that pulls up to
// reveal the selected node's ports + details (or an empty placeholder when nothing is
// selected). Memoized so unrelated App state changes (e.g. typing in search) don't
// re-render the open sheet + its Monaco panel; it still re-renders when `node` changes.
const defaultDrawerHeight = () => Math.round(window.innerHeight * 0.6);

function NodeDrawer({ node, expanded, onExpandedChange, resetSizeSignal, onOpenNode, mode, topo, pdfLoading, onExportPdf, onHeightChange }: NodeDrawerProps) {
  const [drawerTab, setDrawerTab] = useState(0);            // 0 = Ports, 1 = Details
  const [drawerH, setDrawerH] = useState(defaultDrawerHeight);
  const [dragging, setDragging] = useState(false);          // suppresses the slide transition mid-drag
  const nodeName = node?.name;
  const installGuide = node ? installGuideForPlatform(node.platform) : undefined;
  const openLinkedNode = useCallback((name: string) => onOpenNode(name, { pan: true, pin: true, select: true }), [onOpenNode]);

  useEffect(() => {
    setDrawerTab(0);
  }, [nodeName]);

  useEffect(() => {
    setDrawerH(defaultDrawerHeight());
  }, [resetSizeSignal]);

  useEffect(() => {
    onHeightChange(drawerH);
  }, [drawerH, onHeightChange]);

  // drag any handle: live-resize while dragging (collapsing if pulled near the bottom),
  // or — when released without moving — toggle expanded/collapsed (so a plain click opens
  // the sheet). Listeners live on window so the drag survives the collapsed→expanded swap.
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    trace.suspendHover(true);
    setDragging(true);
    let moved = false;
    let collapseOnRelease = false;
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      trace.suspendHover(false);
      setDragging(false);
    };
    const move = (ev: PointerEvent) => {
      moved = true;
      const h = window.innerHeight - ev.clientY;
      collapseOnRelease = h < 120;
      if (collapseOnRelease) onExpandedChange(false);
      else { onExpandedChange(true); setDrawerH(Math.max(180, Math.min(window.innerHeight - 56, h))); }
    };
    const up = () => {
      cleanup();
      if (!moved) {
        onExpandedChange(!expanded);
      }
    };
    const cancel = () => cleanup();
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  };

  // EDA form-panel surface; backgroundImage:none kills MUI's dark elevation overlay so the
  // sheet + Monaco editor stay flat like EDA.
  const surface = mode === 'dark' ? '#1A222E' : '#FFFFFF';

  return (
    <>
      {/* Collapsed: a small centered handle inviting a pull-up. Centered so it sits between the
          bottom-left legend and bottom-right HUD and occludes neither; hidden once the sheet is up. */}
      {!expanded && (
        <Box onPointerDown={startDrag} title="Open node panel"
          sx={{ position: 'fixed', bottom: 0, left: '50%', transform: 'translateX(-50%)',
            zIndex: (t) => t.zIndex.drawer, cursor: 'ns-resize',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.25,
            px: 2.5, pt: 0.75, pb: 0.5, bgcolor: surface, backgroundImage: 'none',
            borderTopLeftRadius: 12, borderTopRightRadius: 12, boxShadow: 6,
            '&:hover .puller': { bgcolor: 'text.secondary' } }}>
          <Box className="puller" sx={{ width: 40, height: 4, bgcolor: 'divider', borderRadius: 2 }} />
          <KeyboardArrowUpIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
        </Box>
      )}

      {/* The sheet stays mounted and slides on the `expanded` toggle; while dragging the transition is
          off so it tracks the pointer 1:1. `inert` parks it out of tab/pointer reach while collapsed. */}
      <Box inert={!expanded}
        sx={{ position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: (t) => t.zIndex.drawer,
          height: drawerH, borderTopLeftRadius: 12, borderTopRightRadius: 12,
          bgcolor: surface, backgroundImage: 'none', boxShadow: 6,
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          transform: expanded ? 'translateY(0)' : 'translateY(calc(100% + 24px))', // +24px clears the box-shadow off-screen
          transition: dragging ? 'none' : 'transform 260ms cubic-bezier(0.32, 0.72, 0, 1)' }}>
      <Box onPointerDown={startDrag} title="Drag to resize"
        sx={{ cursor: 'ns-resize', py: 0.75, display: 'flex', justifyContent: 'center',
          '&:hover .puller': { bgcolor: 'text.secondary' } }}>
        <Box className="puller" sx={{ width: 40, height: 4, bgcolor: 'divider', borderRadius: 2 }} />
      </Box>
      {node ? (
        <>
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
            {installGuide && (
              <Tooltip title={`Open ${installGuide.family} installation guide`}>
                <IconButton component="a" href={installGuide.url} target="_blank" rel="noopener noreferrer"
                  aria-label={`Open ${installGuide.family} installation guide`} size="small" sx={{ color: 'text.primary' }}>
                  <ArticleOutlinedIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            )}
            <Tooltip title="Collapse">
              <IconButton onClick={() => onExpandedChange(false)} size="small"><KeyboardArrowDownIcon /></IconButton>
            </Tooltip>
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
                  showHeader={false} onOpenNode={openLinkedNode} fillHeight
                  panelMaxHeight={Math.round(drawerH * 0.4)} />
              </Box>
            ) : (
              <Box sx={{ flex: 1, minWidth: 0, minHeight: 0 }}>
                <NodeDetails node={node} dark={mode === 'dark'} />
              </Box>
            )}
          </Box>
        </>
      ) : (
        <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 1, color: 'text.secondary' }}>
          <SettingsEthernetIcon sx={{ fontSize: 32, color: 'text.disabled' }} />
          <Typography variant="body2">Select a node on the map to view its ports and details</Typography>
        </Box>
      )}
      </Box>
    </>
  );
}

export default memo(NodeDrawer);
