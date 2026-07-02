import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { Topology } from '../domain/topology/contract';
import { shortPortLabel } from '../domain/ports/interfaceNames';
import type { RackGroup } from '../domain/topology/racks';
import { endKey, type LinkIndex } from '../domain/topology/linkIndex';
import { OCCUPANCY_KIND_COLORS, OCCUPANCY_KIND_LABELS } from './constants';
import { rowOccupancyKind } from './occupancy';
import { portHitRow } from './picking';
import { formatRackU, type DevicePlacement, type HoverState } from './types';

// Cursor-following card naming exactly what's under the pointer: a cable (both ends with
// rack + U position), a front-panel port (peer, LAG, LLDP, breakout channel) or a device.
function HoverCard({ hover, nodeByName, placements, rackByLabel, linkIndex, lags }: {
  hover: HoverState;
  nodeByName: Map<string, Topology['nodes'][number]>;
  placements: Map<string, DevicePlacement>;
  rackByLabel: Map<string, RackGroup>;
  linkIndex: LinkIndex;
  lags: Topology['lags'];
}) {
  const flipX = hover.x > window.innerWidth - 360;
  const flipY = hover.y > window.innerHeight - 280;
  const style = {
    left: flipX ? hover.x - 14 : hover.x + 14,
    top: flipY ? hover.y - 12 : hover.y + 14,
    transform: `translate(${flipX ? '-100%' : '0'}, ${flipY ? '-100%' : '0'})`,
  };
  const frameSx = {
    position: 'fixed', zIndex: 2, pointerEvents: 'none', px: 1.25, py: 1, maxWidth: 320,
    bgcolor: 'background.paper', border: 1, borderColor: 'divider', boxShadow: 4,
  } as const;

  if (hover.target.type === 'rack') {
    const rack = rackByLabel.get(hover.target.rack);
    if (!rack) return null;
    return (
      <Box sx={frameSx} style={style}>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>{rack.label}</Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
          {rack.placement.row} · {rack.devices.length} device{rack.devices.length === 1 ? '' : 's'}
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
          {rack.ruUsed} / {rack.ruCapacity} U used
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.disabled', display: 'block', mt: 0.5 }}>
          Click to face this rack
        </Typography>
      </Box>
    );
  }

  if (hover.target.type === 'cable') {
    const link = linkIndex.linkById.get(hover.target.linkId);
    if (!link) return null;
    const row = linkIndex.rowByEnd.get(endKey(link.source, link.sourcePort))
      ?? linkIndex.rowByEnd.get(endKey(link.target, link.targetPort));
    const kind = (row && rowOccupancyKind(row, lags)) || 'isl';
    const ends = [
      { node: link.source, port: link.sourcePort },
      { node: link.target, port: link.targetPort },
    ];
    return (
      <Box sx={frameSx} style={style}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
          <Box sx={{ width: 8, height: 8, flex: 'none', bgcolor: OCCUPANCY_KIND_COLORS[kind] }} />
          <Typography variant="body2" sx={{ fontWeight: 600 }}>{OCCUPANCY_KIND_LABELS[kind]} cable</Typography>
        </Box>
        {ends.map((end) => (
          <Box key={`${end.node}|${end.port}`} sx={{ mt: 0.5 }}>
            <Typography variant="body2">{end.node} · {shortPortLabel(end.port)}</Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
              {formatRackU(placements.get(end.node)) ?? 'not racked'}
            </Typography>
          </Box>
        ))}
        {row?.lag && (
          <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 0.5 }}>LAG {row.lag}</Typography>
        )}
        {row?.lldpStatus === 'mismatch' && (
          <Typography variant="caption" sx={{ color: 'warning.main', display: 'block' }}>
            LLDP mismatch{row.lldpPeer ? ` · sees ${row.lldpPeer}` : ''}
          </Typography>
        )}
        <Typography variant="caption" sx={{ color: 'text.disabled', display: 'block', mt: 0.5 }}>Click to pin this cable</Typography>
      </Box>
    );
  }

  const node = nodeByName.get(hover.target.nodeName);
  if (!node) return null;
  const placement = formatRackU(placements.get(node.name));
  const port = hover.target.port;
  const cageRows = port ? linkIndex.rowsByCage.get(endKey(node.name, port.cage)) ?? [] : [];
  const exact = port ? portHitRow(linkIndex, node.name, port) : null;
  const portRows = exact ? [exact] : cageRows.slice(0, 4);
  const breakout = port ? node.breakouts?.[port.cage] : undefined;
  const connected = (node.table ?? []).filter((row) => row.type === 'interSwitch' || row.type === 'edge').length;
  return (
    <Box sx={frameSx} style={style}>
      <Typography variant="body2" sx={{ fontWeight: 600 }}>{node.name}</Typography>
      <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
        {placement ?? 'Inferred rack'} · {node.role || 'node'}
      </Typography>
      <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
        {node.platform}{!port ? ` · ${connected} cabled port${connected === 1 ? '' : 's'}` : ''}
      </Typography>
      {port && (
        <Box sx={{ mt: 0.75, pt: 0.75, borderTop: 1, borderColor: 'divider' }}>
          <Typography variant="caption" sx={{ fontWeight: 600, display: 'block' }}>
            Port {port.cage}
            {breakout ? ` · ${breakout.channels}×${breakout.speed}${port.channel ? ` · ch ${port.channel}` : ''}` : ''}
          </Typography>
          {portRows.length === 0 && (
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>not cabled</Typography>
          )}
          {portRows.map((row) => {
            const kind = rowOccupancyKind(row, lags);
            const remote = row.remoteNode || row.peer || '—';
            const remotePlacement = row.remoteNode ? formatRackU(placements.get(row.remoteNode)) : null;
            return (
              <Box key={row.label} sx={{ mt: 0.25 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                  {kind && <Box sx={{ width: 8, height: 8, flex: 'none', bgcolor: OCCUPANCY_KIND_COLORS[kind] }} />}
                  <Typography variant="caption">
                    {shortPortLabel(row.label)} → {remote}{row.remotePort ? ` · ${shortPortLabel(row.remotePort)}` : ''}
                  </Typography>
                </Box>
                {remotePlacement && (
                  <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', pl: kind ? 1.5 : 0 }}>
                    {remotePlacement}
                  </Typography>
                )}
              </Box>
            );
          })}
          {exact?.lag && <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>LAG {exact.lag}</Typography>}
          {exact?.lldpStatus === 'mismatch' && (
            <Typography variant="caption" sx={{ color: 'warning.main', display: 'block' }}>
              LLDP mismatch{exact.lldpPeer ? ` · sees ${exact.lldpPeer}` : ''}
            </Typography>
          )}
          {exact?.desc && <Typography variant="caption" sx={{ color: 'text.disabled', display: 'block' }}>{exact.desc}</Typography>}
        </Box>
      )}
      <Typography variant="caption" sx={{ color: 'text.disabled', display: 'block', mt: 0.5 }}>
        {port ? 'Click to pin · F to face device' : 'Click to face front panel'}
      </Typography>
    </Box>
  );
}

export default HoverCard;
