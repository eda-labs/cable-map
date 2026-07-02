import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import Link from '@mui/material/Link';
import Tooltip from '@mui/material/Tooltip';
import CenterFocusStrongIcon from '@mui/icons-material/CenterFocusStrongOutlined';
import DirectionsWalkIcon from '@mui/icons-material/DirectionsWalk';
import LabelIcon from '@mui/icons-material/LabelOutlined';
import LabelOffIcon from '@mui/icons-material/LabelOffOutlined';
import ViewColumnIcon from '@mui/icons-material/ViewColumnOutlined';
import type { Topology } from '../domain/topology/contract';
import { slottedOf } from '../domain/ports/frontPanelMeta';
import { shortPortLabel } from '../domain/ports/interfaceNames';
import { buildRackGroups, rackLabelOf, roleRank, type RackGroup } from '../domain/topology/racks';
import { buildLinkIndex, endKey } from '../domain/topology/linkIndex';
import type { CableKind } from '../graph';
import { useTrace } from '../trace';
import { type Mode } from '../theme';
import { type OpenNodeHandler } from '../components/NodeActionsContext';
import { componentsOf, stencilFor } from '../stencil';
import { OCCUPANCY_KIND_COLORS, OCCUPANCY_KIND_LABELS, OCCUPANCY_KIND_ORDER, roleColor } from './constants';
import { buildScene } from './buildScene';
import {
  applyMouseLook, deviceFocusPose, flyTo, frameOverview, hallFrontPose, panView, zoomView,
} from './camera';
import { updateCableTrace, visibleCableCount } from './cables';
import { setDeviceOpacity } from './devices';
import { rowOccupancyKind } from './occupancy';
import { placementSuffix, type DevicePlacement, type HoverState } from './types';
import GizmoPad from './GizmoPad';
import HoverCard from './HoverCard';
import { useRackScene } from './useRackScene';

interface RackViewProps {
  topo: Topology;
  shown: Set<string> | null;
  selected: string[];
  mode: Mode;
  onOpenNode: OpenNodeHandler;
  onClearSelection: () => void;
}

