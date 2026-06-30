import Box from '@mui/material/Box';

// Renders a raw (`?raw`) SVG inline so its `fill="currentColor"` inherits the surrounding text
// colour, mirroring how MUI's own icons theme. The inner <svg> is sized to 1em off `fontSize`.
export default function SvgGlyph({ src, fontSize = '1.5rem' }: { src: string; fontSize?: string | number }) {
  return (
    <Box component="span" aria-hidden sx={{
      display: 'inline-flex', lineHeight: 0, fontSize,
      '& svg': { width: '1em', height: '1em', display: 'block' },
    }} dangerouslySetInnerHTML={{ __html: src }} />
  );
}
