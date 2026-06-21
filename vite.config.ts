import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync, watch as fsWatch } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Dev-only: serve the captured topology so `pnpm dev` has data with no backend and no EDA.
// Both the one-shot /api/topology and the SSE /api/topology/stream are mocked; the stream
// re-emits whenever fake-topology.json is edited, mirroring the live watch in production.
function fakeTopologyApi(): Plugin {
  const file = fileURLToPath(new URL('./fake-topology.json', import.meta.url))
  return {
    name: 'fake-topology-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = req.url?.split('?')[0]
        // optional dev override: a fake-namespaces.json next to the topology fixture lets you
        // exercise the live namespace picker (edit it and the SSE re-emits); defaults to ['eda'].
        const nsFile = fileURLToPath(new URL('./fake-namespaces.json', import.meta.url))
        const readNs = () => { try { return JSON.parse(readFileSync(nsFile, 'utf8')) } catch { return ['eda'] } }
        if (path === '/api/namespaces') {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(readNs()))
          return
        }
        if (path === '/api/namespaces/stream') {
          res.setHeader('content-type', 'text/event-stream')
          res.setHeader('cache-control', 'no-cache')
          res.setHeader('connection', 'keep-alive')
          res.write('retry: 3000\n\n')
          const send = () => { try { res.write(`data: ${JSON.stringify(readNs())}\n\n`) } catch { /* mid-write */ } }
          send()
          let watcher: ReturnType<typeof fsWatch> | undefined
          try { watcher = fsWatch(nsFile, () => send()) } catch { /* file absent: static ['eda'] */ }
          req.on('close', () => watcher?.close())
          return
        }
        if (path === '/api/topology') {
          res.setHeader('content-type', 'application/json')
          res.end(readFileSync(file, 'utf8'))
          return
        }
        if (path === '/api/topology/stream') {
          res.setHeader('content-type', 'text/event-stream')
          res.setHeader('cache-control', 'no-cache')
          res.setHeader('connection', 'keep-alive')
          res.write('retry: 3000\n\n')
          // SSE data must be single-line; the snapshot is pretty-printed, so compact it first.
          const send = () => { try { res.write(`data: ${JSON.stringify(JSON.parse(readFileSync(file, 'utf8')))}\n\n`) } catch { /* mid-write */ } }
          send()
          const watcher = fsWatch(file, () => send())
          req.on('close', () => watcher.close())
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
    // /pdf needs the server (Puppeteer); run `pnpm start` alongside to use it in dev.
    proxy: { '/pdf': 'http://127.0.0.1:8080' },
  },
})
