import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Dev-only: serve the captured topology as /api/topology so `npm run dev` has data
// (HMR) with no backend and no EDA. Production uses the real EDA REST API instead.
function fakeTopologyApi(): Plugin {
  const file = fileURLToPath(new URL('./fake-topology.json', import.meta.url))
  return {
    name: 'fake-topology-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] === '/api/topology') {
          res.setHeader('content-type', 'application/json')
          res.end(readFileSync(file, 'utf8'))
          return
        }
        next()
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  // relative base so assets/fetches resolve under any mount point — works at / and
  // behind EDA's HttpProxy sub-path (/core/httpproxy/v1/cable-map/).
  base: './',
  plugins: [react(), fakeTopologyApi()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    // /pdf needs the server (Puppeteer); run `npm start` alongside to use it in dev.
    proxy: { '/pdf': 'http://127.0.0.1:8080' },
  },
})
