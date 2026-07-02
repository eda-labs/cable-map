import {
  useCallback, useEffect, useRef,
  type PointerEvent as ReactPointerEvent, type ReactNode,
} from 'react';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import type { SxProps, Theme } from '@mui/material/styles';
import AddIcon from '@mui/icons-material/Add';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowLeftIcon from '@mui/icons-material/KeyboardArrowLeft';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import KeyboardArrowUpIcon from '@mui/icons-material/KeyboardArrowUp';
import RemoveIcon from '@mui/icons-material/Remove';
import RotateLeftIcon from '@mui/icons-material/RotateLeft';
import RotateRightIcon from '@mui/icons-material/RotateRight';
import {
  GIZMO_HOLD_DELAY_MS, GIZMO_PAN_HOLD_SPEED, GIZMO_PAN_STEP, GIZMO_ROTATE_HOLD_SPEED, GIZMO_ROTATE_STEP,
  GIZMO_TILT_HOLD_SPEED, GIZMO_TILT_STEP, GIZMO_ZOOM_HOLD_RATE, GIZMO_ZOOM_STEP,
} from './constants';

// Gizmo control: a tap applies one nudge; keeping it pressed glides continuously
// (onHold receives per-frame delta seconds) until the pointer lifts.
function GizmoButton({ title, ariaLabel, onNudge, onHold, sx, children }: {
  title: string;
  ariaLabel: string;
  onNudge: () => void;
  onHold: (deltaSeconds: number) => void;
  sx: SxProps<Theme>;
  children: ReactNode;
}) {
  const holdRef = useRef<{ timeout: number; raf: number; last: number } | null>(null);
  const stopHold = useCallback(() => {
    const hold = holdRef.current;
    if (!hold) return;
    window.clearTimeout(hold.timeout);
    window.cancelAnimationFrame(hold.raf);
    holdRef.current = null;
  }, []);
  useEffect(() => stopHold, [stopHold]);

  const startHold = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    stopHold();
    onNudge();
    const hold = { timeout: 0, raf: 0, last: 0 };
    const step = (time: number) => {
      onHold(Math.min(0.05, Math.max(0, (time - hold.last) / 1000)));
      hold.last = time;
      hold.raf = window.requestAnimationFrame(step);
    };
    hold.timeout = window.setTimeout(() => {
      hold.last = performance.now();
      hold.raf = window.requestAnimationFrame(step);
    }, GIZMO_HOLD_DELAY_MS);
    holdRef.current = hold;
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  return (
    <Tooltip title={title} disableInteractive>
      <IconButton
        size="small"
        aria-label={ariaLabel}
        onPointerDown={startHold}
        onPointerUp={stopHold}
        onPointerCancel={stopHold}
        onClick={(event) => {
          event.stopPropagation();
          if (event.detail === 0) onNudge(); // keyboard activation
        }}
        sx={sx}
      >
        {children}
      </IconButton>
    </Tooltip>
  );
}

const gizmoButtonSx = {
  width: 30,
  height: 30,
  minWidth: 30,
  color: 'text.primary',
  border: 1,
  borderColor: 'divider',
  bgcolor: 'background.paper',
  '&:hover': { bgcolor: 'action.hover' },
};

