// Light/dark UI mode. Lives here (not trace.ts, which exports a different `Mode`) so App,
// main.tsx and the chrome components share one definition.
export type Mode = 'light' | 'dark';
