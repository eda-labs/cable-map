import { createTheme } from '@mui/material/styles';

// Light/dark UI mode. Lives here (not trace.ts, which exports a different `Mode`) so App,
// Root and the chrome components share one definition.
export type Mode = 'light' | 'dark';

// EDA brand palette ramps (raw --color-* tokens from the EDA cluster), used to build the MUI
// theme so it matches EDA's actual UI rather than the marketing brand-hub ramp.
const C = {
  white: '#FFFFFF', black: '#000000',
  nokiaBlue: { 10: '#ECF3FF', 20: '#D6E4FF', 30: '#B8D1FF', 40: '#90B7FF', 50: '#6098FF', 60: '#2E78FF', 70: '#005AFF', 80: '#0A44AD', 90: '#0C2F70' },
  tone: { 5: '#F7F9FD', 10: '#EDF2FA', 20: '#DFE5ED', 30: '#C9CED6', 40: '#ABB4C2', 50: '#8994A3', 70: '#4A5361', 90: '#252D38', 100: '#101824' },
  grey: { 10: '#F2F2F2', 20: '#E3E3E3', 70: '#525252', 90: '#2B2B2B' },
  red: { 10: '#FFEDED', 50: '#FF6363', 60: '#EB3D3D', 70: '#C71E1E' },
  green: { 50: '#24D45E', 60: '#00B53B', 70: '#00822B' },
  yellow: { 40: '#FFAC0A', 50: '#D18D04' },
  // EDA surfaces (formBody / baseBackground): #1A222E panels over a #101824 base.
  panel: '#1A222E',
};

// MUI theme mapped from EDA's tokens — dark values from the cluster's --mui-* set, light from its
// --light-mode-* set. The canvas CSS vars (index.css) flip via <html data-theme> in Root.
export const makeTheme = (mode: Mode) => {
  const dark = mode === 'dark';
  return createTheme({
    cssVariables: true,
    palette: {
      mode,
      primary: dark
        ? { main: C.nokiaBlue[50], light: C.nokiaBlue[40], dark: C.nokiaBlue[60], contrastText: C.black }
        : { main: C.nokiaBlue[70], light: C.nokiaBlue[60], dark: C.nokiaBlue[80], contrastText: C.white },
      secondary: dark
        ? { main: C.nokiaBlue[90], contrastText: C.nokiaBlue[20] }
        : { main: C.nokiaBlue[10], contrastText: C.nokiaBlue[70] },
      error: { main: dark ? C.red[50] : C.red[70] },
      warning: { main: dark ? C.yellow[40] : C.yellow[50] },
      info: { main: dark ? C.nokiaBlue[40] : C.nokiaBlue[60] },
      success: { main: dark ? C.green[60] : C.green[70] },
      background: dark ? { default: C.panel, paper: C.panel } : { default: C.tone[5], paper: C.white },
      text: dark
        ? { primary: C.white, secondary: 'rgba(255,255,255,0.7)', disabled: '#E3E3E3A5' }
        : { primary: C.grey[90], secondary: 'rgba(43,43,43,0.7)', disabled: 'rgba(43,43,43,0.45)' },
      divider: dark ? '#4A5361B2' : '#ABB4C24C',
      action: dark
        ? { hover: '#EDF2FA14', selected: '#B8D1FF19' }
        : { hover: '#252D3814', selected: '#2E78FF19' },
      // EDA cards/panels: surface fill + the EDA border token.
      card: dark ? { bg: C.panel, border: '#4A5361B2' } : { bg: C.white, border: C.tone[40] },
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

// Print: light theme so MUI components render on white with dark text — but the
// SAME NokiaPureText font, so the PDF embeds Nokia Pure (not MUI's default Roboto).
export const printTheme = createTheme({
  palette: { mode: 'light' },
  typography: { fontFamily: '"NokiaPureText", "Roboto", "Helvetica", "Arial", sans-serif' },
});
