import { StrictMode, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeProvider, createTheme, CssBaseline } from '@mui/material'
import './nokia-fonts.css'
import './index.css'
import App from './App.tsx'
import Print from './Print.tsx'

export type Mode = 'light' | 'dark';

// Theme lifted from eda-labs/topo-builder for visual consistency, parameterised for a
// light variant. The custom CSS vars used by the canvas (see index.css) flip in lockstep
// via the data-theme attribute that Root sets below.
const makeTheme = (mode: Mode) => {
  const dark = mode === 'dark';
  return createTheme({
    cssVariables: true,
    palette: {
      mode,
      primary: { main: '#6098FF' },
      error: { main: '#FF6363' },
      warning: { main: '#FFAC0A' },
      success: { main: '#00A87E' },
      info: { main: '#90B7FF' },
      background: dark ? { default: '#1A222E', paper: '#101824' } : { default: '#EEF1F5', paper: '#FFFFFF' },
      text: dark ? { primary: '#ffffff', secondary: '#C9CED6' } : { primary: '#0B1119', secondary: '#5A6472' },
      divider: dark ? '#4A5361B2' : '#D5DAE1',
      card: dark ? { bg: '#101824', border: '#4A5361B2' } : { bg: '#FFFFFF', border: '#D5DAE1' },
    },
    shape: { borderRadius: 4 },
    typography: { fontFamily: '"NokiaPureText", "Roboto", "Helvetica", "Arial", sans-serif' },
    components: {
      MuiPaper: {
        styleOverrides: {
          outlined: {
            backgroundColor: 'var(--mui-palette-card-bg)',
            borderColor: 'var(--mui-palette-card-border)',
          },
        },
      },
    },
  });
};

const THEME_KEY = 'cable-map-theme';
const initialMode = (): Mode => {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
};

// Owns the theme mode for the interactive app: builds the MUI theme, mirrors the choice onto
// <html data-theme> (which drives the canvas CSS vars), and persists it.
function Root() {
  const [mode, setMode] = useState<Mode>(initialMode);
  const theme = useMemo(() => makeTheme(mode), [mode]);
  useEffect(() => {
    document.documentElement.dataset.theme = mode;
    localStorage.setItem(THEME_KEY, mode);
  }, [mode]);
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <App mode={mode} onToggleMode={() => setMode((m) => (m === 'dark' ? 'light' : 'dark'))} />
    </ThemeProvider>
  );
}

// Print: light theme so MUI components render on white with dark text — but the
// SAME NokiaPureText font, so the PDF embeds Nokia Pure (not MUI's default Roboto).
const printTheme = createTheme({
  palette: { mode: 'light' },
  typography: { fontFamily: '"NokiaPureText", "Roboto", "Helvetica", "Arial", sans-serif' },
});

// ponytail: no router lib — one branch on the path is all two routes need.
const isPrint = location.pathname.startsWith('/print');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isPrint ? (
      <ThemeProvider theme={printTheme}><Print /></ThemeProvider>
    ) : (
      <Root />
    )}
  </StrictMode>,
)
