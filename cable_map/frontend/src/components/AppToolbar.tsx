import { memo, useMemo } from 'react';
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
import ListSubheader from '@mui/material/ListSubheader';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import SearchIcon from '@mui/icons-material/SearchOutlined';
import CloseIcon from '@mui/icons-material/CloseOutlined';
import LightModeIcon from '@mui/icons-material/LightModeOutlined';
import DarkModeIcon from '@mui/icons-material/DarkModeOutlined';
import SensorsIcon from '@mui/icons-material/SensorsOutlined';
import AccountTreeIcon from '@mui/icons-material/AccountTreeOutlined';
import ViewInArIcon from '@mui/icons-material/ViewInArOutlined';
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
  labelFilterText: string;
  onLabelFilterTextChange: (value: string) => void;
  namespaces: string[];
  namespace: string;
  onNamespaceChange: (ns: string) => void;
  exportNodeIds: string[];
  exportScope: 'all' | 'filtered' | 'selected';
  pdfLoading: boolean;
  onExportPdf: (ids: string[]) => void;
  viewMode: 'topology' | 'racks';
  onViewModeChange: (mode: 'topology' | 'racks') => void;
}

// Memoized: with stable callbacks (onToggleMode, onExportPdf) it skips re-render on App updates
// that don't change its props — e.g. panning a large topology. It owns `query` display so it still
// re-renders on each keystroke, as intended.
function AppToolbar({
  mode, onToggleMode, ready, topo, query, onQueryChange, searchError,
  nodeLabelOptions, selectedLabels, onSelectedLabelsChange, labelFilterText, onLabelFilterTextChange,
  namespaces, namespace, onNamespaceChange, exportNodeIds, exportScope, pdfLoading, onExportPdf,
  viewMode, onViewModeChange,
}: AppToolbarProps) {
  const lldpOn = useLldp();
  const labelFilterTerms = useMemo(
    () => labelFilterText.trim().toLowerCase().split(/\s+/).filter(Boolean),
    [labelFilterText],
  );
  const selectedLabelSet = useMemo(() => new Set(selectedLabels), [selectedLabels]);
  const visibleLabelOptions = useMemo(() => {
    if (labelFilterTerms.length === 0) return nodeLabelOptions;
    return nodeLabelOptions.filter((value) => {
      if (selectedLabelSet.has(value)) return true;
      const hay = value.toLowerCase();
      return labelFilterTerms.every((term) => hay.includes(term));
    });
  }, [labelFilterTerms, nodeLabelOptions, selectedLabelSet]);
  const labelFilterTextTrimmed = labelFilterText.trim();
  const labelFilterActive = selectedLabels.length > 0 || labelFilterTextTrimmed.length > 0;
  const exportCount = exportScope === 'all' ? 0 : exportNodeIds.length;
  const pdfTitle = exportScope === 'selected'
    ? `Download PDF (${exportNodeIds.length} selected)`
    : exportScope === 'filtered'
      ? `Download PDF (${exportNodeIds.length} filtered)`
      : 'Download PDF (all nodes)';
  const xlsxTitle = exportScope === 'selected'
    ? `Download XLSX (${exportNodeIds.length} selected)`
    : exportScope === 'filtered'
      ? `Download XLSX (${exportNodeIds.length} filtered)`
      : 'Download XLSX (all nodes)';
  return (
    <AppBar position="static" elevation={0} sx={{ bgcolor: 'background.paper', borderBottom: 1, borderColor: 'divider' }}>
      <Toolbar variant="dense" sx={{ gap: 1, position: 'relative', flexWrap: 'wrap', py: 0.5 }}>
        <img src={appPath('eda.svg')} alt="EDA" style={{ height: 26 }} />
        <Typography variant="h6" sx={{ fontWeight: 200, color: 'text.primary', display: { xs: 'none', sm: 'block' } }}>EDA Cable Map</Typography>
        {!ready && <Box sx={{ flex: 1 }} />}
        {ready && (
          <Box sx={{ order: { xs: 10, lg: 0 }, flex: { xs: '1 0 100%', lg: '1 1 240px' }, maxWidth: { xs: 'none', lg: 340 }, minWidth: { xs: '100%', lg: 180 }, display: 'flex', alignItems: 'center', gap: 0.75 }}>
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
          <FormControl size="small" sx={{ width: { xs: 180, md: 220, xl: 260 } }}>
            <Box sx={{ position: 'relative' }}>
              <Select
                multiple
                displayEmpty
                value={selectedLabels}
                onChange={(e) => onSelectedLabelsChange(typeof e.target.value === 'string' ? e.target.value.split(',') : e.target.value)}
                renderValue={(sel) => {
                  const selectedText = sel.length === 0 ? '' : sel.length === 1 ? sel[0] : `${sel.length} labels`;
                  if (!selectedText && !labelFilterTextTrimmed) {
                    return <Box component="span" sx={{ color: 'text.secondary' }}>Label filter</Box>;
                  }
                  return selectedText && labelFilterTextTrimmed
                    ? `${selectedText} · ${labelFilterTextTrimmed}`
                    : selectedText || labelFilterTextTrimmed;
                }}
                inputProps={{ 'aria-label': 'Label filter' }}
                MenuProps={{ slotProps: { paper: { sx: { maxHeight: 360 } } } }}
                sx={{
                  height: 31,
                  width: '100%',
                  '& .MuiSelect-select': labelFilterActive ? { pr: '64px !important' } : undefined,
                }}
              >
                <ListSubheader
                  sx={{ bgcolor: 'background.paper', lineHeight: 'normal', px: 1, py: 1 }}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                >
                  <TextField
                    size="small"
                    fullWidth
                    value={labelFilterText}
                    onChange={(e) => onLabelFilterTextChange(e.target.value)}
                    onKeyDown={(e) => e.stopPropagation()}
                    placeholder="Search labels"
                    slotProps={{ input: { startAdornment: (
                      <InputAdornment position="start">
                        <SearchIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
                      </InputAdornment>
                    ) } }}
                    sx={{
                      '& .MuiOutlinedInput-root': { height: 31 },
                      '& .MuiInputBase-input': { py: '3px' },
                    }}
                  />
                </ListSubheader>
                {visibleLabelOptions.map((value) => (
                  <MenuItem key={value} value={value} dense>
                    <Checkbox size="small" checked={selectedLabelSet.has(value)} sx={{ py: 0, mr: 0.5 }} />
                    <ListItemText primary={value} slotProps={{ primary: { noWrap: true } }} />
                  </MenuItem>
                ))}
                {visibleLabelOptions.length === 0 && (
                  <MenuItem disabled dense>
                    <ListItemText primary="No matching labels" slotProps={{ primary: { color: 'text.secondary' } }} />
                  </MenuItem>
                )}
              </Select>
              {labelFilterActive && (
                <Tooltip title="Clear label filter">
                  <IconButton
                    aria-label="Clear label filter"
                    size="small"
                    onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectedLabelsChange([]);
                      onLabelFilterTextChange('');
                    }}
                    sx={{
                      position: 'absolute',
                      right: 28,
                      top: '50%',
                      transform: 'translateY(-50%)',
                      zIndex: 1,
                      width: 24,
                      height: 24,
                      p: 0.25,
                      color: 'text.secondary',
                      '&:hover': { color: 'text.primary' },
                    }}
                  >
                    <CloseIcon sx={{ fontSize: 16 }} />
                  </IconButton>
                </Tooltip>
              )}
            </Box>
          </FormControl>
        )}
        {namespaces.length > 1 && namespace && (
          <NamespacePicker value={namespace} options={namespaces} onChange={onNamespaceChange} />
        )}
        {namespaces.length === 1 && namespace && (
          <Chip size="small" variant="outlined" label={namespace} sx={{ maxWidth: 180 }} />
        )}
        {ready && (
          <ToggleButtonGroup
            exclusive
            size="small"
            value={viewMode}
            onChange={(_, next) => {
              if (next === 'topology' || next === 'racks') onViewModeChange(next);
            }}
            aria-label="View mode"
            sx={{
              '& .MuiToggleButton-root': { height: 31, px: 1, gap: 0.5, color: 'text.secondary' },
              '& .Mui-selected': { color: 'primary.main' },
            }}
          >
            <ToggleButton value="topology" aria-label="Topology view">
              <AccountTreeIcon sx={{ fontSize: 18 }} />
              <Box component="span" sx={{ display: { xs: 'none', xl: 'inline' } }}>Topology</Box>
            </ToggleButton>
            <ToggleButton value="racks" aria-label="Rack view">
              <ViewInArIcon sx={{ fontSize: 18 }} />
              <Box component="span" sx={{ display: { xs: 'none', xl: 'inline' } }}>Racks</Box>
            </ToggleButton>
          </ToggleButtonGroup>
        )}
        {ready && (
          <Tooltip title={pdfTitle}>
            <IconButton size="small" sx={{ color: 'text.primary' }}
              disabled={pdfLoading}
              onClick={() => onExportPdf(exportScope === 'all' ? [] : exportNodeIds)}>
              <Badge badgeContent={exportCount} color="primary">
                {pdfLoading
                  ? <CircularProgress size={24} color="primary" /> // keep 24px or the toolbar shifts on swap
                  : <SvgGlyph src={pdfIcon} />}
              </Badge>
            </IconButton>
          </Tooltip>
        )}
        {ready && topo && (
          <Tooltip title={xlsxTitle}>
            <IconButton size="small" sx={{ color: 'text.primary' }}
              onClick={() => { void exportXlsx(topo, exportNodeIds).catch(console.error); }}>
              <Badge badgeContent={exportCount} color="primary">
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
