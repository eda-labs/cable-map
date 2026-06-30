import { useState } from 'react';
import { Panel } from '@xyflow/react';
import Box from '@mui/material/Box';
import Grow from '@mui/material/Grow';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import CloseIcon from '@mui/icons-material/CloseOutlined';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { CABLE_COLOR, LLDP_COLOR } from '../graph';
import { useLldp } from '../lldp';

const LEGEND: Array<[string, string]> = [
  ['Fabric (ISL)', CABLE_COLOR.isl], ['Edge', CABLE_COLOR.edge], ['Local LAG', CABLE_COLOR.lag], ['ESI / MH-LAG', CABLE_COLOR.mlag],
];
const LLDP_LEGEND: Array<[string, string]> = [
  ['LLDP confirmed', LLDP_COLOR.ok], ['Mismatch', LLDP_COLOR.mismatch], ['No neighbor', LLDP_COLOR.none],
];

export default function CanvasLegend() {
  const [legendOpen, setLegendOpen] = useState(true);
  const lldpOn = useLldp();
  return (
    <Panel position="bottom-left">
      {/* both states grow/shrink from the bottom-left corner (transformOrigin); the expanded
          box drives the footprint, the collapsed icon is absolute so it adds no layout */}
      <Box sx={{ position: 'relative' }}>
        <Grow in={legendOpen} style={{ transformOrigin: 'bottom left' }} unmountOnExit>
          <Box sx={{ position: 'relative', bgcolor: 'background.paper', border: 1, borderColor: 'divider', borderRadius: 1.5, pl: 1.5, pr: 3.5, py: 1, boxShadow: 2 }}>
            <Tooltip title="Hide legend">
              <IconButton size="small" onClick={() => setLegendOpen(false)} sx={{ position: 'absolute', top: 2, right: 2, p: 0.25 }}>
                <CloseIcon sx={{ fontSize: 14, color: 'text.secondary' }} />
              </IconButton>
            </Tooltip>
            <Box sx={{ display: 'flex', gap: 2, mb: 0.75 }}>
              {(lldpOn ? LLDP_LEGEND : LEGEND).map(([label, swatch]) => (
                <Box key={label} sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                  <Box sx={{ width: 14, height: 6, borderRadius: 2, bgcolor: swatch }} />
                  <Typography variant="caption" sx={{ color: 'text.primary', fontWeight: 500 }}>{label}</Typography>
                </Box>
              ))}
            </Box>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              {lldpOn
                ? 'LLDP overlay — cables coloured by neighbour match vs the configured remote'
                : 'Hover to trace · click a cable or port to pin · click a switch for its panel'}
            </Typography>
          </Box>
        </Grow>
        <Grow in={!legendOpen} style={{ transformOrigin: 'bottom left' }} unmountOnExit>
          <Box sx={{ position: 'absolute', bottom: 0, left: 0 }}>
            <Tooltip title="Show legend">
              <IconButton size="small" onClick={() => setLegendOpen(true)}
                sx={{ bgcolor: 'background.paper', border: 1, borderColor: 'divider', boxShadow: 2, '&:hover': { bgcolor: 'background.paper' } }}>
                <InfoOutlinedIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
              </IconButton>
            </Tooltip>
          </Box>
        </Grow>
      </Box>
    </Panel>
  );
}
