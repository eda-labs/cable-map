import { memo, useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
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

  const phase = loading ? state.phase : '';
  const detail = loading ? state.detail : '';
  const determinate = loading && !indeterminate;
  const roundedPercent = determinate ? Math.min(100, Math.max(0, Math.round(percent ?? 0))) : undefined;
  const metric = determinate ? `${roundedPercent}%` : formatElapsed(elapsedSeconds);
  const progressDetail = indeterminate
    ? [detail, `Elapsed ${formatElapsed(elapsedSeconds)}`].filter(Boolean).join(' · ')
    : detail;

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
            position: 'relative',
            pointerEvents: 'auto',
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, minWidth: 0 }}>
            <CircularProgress
              variant={determinate ? 'determinate' : 'indeterminate'}
              value={determinate ? roundedPercent : undefined}
              size={34}
              thickness={4}
              color="primary"
              sx={{ flexShrink: 0 }}
            />
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5, minWidth: 0 }}>
                <Typography variant="subtitle2" noWrap sx={{ flex: 1, minWidth: 0, fontWeight: 600 }}>
                  Rendering PDF
                </Typography>
                <Typography variant="h6" sx={{ lineHeight: 1, fontWeight: 300, flexShrink: 0 }}>
                  {metric}
                </Typography>
              </Box>
              <Typography variant="body2" noWrap sx={{ color: 'text.secondary', mt: 0.25 }}>
                {phase}
              </Typography>
            </Box>
          </Box>
          {progressDetail && (
            <Typography variant="caption" noWrap sx={{ display: 'block', mt: 0.25, color: 'text.secondary' }}>
              {progressDetail}
            </Typography>
          )}
          <LinearProgress
            variant={determinate ? 'determinate' : 'indeterminate'}
            value={determinate ? roundedPercent : undefined}
            sx={{
              mt: 1.25,
              height: 6,
              borderRadius: 1,
              ...(determinate ? { '& .MuiLinearProgress-bar': { transition: 'transform 420ms ease-out' } } : {}),
            }}
          />
          {loading && indeterminate && (
            <Box
              sx={{
                position: 'absolute',
                left: 0,
                right: 0,
                bottom: 0,
                height: 2,
                bgcolor: 'primary.main',
                animation: 'pdf-export-scan 1.1s ease-in-out infinite',
                '@keyframes pdf-export-scan': {
                  '0%': { transform: 'translateX(-100%)' },
                  '100%': { transform: 'translateX(100%)' },
                },
              }}
            />
          )}
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
