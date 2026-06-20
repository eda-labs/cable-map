import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ThemeProvider, createTheme, CssBaseline } from '@mui/material'
import './nokia-fonts.css'
import './index.css'
import App from './App.tsx'
import Print from './Print.tsx'

// Theme lifted from eda-labs/topo-builder for visual consistency.
const theme = createTheme({
  cssVariables: true,
  palette: {
    mode: 'dark',
    primary: { main: '#6098FF' },
    error: { main: '#FF6363' },
    warning: { main: '#FFAC0A' },
    success: { main: '#00A87E' },
    info: { main: '#90B7FF' },
    background: { default: '#1A222E', paper: '#101824' },
    text: { primary: '#ffffff', secondary: '#C9CED6' },
    divider: '#4A5361B2',
    card: { bg: '#101824', border: '#4A5361B2' },
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
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <App />
      </ThemeProvider>
    )}
  </StrictMode>,
)
