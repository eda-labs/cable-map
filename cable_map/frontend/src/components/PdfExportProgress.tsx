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
  const [displayPercent, setDisplayPercent] = useState(0);

  useEffect(() => {
    if (!loading) {
      setDisplayPercent(0);
      return;
    }
    if (typeof percent === 'number') {
      setDisplayPercent((current) => Math.max(current, percent));
      return;
    }
    setDisplayPercent((current) => Math.max(current, 78));
  }, [loading, percent]);

  useEffect(() => {
    if (!loading || !indeterminate) return undefined;
    const timer = window.setInterval(() => {
      setDisplayPercent((current) => Math.min(94, current + Math.max(0.4, (94 - current) * 0.06)));
    }, 450);
    return () => window.clearInterval(timer);
  }, [loading, indeterminate]);

  const phase = loading ? state.phase : '';
  const detail = loading ? state.detail : '';
  const roundedPercent = Math.min(100, Math.max(0, Math.round(displayPercent)));
  const determinate = loading && !indeterminate;

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
                  {roundedPercent}%
                </Typography>
              </Box>
              <Typography variant="body2" noWrap sx={{ color: 'text.secondary', mt: 0.25 }}>
                {phase}
              </Typography>
            </Box>
          </Box>
          {detail && (
            <Typography variant="caption" noWrap sx={{ display: 'block', mt: 0.25, color: 'text.secondary' }}>
              {detail}
            </Typography>
          )}
          <LinearProgress
            variant="determinate"
            value={roundedPercent}
            sx={{
              mt: 1.25,
              height: 6,
              borderRadius: 1,
              '& .MuiLinearProgress-bar': { transition: 'transform 420ms ease-out' },
            }}
          />
          {loading && indeterminate && roundedPercent < 94 && (
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

export default memo(PdfExportProgress);
