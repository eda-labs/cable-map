import { defineConfig, type Plugin, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'

// The stencil inspector previews panels with the cable-map app's REAL SwitchNode renderer, so `@app`
// points at the frontend source — one source of truth, no duplicated renderer.
const appSrc = fileURLToPath(new URL('../cable_map/frontend/src', import.meta.url))
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

// Serve the operator's stencil SVGs at /frontpanel/<name>.svg in dev (same as the app's plugin), and
// ping the client on edits so the inspector re-fetches the changed panel in place.
const frontpanelDir = fileURLToPath(new URL('../cable_map/operators/cable-map/frontpanel', import.meta.url))
const isPanel = (f: string) => f.replace(/\\/g, '/').includes('/operators/cable-map/frontpanel/') && f.endsWith('.svg')
const frontpanel = (): Plugin => ({
  name: 'frontpanel-serve',
  configureServer(server: ViteDevServer) {
    server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (!url.pathname.startsWith('/frontpanel/') || !url.pathname.endsWith('.svg')) {
        next()
        return
      }
      const name = decodeURIComponent(url.pathname.slice('/frontpanel/'.length))
      if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
        next()
        return
      }
      fs.readFile(path.join(frontpanelDir, name), (err, buf) => {
        if (err) { res.statusCode = 404; res.end(); return }
        res.setHeader('Content-Type', 'image/svg+xml')
        res.end(buf)
      })
    })
    server.watcher.add(frontpanelDir)
    const notify = (file: string) => { if (isPanel(file)) server.ws.send({ type: 'custom', event: 'cable-map:frontpanel' }) }
    server.watcher.on('add', notify)
    server.watcher.on('change', notify)
    server.watcher.on('unlink', notify)
  },
})

export default defineConfig({
  resolve: {
    alias: { '@app': appSrc },
    // single React/emotion instance across the studio + the aliased app source (else "Invalid hook call")
    dedupe: ['react', 'react-dom', '@emotion/react', '@emotion/styled'],
  },
  // let vite serve the aliased app source (outside this project's root)
  server: {
    port: 5174,
    fs: { allow: [repoRoot] },
  },
  plugins: [react(), frontpanel()],
})
