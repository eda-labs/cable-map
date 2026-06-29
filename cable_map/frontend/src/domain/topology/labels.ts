import type { Topology } from './contract';

export function labelOf(n: Topology['nodes'][number], key: string): string | undefined {
  return n.labels?.[key] ?? n.raw?.metadata?.labels?.[key];
}

export function nodeLabelPairs(n: Topology['nodes'][number]): string[] {
  const labels = new Map<string, string>();
  const rawLabels = n.raw?.metadata?.labels;

  if (rawLabels && typeof rawLabels === 'object' && !Array.isArray(rawLabels)) {
    for (const [key, value] of Object.entries(rawLabels)) {
      if (value == null) continue;
      labels.set(key, String(value));
    }
  }
  for (const [key, value] of Object.entries(n.labels ?? {})) labels.set(key, value);
  if (n.role && !labels.has('eda.nokia.com/role')) labels.set('eda.nokia.com/role', n.role);

  return [...labels.entries()]
    .filter(([key, value]) => key.trim() && value.trim())
    .map(([key, value]) => `${key}=${value}`);
}
