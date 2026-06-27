// DEV-ONLY entry for the stencil inspector (stencil-editor/index.html). Never in the prod rollup
// input (vite build only builds index.html) — so this and StencilViewer ship nowhere.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider, createTheme, CssBaseline } from '@mui/material';
import '../src/nokia-fonts.css';
import '../src/index.css'; // canvas CSS vars (--panel/--line/--cell-*) the SwitchNode preview needs
import StencilViewer from './StencilViewer.tsx';

document.documentElement.dataset.theme = 'dark';

const theme = createTheme({
  palette: {
    mode: 'dark',
    primary: { main: '#6098FF' },
    background: { default: '#0e1420', paper: '#141b27' },
  },
  shape: { borderRadius: 6 },
  typography: { fontFamily: '"NokiaPureText", "Roboto", "Helvetica", "Arial", sans-serif' },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <StencilViewer />
    </ThemeProvider>
  </StrictMode>,
);
