import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const occupiedColour = '#00A87E'
const reNum = /\d+/g
const reSrosConn = /(?:^|[/_-])c(\d+)(?:[/_-]|$)/i
const reDataPort = /data-port="([^"]*)"/g
const rePathCage = /<path\b[^>]*\bdata-port="([^"]+)"[^>]*>/g
const reFillAttr = /\s+fill="[^"]*"/g
const reFillStyle = /fill\s*:[^;"]*;?/g

type DevPdfRow = {
  label: string
  desc?: string
  remoteNode?: string
  remotePort?: string
  type: string
  lag?: string
  peer?: string
  lldpPeer?: string
}

type DevPdfNode = {
  name: string
  platform: string
  table?: DevPdfRow[]
}

export type DevPdfTopology = {
  nodes: DevPdfNode[]
}

type RenderDevPdfArgs = {
  topology: DevPdfTopology
  url: URL
  frontpanelDir: string
  pdfAssetsDir: string
}

type TypstError = Error & {
  code?: string
  stdout?: string | Buffer
  stderr?: string | Buffer
}

export async function renderDevPdf({ topology, url, frontpanelDir, pdfAssetsDir }: RenderDevPdfArgs) {
  const nodesParam = url.searchParams.get('nodes')?.trim() ?? ''
  const byName = new Map(topology.nodes.map((node) => [node.name, node]))
  const nodes = nodesParam
    ? nodesParam.split(',').map((name) => byName.get(name.trim())).filter((node): node is DevPdfNode => !!node)
    : topology.nodes
  if (nodes.length === 0) throw new DevPdfRequestError(400, 'no nodes to render')

  const remote = parseStringRecord(url.searchParams.get('remote'))
  const stencils = parseStringRecord(url.searchParams.get('stencils'))
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'cable-map-pdf-'))
  try {
    await Promise.all(['template.typ', 'eda.svg'].map((file) =>
      fs.copyFile(path.join(pdfAssetsDir, file), path.join(work, file))))

    const data = {
      nodes: await Promise.all(nodes.map(async (node, index) => {
        const panel = await writePanel({ node, index, work, frontpanelDir, svgName: stencils[node.name] || node.platform })
        return { name: node.name, platform: node.platform, panel, rows: tableRows(node, remote) }
      })),
    }
    await fs.writeFile(path.join(work, 'data.json'), JSON.stringify(data))

    const out = path.join(work, 'out.pdf')
    await compileTypst(work, out, pdfAssetsDir)
    const bytes = await fs.readFile(out)
    return { bytes, filename: pdfFilename(url.searchParams.get('ns')?.trim() ?? '') }
  } finally {
    await fs.rm(work, { recursive: true, force: true })
  }
}

export class DevPdfRequestError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function writePanel({
  node,
  index,
  work,
  frontpanelDir,
  svgName,
}: {
  node: DevPdfNode
  index: number
  work: string
  frontpanelDir: string
  svgName: string
}): Promise<string> {
  const svgPath = panelPath(frontpanelDir, svgName)
  if (!svgPath) return ''
  let svg: string
  try {
    svg = await fs.readFile(svgPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }

  const slotted = svgSlotted(svg)
  const occupied = new Set<string>()
  for (const row of node.table ?? []) {
    const cage = cageKey(row.label, slotted)
    if (cage) occupied.add(cage)
  }

  const panel = `panel-${index}.svg`
  await fs.writeFile(path.join(work, panel), colourPanel(svg, occupied))
  return panel
}

async function compileTypst(work: string, out: string, pdfAssetsDir: string): Promise<void> {
  const typstBin = process.env.TYPST_BIN?.trim() || 'typst'
  try {
    await execFileAsync(typstBin, ['compile', path.join(work, 'template.typ'), out, '--font-path', pdfAssetsDir, '--root', work], {
      maxBuffer: 1024 * 1024,
      timeout: 60_000,
    })
  } catch (error) {
    const err = error as TypstError
    if (err.code === 'ENOENT') {
      throw new Error('typst not found; install Typst or set TYPST_BIN to enable PDF export in dev', { cause: error })
    }
    const output = [err.stdout, err.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`typst compile failed: ${err.message}${output ? `: ${output}` : ''}`, { cause: error })
  }
}

function tableRows(node: DevPdfNode, remote: Record<string, string>): string[][] {
  return (node.table ?? []).map((row) => {
    let type = row.type === 'interSwitch' ? 'ISL' : row.type
    if (row.lag) type += ' (LAG)'
    let remoteNode = row.remoteNode ?? ''
    let remotePort = row.remotePort ?? ''
    if (row.type === 'edge') {
      remoteNode = remote[`${node.name} ${row.label} node`] || remoteNode
      remotePort = remote[`${node.name} ${row.label} port`] || remotePort
    }
    if (!remoteNode && row.peer) remoteNode = row.peer
    return [row.label, dash(row.desc), type, dash(remoteNode), dash(remotePort), dash(row.lldpPeer)]
  })
}

function cageKey(label: string, slotted: boolean): string {
  const ns = label.match(reNum) ?? []
  if (ns.length === 0) return ''
  const sros = label.match(reSrosConn)
  const port = sros?.[1] ?? ns[ns.length >= 2 ? 1 : 0] ?? ''
  return slotted && ns.length >= 2 ? `${ns[0]}-${port}` : port
}

function svgSlotted(svg: string): boolean {
  for (const match of svg.matchAll(reDataPort)) {
    if (match[1]?.includes('-')) return true
  }
  return false
}

function colourPanel(svg: string, occupied: Set<string>): string {
  return svg.replace(rePathCage, (tag, port: string) => {
    if (!occupied.has(port)) return tag
    const stripped = tag.replace(reFillAttr, '').replace(reFillStyle, '')
    const fill = `fill:${occupiedColour};fill-opacity:1`
    if (stripped.includes('style="')) return stripped.replace('style="', `style="${fill};`)
    return stripped.replace('<path', `<path style="${fill}"`)
  })
}

function panelPath(frontpanelDir: string, svgName: string): string | null {
  if (!svgName || svgName.includes('/') || svgName.includes('\\') || svgName.includes('..')) return null
  return path.join(frontpanelDir, `${svgName}.svg`)
}

function parseStringRecord(value: string | null): Record<string, string> {
  if (!value) return {}
  try {
    const parsed: unknown = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [key, recordValue] of Object.entries(parsed)) {
      if (recordValue != null) out[key] = String(recordValue)
    }
    return out
  } catch {
    return {}
  }
}

function dash(value: string | undefined): string {
  return value || '—'
}

function pdfFilename(namespace: string): string {
  const ns = safeFilenamePart(namespace)
  return `cable_map${ns ? `_${ns}` : ''}.pdf`
}

function safeFilenamePart(value: string): string {
  return value.trim().replaceAll(/[^A-Za-z0-9.-]+/g, '_').replaceAll(/^_+|_+$/g, '')
}
