import { ThemeProvider } from '@mui/material/styles';
import Print from '../Print';
import { printTheme } from '../theme';
import Root from './Root';

// no router lib — a branch on the path is all these routes need.
export default function Routes() {
  if (location.pathname.startsWith('/print')) {
    return <ThemeProvider theme={printTheme}><Print /></ThemeProvider>;
  }
  return <Root />;
}
