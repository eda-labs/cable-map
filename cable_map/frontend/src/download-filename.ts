export function downloadTimestamp(now: Date = new Date()): string {
  return `${now.toISOString().slice(0, 19).replace('T', '_').replaceAll(':', '-')}Z`;
}

export function timestampedDownloadFilename(filename: string, now: Date = new Date()): string {
  const dot = filename.lastIndexOf('.');
  const timestamp = downloadTimestamp(now);
  if (dot <= 0 || dot === filename.length - 1) return `${filename}_${timestamp}`;
  return `${filename.slice(0, dot)}_${timestamp}${filename.slice(dot)}`;
}
