export type CanvasPixelSize = { width: number; height: number; dpr: number };

export function resizeCanvasToDisplaySize(canvas: HTMLCanvasElement, width: number, height: number): CanvasPixelSize {
  const dpr = window.devicePixelRatio || 1;
  const pixelWidth = Math.max(1, Math.round(width * dpr));
  const pixelHeight = Math.max(1, Math.round(height * dpr));
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  return { width: pixelWidth, height: pixelHeight, dpr };
}
