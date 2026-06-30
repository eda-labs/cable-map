import { memo, useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Fade from '@mui/material/Fade';
import LinearProgress from '@mui/material/LinearProgress';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import type { PdfState } from '../hooks/usePdfExport';

function PdfExportProgress({ state }: { state: PdfState }) {
  const loading = state.status === 'loading';
  const percent = loading ? state.percent : undefined;
  const indeterminate = state.status === 'loading' && !!state.indeterminate;
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    if (!loading) {
      setElapsedSeconds(0);
      return;
    }
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [loading]);

  // Title = the current phase; subtitle = its detail (e.g. "Typst compile", "5 / 1000 nodes").
  // The metric (top-right) carries the % or elapsed, so neither is repeated below.
  const phase = loading ? state.phase : '';
  const detail = loading ? state.detail : '';
  const determinate = loading && !indeterminate;
  const roundedPercent = determinate ? Math.min(100, Math.max(0, Math.round(percent ?? 0))) : undefined;
  const metric = determinate ? `${roundedPercent}%` : formatElapsed(elapsedSeconds);

  return (
    <Fade in={loading} mountOnEnter unmountOnExit timeout={180}>
      <Box
        sx={{
          position: 'fixed',
          top: 64,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: (theme) => theme.zIndex.snackbar,
          width: 460,
          maxWidth: 'calc(100vw - 32px)',
          pointerEvents: 'none',
        }}
      >
        <Paper
          elevation={6}
          role="status"
          aria-live="polite"
          sx={{
            px: 2.25,
            py: 1.75,
            borderRadius: 1,
            bgcolor: 'background.paper',
            color: 'text.primary',
            border: 1,
            borderColor: 'divider',
            overflow: 'hidden',
            pointerEvents: 'auto',
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5, minWidth: 0 }}>
            <Typography variant="subtitle2" noWrap sx={{ flex: 1, minWidth: 0, fontWeight: 600 }}>
              {phase}
            </Typography>
            <Typography variant="h6" sx={{ lineHeight: 1, fontWeight: 300, flexShrink: 0 }}>
              {metric}
            </Typography>
          </Box>
          {detail && (
            <Typography variant="body2" noWrap sx={{ color: 'text.secondary', mt: 0.25 }}>
              {detail}
            </Typography>
          )}
          <LinearProgress
            variant={determinate ? 'determinate' : 'indeterminate'}
            value={determinate ? roundedPercent : undefined}
            sx={{
              mt: 1.5,
              height: 6,
              borderRadius: 1,
              ...(determinate ? { '& .MuiLinearProgress-bar': { transition: 'transform 420ms ease-out' } } : {}),
            }}
          />
        </Paper>
      </Box>
    </Fade>
  );
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default memo(PdfExportProgress);
