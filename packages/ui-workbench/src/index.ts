/**
 * @helmsman/ui-workbench — host half.
 *
 * Serves the workbench SPA + REST under /helmsman-workbench/ via the DSH
 * `webServer` service (same pattern as ui-dashboard/ui-diff), and wires the
 * `helmsman.generator` seam + knowledge graph. REST endpoints:
 *   POST /api/generate   { preset, input } → kick a generation task
 *   GET  /api/records    → list recent generate records
 *   GET  /api/graph      → knowledge graph (knowledge-tolaria)
 *
 * The DSH client-module inject (client half) is in src/client/index.ts.
 */
import { join, dirname, normalize, extname } from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateRecord } from './host-types.ts'
import { createGenerator } from './generator.ts'

export const name = '@helmsman/ui-workbench'
// agents/agentDefaultModel/sessions: generation engine (same contract as the
// headless bundle); loader/agentPresets: app settlement + preset mounting.
export const inject = ['webServer', 'helmsman.knowledge', 'agents', 'agentDefaultModel', 'sessions', 'loader', 'agentPresets'] as const

export interface Config {
  /** URL prefix. @default '/helmsman-workbench' */
  mountPath?: string
}

/** Minimal method+path router (same contract as the other UI plugins). */
class MiniRouter {
  private routes: Array<{ method: string; parts: string[]; handler: (params: Record<string, string>, query: URLSearchParams, req: IncomingMessage) => Promise<unknown> }> = []
  add(method: string, pattern: string, handler: (params: Record<string, string>, query: URLSearchParams, req: IncomingMessage) => Promise<unknown>): this {
    this.routes.push({ method: method.toUpperCase(), parts: pattern.split('/').filter(Boolean), handler })
    return this
  }
  async handle(req: IncomingMessage, pathname: string): Promise<{ ok: true; body: unknown } | { ok: false }> {
    const url = new URL(pathname, 'http://localhost')
    const actual = url.pathname.split('/').filter(Boolean)
    for (const route of this.routes) {
      if (route.method !== (req.method ?? 'GET').toUpperCase()) continue
      if (route.parts.length !== actual.length) continue
      const params: Record<string, string> = {}
      let match = true
      for (let i = 0; i < route.parts.length; i++) {
        const p = route.parts[i]!
        const a = actual[i]!
        if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(a)
        else if (p !== a) { match = false; break }
      }
      if (!match) continue
      try {
        return { ok: true, body: await route.handler(params, url.searchParams, req) }
      } catch (err) {
        return { ok: true, body: { error: err instanceof Error ? err.message : String(err) } }
      }
    }
    return { ok: false }
  }
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
}

function createStaticHandler(mountPath: string, assetsDir: string) {
  const prefix = mountPath.endsWith('/') ? mountPath : `${mountPath}/`
  return async (pathname: string, res: ServerResponse): Promise<boolean> => {
    if (!pathname.startsWith(prefix)) return false
    const rel = (pathname.slice(prefix.length).replace(/^\//, '') || 'index.html')
    const clean = normalize(rel).replace(/^(\.\.[/\\])+/, '')
    const abs = join(assetsDir, clean)
    if (!abs.startsWith(assetsDir)) { res.writeHead(403); res.end('forbidden'); return true }
    try {
      let info = await stat(abs)
      let file = abs
      if (info.isDirectory()) file = join(abs, 'index.html')
      const content = await readFile(file)
      res.writeHead(200, { 'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' })
      res.end(content)
      return true
    } catch {
      res.writeHead(404); res.end('not found'); return true
    }
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  const webServer = ctx.get('webServer') as {
    register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): void
  }
  const knowledge = ctx.get('helmsman.knowledge') as
    | { buildGraph?: (scope?: { projectGroupId?: string }) => Promise<unknown> }
    | undefined

  const mountPath = (config.mountPath ?? '/helmsman-workbench').replace(/\/+$/, '')
  const assetsDir = join(dirname(fileURLToPath(import.meta.url)), 'client')
  const router = new MiniRouter()

  // Provide the generation engine once — both this REST surface and the
  // @helmsman/presets tools (which ctx.get('helmsman.generator')) share it.
  const generator = createGenerator(ctx)
  const provide = (ctx as unknown as { provide: (name: string, value: unknown) => void }).provide
  provide('helmsman.generator', generator)

  const records: GenerateRecord[] = []

  router.add('POST', '/api/generate', async (params, query, req) => {
    const body = await readJson(req)
    const preset = typeof body.preset === 'string' ? body.preset : 'research'
    const input = (typeof body.input === 'object' && body.input !== null ? body.input : {}) as Record<string, unknown>
    const rec: GenerateRecord = { taskId: `gen-${Date.now().toString(36)}`, preset, status: 'running', startedAt: Date.now() }
    records.unshift(rec)
    // Fire-and-await into the engine; the panel polls /api/records.
    void generator.generate({ preset: preset as never, input }).then(
      (r) => {
        rec.status = r.status === 'completed' ? 'completed' : 'failed'
        if (r.draftId !== undefined) rec.draftId = r.draftId
        if (r.error !== undefined) rec.error = r.error
        rec.endedAt = Date.now()
      },
      (err: unknown) => {
        rec.status = 'failed'
        rec.error = err instanceof Error ? err.message : String(err)
        rec.endedAt = Date.now()
      },
    )
    return { taskId: rec.taskId, status: 'running' }
  })

  router.add('GET', '/api/records', async () => ({ records: records.slice(0, 50) }))

  router.add('GET', '/api/graph', async () => {
    if (!knowledge?.buildGraph) return { nodes: [], edges: [], warning: 'knowledge-tolaria not wired' }
    return await knowledge.buildGraph()
  })

  const staticHandler = createStaticHandler(`${mountPath}/`, assetsDir)

  webServer.register({
    kind: 'prefix',
    path: mountPath,
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const relative = url.pathname.startsWith(mountPath)
        ? url.pathname.slice(mountPath.length) + url.search
        : req.url ?? url.pathname
      if (relative.startsWith('/api/') || relative === '/api') {
        const result = await router.handle(req, relative)
        const status = result.ok ? 200 : 404
        const body = result.ok ? JSON.stringify(result.body) : JSON.stringify({ error: 'not found' })
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(body)
        return
      }
      const served = await staticHandler(url.pathname, res)
      if (!served) { res.writeHead(404); res.end('not found') }
    },
  })

  console.log(`[helmsman/ui-workbench] serving workbench at ${mountPath}/`)
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  try { return JSON.parse(text) as Record<string, unknown> } catch { return {} }
}