// On-screen navigation pad: look/zoom cluster on top, screen-space pan cluster below.
function GizmoPad({ onLook, onPan, onZoom }: {
  onLook: (deltaX: number, deltaY: number) => void;
  onPan: (rightPx: number, upPx: number) => void;
  onZoom: (factor: number) => void;
}) {
  return (
    <Box sx={{ position: 'absolute', right: 12, bottom: { xs: 68, sm: 12 }, zIndex: 1,
      width: 132, px: 0.75, py: 0.75, bgcolor: 'background.paper', border: 1,
      borderColor: 'divider', boxShadow: 2 }}>
      <Typography variant="caption" sx={{ display: 'block', textAlign: 'center', color: 'text.disabled', fontSize: 10, lineHeight: 1.6 }}>
        Look · zoom
      </Typography>
      <Box sx={{ display: 'grid', gridTemplateColumns: '30px 30px 30px 30px', gridTemplateRows: '30px 30px',
        gap: 0.5, alignItems: 'center', justifyContent: 'center' }}>
        <GizmoButton title="Tilt up" ariaLabel="Tilt rack view up"
          onNudge={() => onLook(0, -GIZMO_TILT_STEP)}
          onHold={(dt) => onLook(0, -GIZMO_TILT_HOLD_SPEED * dt)}
          sx={{ ...gizmoButtonSx, gridColumn: 2, gridRow: 1 }}>
          <KeyboardArrowUpIcon fontSize="small" />
        </GizmoButton>
        <GizmoButton title="Zoom in" ariaLabel="Zoom rack view in"
          onNudge={() => onZoom(GIZMO_ZOOM_STEP)}
          onHold={(dt) => onZoom(Math.pow(GIZMO_ZOOM_HOLD_RATE, dt))}
          sx={{ ...gizmoButtonSx, gridColumn: 4, gridRow: 1 }}>
          <AddIcon fontSize="small" />
        </GizmoButton>
        <GizmoButton title="Rotate left" ariaLabel="Rotate rack view left"
          onNudge={() => onLook(-GIZMO_ROTATE_STEP, 0)}
          onHold={(dt) => onLook(-GIZMO_ROTATE_HOLD_SPEED * dt, 0)}
          sx={{ ...gizmoButtonSx, gridColumn: 1, gridRow: 2 }}>
          <RotateLeftIcon fontSize="small" />
        </GizmoButton>
        <GizmoButton title="Tilt down" ariaLabel="Tilt rack view down"
          onNudge={() => onLook(0, GIZMO_TILT_STEP)}
          onHold={(dt) => onLook(0, GIZMO_TILT_HOLD_SPEED * dt)}
          sx={{ ...gizmoButtonSx, gridColumn: 2, gridRow: 2 }}>
          <KeyboardArrowDownIcon fontSize="small" />
        </GizmoButton>
        <GizmoButton title="Rotate right" ariaLabel="Rotate rack view right"
          onNudge={() => onLook(GIZMO_ROTATE_STEP, 0)}
          onHold={(dt) => onLook(GIZMO_ROTATE_HOLD_SPEED * dt, 0)}
          sx={{ ...gizmoButtonSx, gridColumn: 3, gridRow: 2 }}>
          <RotateRightIcon fontSize="small" />
        </GizmoButton>
        <GizmoButton title="Zoom out" ariaLabel="Zoom rack view out"
          onNudge={() => onZoom(1 / GIZMO_ZOOM_STEP)}
          onHold={(dt) => onZoom(Math.pow(1 / GIZMO_ZOOM_HOLD_RATE, dt))}
          sx={{ ...gizmoButtonSx, gridColumn: 4, gridRow: 2 }}>
          <RemoveIcon fontSize="small" />
        </GizmoButton>
      </Box>
      <Box sx={{ height: 1, bgcolor: 'divider', opacity: 0.72, my: 0.75 }} />
      <Typography variant="caption" sx={{ display: 'block', textAlign: 'center', color: 'text.disabled', fontSize: 10, lineHeight: 1.6 }}>
        Move
      </Typography>
      <Box sx={{ display: 'grid', gridTemplateColumns: '30px 30px 30px', gridTemplateRows: '30px 30px',
        gap: 0.5, justifyContent: 'center' }}>
        <GizmoButton title="Pan up" ariaLabel="Pan rack view up"
          onNudge={() => onPan(0, GIZMO_PAN_STEP)}
          onHold={(dt) => onPan(0, GIZMO_PAN_HOLD_SPEED * dt)}
          sx={{ ...gizmoButtonSx, gridColumn: 2, gridRow: 1 }}>
          <KeyboardArrowUpIcon fontSize="small" />
        </GizmoButton>
        <GizmoButton title="Pan left" ariaLabel="Pan rack view left"
          onNudge={() => onPan(-GIZMO_PAN_STEP, 0)}
          onHold={(dt) => onPan(-GIZMO_PAN_HOLD_SPEED * dt, 0)}
          sx={{ ...gizmoButtonSx, gridColumn: 1, gridRow: 2 }}>
          <KeyboardArrowLeftIcon fontSize="small" />
        </GizmoButton>
        <GizmoButton title="Pan down" ariaLabel="Pan rack view down"
          onNudge={() => onPan(0, -GIZMO_PAN_STEP)}
          onHold={(dt) => onPan(0, -GIZMO_PAN_HOLD_SPEED * dt)}
          sx={{ ...gizmoButtonSx, gridColumn: 2, gridRow: 2 }}>
          <KeyboardArrowDownIcon fontSize="small" />
        </GizmoButton>
        <GizmoButton title="Pan right" ariaLabel="Pan rack view right"
          onNudge={() => onPan(GIZMO_PAN_STEP, 0)}
          onHold={(dt) => onPan(GIZMO_PAN_HOLD_SPEED * dt, 0)}
          sx={{ ...gizmoButtonSx, gridColumn: 3, gridRow: 2 }}>
          <KeyboardArrowRightIcon fontSize="small" />
        </GizmoButton>
      </Box>
      <Typography variant="caption" sx={{ display: 'block', textAlign: 'center', color: 'text.disabled', fontSize: 9, mt: 0.5 }}>
        Hold a button to glide
      </Typography>
    </Box>
  );
}

export default GizmoPad;
