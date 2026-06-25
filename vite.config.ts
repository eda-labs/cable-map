import { defineConfig, type Plugin, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'

// The dev server uses a small local topology mock by default. Set EDA_API=http://... to proxy
// /api + /pdf to a real cable-map backend instead. Front-panel metadata is a static file
// (src/frontpanel-meta.json, regenerated with `pnpm gen:frontpanel-meta`); the SVG panels are
// fetched as plain assets.
const edaApi = process.env.EDA_API
const apiTarget = edaApi && /^https?:\/\//.test(edaApi) ? edaApi : ''
const mockNamespace = 'demo'
const mockTopologyPath = new URL('./cable_map/operators/cable-map/internal/topology/testdata/golden-topology.json', import.meta.url)

const sendJSON = (res: ServerResponse, status: number, body: unknown) => {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

const sendSSE = (req: IncomingMessage, res: ServerResponse, payload: string) => {
  res.statusCode = 200
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.write('retry: 3000\n\n')
  res.write(`data: ${payload}\n\n`)
  const timer = setInterval(() => res.write(': ping\n\n'), 25000)
  req.on('close', () => clearInterval(timer))
}

const sendHeartbeatSSE = (req: IncomingMessage, res: ServerResponse) => {
  res.statusCode = 200
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.write('retry: 3000\n\n')
  const timer = setInterval(() => res.write(': ping\n\n'), 25000)
  req.on('close', () => clearInterval(timer))
}

const mockApiPlugin = (): Plugin => ({
  name: 'cable-map-dev-api',
  configureServer(server: ViteDevServer) {
    const topology = JSON.stringify(JSON.parse(fs.readFileSync(mockTopologyPath, 'utf8')))

    server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
      if (req.method !== 'GET') {
        next()
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname === '/api/namespaces') {
        sendJSON(res, 200, [mockNamespace])
        return
      }
      if (url.pathname === '/api/namespaces/stream') {
        sendSSE(req, res, JSON.stringify([mockNamespace]))
        return
      }
      if (url.pathname === '/api/topology') {
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json')
        res.end(topology)
        return
      }
      if (url.pathname === '/api/topology/stream') {
        if (topology.length > 1_000_000) sendHeartbeatSSE(req, res)
        else sendSSE(req, res, topology)
        return
      }
      if (url.pathname === '/pdf') {
        sendJSON(res, 501, { error: 'PDF export requires EDA_API to point at a real backend' })
        return
      }
      next()
    })
  },
})

// https://vite.dev/config/
export default defineConfig({
  // relative base so assets/fetches resolve under any mount point — works at / and
  // behind EDA's HttpProxy sub-path (/core/httpproxy/v1/cable-map/).
  base: './',
  // force a single React instance — the dep optimizer can otherwise pre-bundle a second copy for
  // MUI/emotion, producing "Invalid hook call / more than one copy of React" at runtime.
  resolve: { dedupe: ['react', 'react-dom', '@emotion/react', '@emotion/styled'] },
  plugins: [react(), ...(!apiTarget ? [mockApiPlugin()] : [])],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: apiTarget ? {
      '/api': { target: apiTarget, changeOrigin: true },
      '/pdf': { target: apiTarget, changeOrigin: true },
    } : undefined,
  },
})
