import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The dev server proxies /api + /pdf to a real cable-map backend. EDA_API sets the target URL;
// otherwise it defaults to http://127.0.0.1:8080 (e.g. a port-forwarded in-cluster operator, which
// `make dev-cluster` / DevSpace sets up). Front-panel metadata is a static file (src/frontpanel-meta.json,
// regenerated with `pnpm gen:frontpanel-meta`); the SVG panels are fetched as plain assets.
const edaApi = process.env.EDA_API
const apiTarget = edaApi && /^https?:\/\//.test(edaApi) ? edaApi : 'http://127.0.0.1:8080'

// https://vite.dev/config/
export default defineConfig({
  // relative base so assets/fetches resolve under any mount point — works at / and
  // behind EDA's HttpProxy sub-path (/core/httpproxy/v1/cable-map/).
  base: './',
  // force a single React instance — the dep optimizer can otherwise pre-bundle a second copy for
  // MUI/emotion, producing "Invalid hook call / more than one copy of React" at runtime.
  resolve: { dedupe: ['react', 'react-dom', '@emotion/react', '@emotion/styled'] },
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
      '/pdf': { target: apiTarget, changeOrigin: true },
    },
  },
})
