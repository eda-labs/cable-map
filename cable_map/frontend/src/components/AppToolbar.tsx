import { memo } from 'react';
import AppBar from '@mui/material/AppBar';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Badge from '@mui/material/Badge';
import CircularProgress from '@mui/material/CircularProgress';
import Chip from '@mui/material/Chip';
import TextField from '@mui/material/TextField';
import FormControl from '@mui/material/FormControl';
import InputAdornment from '@mui/material/InputAdornment';
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import Checkbox from '@mui/material/Checkbox';
import ListItemText from '@mui/material/ListItemText';
import SearchIcon from '@mui/icons-material/SearchOutlined';
import LightModeIcon from '@mui/icons-material/LightModeOutlined';
import DarkModeIcon from '@mui/icons-material/DarkModeOutlined';
import SensorsIcon from '@mui/icons-material/SensorsOutlined';
import SvgGlyph from './SvgGlyph';
import pdfIcon from '../assets/icons/pdf.svg?raw';
import excelIcon from '../assets/icons/excel.svg?raw';
import { appPath } from '../api/base';
import type { Topology } from '../domain/topology/contract';
import { lldp as lldpStore, useLldp } from '../lldp';
import { exportXlsx } from '../xlsx';
import NamespacePicker from '../NamespacePicker';
import { type Mode } from '../theme';

interface AppToolbarProps {
  mode: Mode;
  onToggleMode: () => void;
  ready: boolean;
  topo: Topology | null;
  query: string;
  onQueryChange: (value: string) => void;
  searchError?: string;
  nodeLabelOptions: string[];
  selectedLabels: string[];
  onSelectedLabelsChange: (labels: string[]) => void;
  namespaces: string[];
  namespace: string;
  onNamespaceChange: (ns: string) => void;
  selected: string[];
  pdfLoading: boolean;
  onExportPdf: (ids: string[]) => void;
}

// Memoized: with stable callbacks (onToggleMode, onExportPdf) it skips re-render on App updates
// that don't change its props — e.g. panning a large topology. It owns `query` display so it still
// re-renders on each keystroke, as intended.
function AppToolbar({
  mode, onToggleMode, ready, topo, query, onQueryChange, searchError,
  nodeLabelOptions, selectedLabels, onSelectedLabelsChange,
  namespaces, namespace, onNamespaceChange, selected, pdfLoading, onExportPdf,
}: AppToolbarProps) {
  const lldpOn = useLldp();
  return (
    <AppBar position="static" elevation={0} sx={{ bgcolor: 'background.paper', borderBottom: 1, borderColor: 'divider' }}>
      <Toolbar variant="dense" sx={{ gap: 1.5, position: 'relative' }}>
        <img src={appPath('eda.svg')} alt="EDA" style={{ height: 26 }} />
        <Typography variant="h6" sx={{ fontWeight: 200, color: 'text.primary' }}>EDA Cable Map</Typography>
        <Box sx={{ flex: 1 }} />
        {ready && (
          <Box sx={{ position: 'absolute', left: '50%', top: 0, bottom: 0, transform: 'translateX(-50%)', display: 'flex', alignItems: 'center', gap: 0.75, width: 400, maxWidth: 400, overflow: 'hidden' }}>
            {/* Search locates matches by fitting the viewport; filtering is handled by the label dropdown. */}
            <TextField size="small" variant="outlined" value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              placeholder="Search node / port · /regex/"
              error={!!searchError}
              title={searchError}
              slotProps={{ input: { startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
                </InputAdornment>
              ) } }}
              sx={{
                flex: 1, minWidth: 0,
                '& .MuiOutlinedInput-root': { height: 31 },
                '& .MuiInputBase-input': { py: '3px' },
              }}
            />
          </Box>
        )}
        {ready && nodeLabelOptions.length > 0 && (
          <FormControl size="small" sx={{ width: 260 }}>
            <Select
              multiple
              displayEmpty
              value={selectedLabels}
              onChange={(e) => onSelectedLabelsChange(typeof e.target.value === 'string' ? e.target.value.split(',') : e.target.value)}
              renderValue={(sel) => sel.length === 0
                ? <Box component="span" sx={{ color: 'text.secondary' }}>Label filter</Box>
                : sel.length === 1 ? sel[0] : `${sel.length} labels`}
              inputProps={{ 'aria-label': 'Label filter' }}
              MenuProps={{ slotProps: { paper: { sx: { maxHeight: 360 } } } }}
              sx={{ height: 31 }}
            >
              {nodeLabelOptions.map((value) => (
                <MenuItem key={value} value={value} dense>
                  <Checkbox size="small" checked={selectedLabels.includes(value)} sx={{ py: 0, mr: 0.5 }} />
                  <ListItemText primary={value} slotProps={{ primary: { noWrap: true } }} />
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        )}
        {namespaces.length > 1 && namespace && (
          <NamespacePicker value={namespace} options={namespaces} onChange={onNamespaceChange} />
        )}
        {namespaces.length === 1 && namespace && (
          <Chip size="small" variant="outlined" label={namespace} sx={{ maxWidth: 180 }} />
        )}
        {ready && (
          <Tooltip title={selected.length ? `Download PDF (${selected.length} selected)` : 'Download PDF (all nodes)'}>
            <IconButton size="small" sx={{ color: 'text.primary' }}
              disabled={pdfLoading}
              onClick={() => onExportPdf(selected)}>
              <Badge badgeContent={selected.length} color="primary">
                {pdfLoading
                  ? <CircularProgress size={24} color="primary" /> // keep 24px or the toolbar shifts on swap
                  : <SvgGlyph src={pdfIcon} />}
              </Badge>
            </IconButton>
          </Tooltip>
        )}
        {ready && topo && (
          <Tooltip title={selected.length ? `Download XLSX (${selected.length} selected)` : 'Download XLSX (all nodes)'}>
            <IconButton size="small" sx={{ color: 'text.primary' }}
              onClick={() => { void exportXlsx(topo, selected.length ? selected : topo.nodes.map((n) => n.name)).catch(console.error); }}>
              <Badge badgeContent={selected.length} color="primary">
                <SvgGlyph src={excelIcon} />
              </Badge>
            </IconButton>
          </Tooltip>
        )}
        {ready && (
          <Tooltip title={lldpOn ? 'Hide LLDP overlay' : 'Show LLDP overlay (neighbour match / mismatch)'}>
            <IconButton size="small" sx={{ color: lldpOn ? 'success.main' : 'text.primary' }} onClick={() => lldpStore.toggle()}>
              <SensorsIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
        <Tooltip title={mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
          <IconButton size="small" sx={{ color: 'text.primary' }} onClick={onToggleMode}>
            {mode === 'dark' ? <LightModeIcon fontSize="small" /> : <DarkModeIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
      </Toolbar>
    </AppBar>
  );
}

export default memo(AppToolbar);