function RackView({ topo, shown, selected, mode, onOpenNode, onClearSelection }: RackViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const callbacksRef = useRef({ onOpenNode, onClearSelection });
  const [labelsVisible, setLabelsVisible] = useState(true);
  const [fpsMode, setFpsMode] = useState(false);
  const [hover, setHover] = useState<HoverState | null>(null);
  const traceAny = useTrace((s) => s.any);
  const tracedNodes = useTrace((s) => s.nodes);
  const tracedEdges = useTrace((s) => s.edges);
  const pinnedTraceKey = useTrace((s) => (s.pinned ? s.key : null));

  useEffect(() => {
    callbacksRef.current = { onOpenNode, onClearSelection };
  }, [onOpenNode, onClearSelection]);

  const racks = useMemo(() => buildRackGroups(topo, shown), [topo, shown]);
  const rackByLabel = useMemo(() => new Map(racks.map((rack) => [rack.label, rack])), [racks]);
  const nodeByName = useMemo(() => new Map(topo.nodes.map((node) => [node.name, node])), [topo]);
  const linkIndex = useMemo(
    () => buildLinkIndex(topo, (node) => slottedOf(stencilFor(node.platform, componentsOf(node.raw)))),
    [topo],
  );
  const placements = useMemo(() => {
    const byName = new Map<string, DevicePlacement>();
    for (const rack of racks) {
      for (const device of rack.devices) {
        byName.set(device.node.name, { rack: rack.label, uStart: device.uStart, uEnd: device.uEnd });
      }
    }
    return byName;
  }, [racks]);
  const linkIndexRef = useRef(linkIndex);
  useEffect(() => { linkIndexRef.current = linkIndex; }, [linkIndex]);
  const labelsVisibleRef = useRef(labelsVisible);
  labelsVisibleRef.current = labelsVisible;
  const totalRackLabels = useMemo(() => {
    const labels = new Set<string>();
    for (const node of topo.nodes) {
      const rack = rackLabelOf(node);
      if (rack) labels.add(rack);
    }
    return labels.size;
  }, [topo]);
  const visibleDevices = useMemo(() => racks.reduce((sum, rack) => sum + rack.devices.length, 0), [racks]);
  const visibleCables = useMemo(() => visibleCableCount(topo, shown), [topo, shown]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const selectedCableIds = useMemo(() => {
    const ids = new Set<string>();
    if (selectedSet.size === 0) return ids;
    for (const link of topo.links) {
      if (selectedSet.has(link.source) || selectedSet.has(link.target)) ids.add(link.id);
    }
    return ids;
  }, [topo.links, selectedSet]);
  const highlightedCableIds = useMemo(() => {
    // trace ids come from the 2D graph (isl|…, isllag|…, stub|…); expand them into the
    // backend link ids the rack routes are keyed by
    const ids = new Set(selectedCableIds);
    for (const traceId of tracedEdges) {
      ids.add(traceId);
      for (const linkId of linkIndex.linkIdsByTraceId.get(traceId) ?? []) ids.add(linkId);
    }
    return ids;
  }, [selectedCableIds, tracedEdges, linkIndex]);
  const cableHighlightAny = traceAny || selectedCableIds.size > 0;
  const pinnedCable = useMemo(() => {
    if (!pinnedTraceKey?.startsWith('cable:')) return null;
    const traceId = pinnedTraceKey.slice(6);
    const linkIds = linkIndex.linkIdsByTraceId.get(traceId);
    const link = linkIndex.linkById.get(linkIds?.[0] ?? traceId);
    if (!link) return null;
    const row = linkIndex.rowByEnd.get(endKey(link.source, link.sourcePort))
      ?? linkIndex.rowByEnd.get(endKey(link.target, link.targetPort));
    const kind = (row && rowOccupancyKind(row, topo.lags)) || 'isl';
    return { link, kind, bundleSize: linkIds?.length ?? 1 };
  }, [pinnedTraceKey, linkIndex, topo.lags]);
  const legendRoles = useMemo(() => {
    const roles = new Set<string>();
    for (const rack of racks) for (const device of rack.devices) roles.add(device.node.role || 'node');
    return [...roles].toSorted((left, right) => roleRank(left) - roleRank(right) || left.localeCompare(right)).slice(0, 6);
  }, [racks]);
  const legendPortKinds = useMemo(() => {
    const kinds = new Set<CableKind>();
    for (const rack of racks) {
      for (const device of rack.devices) {
        for (const row of device.node.table ?? []) {
          const kind = rowOccupancyKind(row, topo.lags);
          if (kind && kind !== 'isl') kinds.add(kind);
        }
      }
    }
    return OCCUPANCY_KIND_ORDER.filter((kind) => kind !== 'isl' && kinds.has(kind));
  }, [racks, topo.lags]);

  const sceneRef = useRackScene({
    hostRef,
    callbacksRef,
    linkIndexRef,
    onHover: setHover,
    onFpsModeChange: setFpsMode,
  });

  // Selection/trace styling is kept in a ref so a finished (async) scene build can re-apply
  // the current highlight state to the freshly created meshes.
  const applyStylesRef = useRef<() => void>(() => {});
  useEffect(() => {
    applyStylesRef.current = () => {
      const state = sceneRef.current;
      if (!state) return;
      for (const mesh of state.devices) {
        const isSelected = selectedSet.has(mesh.userData.nodeName);
        const isTraced = tracedNodes.has(mesh.userData.nodeName);
        const dim = traceAny && !isTraced && !isSelected;
        mesh.material.color.set(mesh.userData.baseColor);
        setDeviceOpacity(mesh, dim ? 0.2 : isSelected || isTraced ? 1 : mesh.userData.hasFrontPanel ? 0.72 : 0.92);
        mesh.material.emissive.set(isSelected ? '#FFD568' : isTraced ? '#4092FF' : '#000000');
        mesh.material.emissiveIntensity = isSelected ? 0.35 : isTraced ? 0.22 : 0;
        mesh.scale.z = isSelected || isTraced ? 1.28 : 1;
      }
      updateCableTrace(state, highlightedCableIds, cableHighlightAny, mode);
      state.requestRender();
    };
    applyStylesRef.current();
  }, [sceneRef, selectedSet, traceAny, tracedNodes, highlightedCableIds, cableHighlightAny, mode]);

  const framedRacksRef = useRef<RackGroup[] | null>(null);
  useEffect(() => {
    const state = sceneRef.current;
    if (!state) return;
    let cancelled = false;
    // reframe the camera only when the rack layout itself changed; a theme flip keeps the view
    const frame = framedRacksRef.current !== racks;
    void buildScene(state, topo, racks, shown, mode, labelsVisibleRef.current, frame, () => cancelled).then(() => {
      if (cancelled) return;
      framedRacksRef.current = racks;
      applyStylesRef.current();
    });
    return () => { cancelled = true; };
  }, [sceneRef, topo, racks, shown, mode]);

  useEffect(() => {
    const state = sceneRef.current;
    if (!state) return;
    for (const label of state.labels) label.visible = labelsVisible;
    state.requestRender();
  }, [sceneRef, labelsVisible]);

  const nudgeLook = useCallback((deltaX: number, deltaY: number) => {
    const state = sceneRef.current;
    if (!state) return;
    state.cameraTween = null;
    applyMouseLook(state, deltaX, deltaY);
    state.controls.update();
    state.requestRender();
  }, [sceneRef]);

  const nudgePan = useCallback((rightPx: number, upPx: number) => {
    const state = sceneRef.current;
    if (!state) return;
    state.cameraTween = null;
    panView(state, rightPx, upPx);
    state.controls.update();
    state.requestRender();
  }, [sceneRef]);

  const nudgeZoom = useCallback((factor: number) => {
    const state = sceneRef.current;
    if (!state) return;
    state.cameraTween = null;
    zoomView(state, factor);
    state.controls.update();
    state.requestRender();
  }, [sceneRef]);

  const toggleFps = useCallback(() => {
    const state = sceneRef.current;
    if (!state) return;
    if (document.pointerLockElement === state.renderer.domElement) document.exitPointerLock();
    else state.renderer.domElement.requestPointerLock();
  }, [sceneRef]);

  const focusNode = useCallback((nodeName: string) => {
    const state = sceneRef.current;
    if (!state) return;
    const pose = deviceFocusPose(state, nodeName);
    if (pose) flyTo(state, pose);
  }, [sceneRef]);

  const viewFrontElevation = useCallback(() => {
    const state = sceneRef.current;
    if (!state) return;
    const pose = hallFrontPose(state);
    if (pose) flyTo(state, pose);
  }, [sceneRef]);

  const resetCamera = useCallback(() => {
    const state = sceneRef.current;
    if (!state) return;
    const overview = frameOverview(state);
    if (overview) flyTo(state, overview.pose);
  }, [sceneRef]);

  return (
    <Box ref={hostRef} sx={{ position: 'relative', height: '100%', width: '100%', overflow: 'hidden', bgcolor: 'background.default' }}>
      <Box sx={{ position: 'absolute', top: 12, left: 12, zIndex: 1, px: 1.25, py: 1, minWidth: 190,
        bgcolor: 'background.paper', border: 1, borderColor: 'divider', boxShadow: 2 }}>
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>Rack View</Typography>
        <Typography variant="body2" sx={{ fontWeight: 600 }}>{racks.length} racks · {visibleDevices} devices · {visibleCables} cables</Typography>
        <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
          {totalRackLabels > 0 ? `${totalRackLabels} rack labels in namespace` : 'No rack labels in namespace'}
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.disabled', display: 'block' }}>
          Drag to look · right-drag to pan · wheel zooms to cursor
        </Typography>
        <Typography variant="caption" sx={{ color: 'text.disabled', display: 'block' }}>
          Click a rack or device to face it · F on hover · V walk mode
        </Typography>
      </Box>

      <Box sx={{ position: 'absolute', top: 12, right: 12, zIndex: 1, display: 'flex', gap: 0.5,
        bgcolor: 'background.paper', border: 1, borderColor: 'divider', boxShadow: 2, p: 0.5 }}>
        <Tooltip title={fpsMode ? 'Exit walk mode (V or Esc)' : 'Walk mode — free mouse look (V)'}>
          <IconButton size="small" onClick={toggleFps}
            sx={{ color: fpsMode ? 'primary.main' : 'text.primary' }}>
            <DirectionsWalkIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="Front elevation — face the rack rows">
          <IconButton size="small" onClick={viewFrontElevation} sx={{ color: 'text.primary' }}>
            <ViewColumnIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title="Frame all racks">
          <IconButton size="small" onClick={resetCamera} sx={{ color: 'text.primary' }}>
            <CenterFocusStrongIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title={labelsVisible ? 'Hide rack labels' : 'Show rack labels'}>
          <IconButton size="small" onClick={() => setLabelsVisible((value) => !value)} sx={{ color: 'text.primary' }}>
            {labelsVisible ? <LabelIcon fontSize="small" /> : <LabelOffIcon fontSize="small" />}
          </IconButton>
        </Tooltip>
      </Box>

      <GizmoPad onLook={nudgeLook} onPan={nudgePan} onZoom={nudgeZoom} />

      {(legendRoles.length > 0 || legendPortKinds.length > 0) && (
        <Box sx={{ position: 'absolute', bottom: { xs: 68, sm: 12 }, left: 12, zIndex: 1, px: 1.25, py: 1,
          bgcolor: 'background.paper', border: 1, borderColor: 'divider', boxShadow: 2 }}>
          {legendRoles.length > 0 && (
            <>
              <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 0.75 }}>Roles</Typography>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, maxWidth: 360 }}>
                {legendRoles.map((role) => (
                  <Box key={role} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                    <Box sx={{ width: 10, height: 10, bgcolor: roleColor(role, mode), border: 1, borderColor: 'divider' }} />
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>{role}</Typography>
                  </Box>
                ))}
              </Box>
            </>
          )}
          {legendPortKinds.length > 0 && (
            <>
              <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: legendRoles.length ? 1 : 0, mb: 0.75 }}>Ports</Typography>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, maxWidth: 360 }}>
                {legendPortKinds.map((kind) => (
                  <Box key={kind} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                    <Box sx={{ width: 10, height: 10, bgcolor: OCCUPANCY_KIND_COLORS[kind], border: 1, borderColor: 'divider' }} />
                    <Typography variant="caption" sx={{ color: 'text.secondary' }}>{OCCUPANCY_KIND_LABELS[kind]}</Typography>
                  </Box>
                ))}
              </Box>
            </>
          )}
        </Box>
      )}

      {fpsMode && (
        <>
          <Box aria-hidden sx={{ position: 'absolute', left: '50%', top: '50%',
            transform: 'translate(-50%, -50%)', zIndex: 1, pointerEvents: 'none',
            width: 18, height: 18, filter: 'drop-shadow(0 0 2px rgba(0,0,0,0.55))',
            '&::before': { content: '""', position: 'absolute', left: '50%', top: 0, bottom: 0,
              width: '2px', ml: '-1px', bgcolor: 'common.white', opacity: 0.85 },
            '&::after': { content: '""', position: 'absolute', top: '50%', left: 0, right: 0,
              height: '2px', mt: '-1px', bgcolor: 'common.white', opacity: 0.85 },
          }} />
          <Box sx={{ position: 'absolute', bottom: { xs: 68, sm: 12 }, left: '50%', zIndex: 1,
            transform: 'translateX(-50%)', px: 1.25, py: 0.5,
            bgcolor: 'background.paper', border: 1, borderColor: 'divider', boxShadow: 2 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              Walk mode · aim to inspect · click to pin · scroll walks · WASD/QE move · Esc exits
            </Typography>
          </Box>
        </>
      )}

      {racks.length === 0 && (
        <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none' }}>
          <Box sx={{ px: 2, py: 1.5, bgcolor: 'background.paper', border: 1, borderColor: 'divider', boxShadow: 2 }}>
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>No devices match the current rack filter.</Typography>
          </Box>
        </Box>
      )}

      {pinnedCable && (
        <Box sx={{ position: 'absolute', bottom: { xs: 68, sm: 48 }, left: '50%', zIndex: 1,
          transform: 'translateX(-50%)', px: 1.5, py: 0.75, maxWidth: '72%',
          bgcolor: 'background.paper', border: 1, borderColor: 'divider', boxShadow: 3,
          display: 'flex', alignItems: 'center', gap: 1 }}>
          <Box sx={{ width: 8, height: 8, flex: 'none', bgcolor: OCCUPANCY_KIND_COLORS[pinnedCable.kind] }} />
          <Tooltip title={`Fly to ${pinnedCable.link.source}`} disableInteractive>
            <Link component="button" type="button" variant="caption" underline="hover" noWrap
              onClick={() => focusNode(pinnedCable.link.source)}
              sx={{ fontWeight: 600, color: 'text.primary', minWidth: 0 }}>
              {pinnedCable.link.source} {shortPortLabel(pinnedCable.link.sourcePort)}
              {placementSuffix(placements.get(pinnedCable.link.source))}
            </Link>
          </Tooltip>
          <Typography variant="caption" sx={{ flex: 'none', color: 'text.secondary' }}>⟷</Typography>
          <Tooltip title={`Fly to ${pinnedCable.link.target}`} disableInteractive>
            <Link component="button" type="button" variant="caption" underline="hover" noWrap
              onClick={() => focusNode(pinnedCable.link.target)}
              sx={{ fontWeight: 600, color: 'text.primary', minWidth: 0 }}>
              {pinnedCable.link.target} {shortPortLabel(pinnedCable.link.targetPort)}
              {placementSuffix(placements.get(pinnedCable.link.target))}
            </Link>
          </Tooltip>
          {pinnedCable.bundleSize > 1 && (
            <Typography variant="caption" sx={{ flex: 'none', color: 'text.secondary' }}>×{pinnedCable.bundleSize} bundle</Typography>
          )}
          <Typography variant="caption" sx={{ color: 'text.disabled', flex: 'none' }}>Esc to clear</Typography>
        </Box>
      )}

      {hover && (
        <HoverCard hover={hover} nodeByName={nodeByName} placements={placements} rackByLabel={rackByLabel} linkIndex={linkIndex} lags={topo.lags} />
      )}
    </Box>
  );
}

export default memo(RackView);
