import { useCallback, useEffect, useMemo, useState } from 'react';
import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import App from '../App';
import { makeTheme, type Mode } from '../theme';

const THEME_KEY = 'cable-map-theme';
const initialMode = (): Mode => {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
};

// Owns the theme mode for the interactive app: builds the MUI theme, mirrors the choice onto
// <html data-theme> (which drives the canvas CSS vars), and persists it.
export default function Root() {
  const [mode, setMode] = useState<Mode>(initialMode);
  const theme = useMemo(() => makeTheme(mode), [mode]);
  const toggleMode = useCallback(() => setMode((m) => (m === 'dark' ? 'light' : 'dark')), []);
  useEffect(() => {
    document.documentElement.dataset.theme = mode;
    localStorage.setItem(THEME_KEY, mode);
  }, [mode]);
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <App mode={mode} onToggleMode={toggleMode} />
    </ThemeProvider>
  );
}
