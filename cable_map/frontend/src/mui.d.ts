// topo-builder theme extends the palette with a `card` color (used by outlined Paper).
import '@mui/material/styles';

declare module '@mui/material/styles' {
  interface Palette { card: { bg: string; border: string } }
  interface PaletteOptions { card?: { bg?: string; border?: string } }
}
