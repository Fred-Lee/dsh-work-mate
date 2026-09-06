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
import { join, dirname, normalize, extname, sep } from 'node:path'
import { readFile, stat, readdir, writeFile, mkdir, rename, copyFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateRecord } from './host-types.ts'
import { createGenerator, draftsDir } from './generator.ts'

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
  async handle(req: IncomingMessage, pathname: string): Promise<{ ok: false } | { ok: true; status: number; body: unknown }> {
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
        return { ok: true, status: 200, body: await route.handler(params, url.searchParams, req) }
      } catch (err) {
        // Real error contract: 4xx/5xx so the client's !res.ok branch fires.
        const message = err instanceof Error ? err.message : String(err)
        const status = /not found/i.test(message) ? 404 : /invalid/i.test(message) ? 400 : 500
        return { ok: true, status, body: { error: message } }
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

/** Reject path segments escaping the assets dir (sep-aware containment). */
function assertInsideAssets(assetsDir: string, abs: string): boolean {
  return abs === assetsDir || abs.startsWith(assetsDir.endsWith(sep) ? assetsDir : assetsDir + sep)
}

function createStaticHandler(mountPath: string, assetsDir: string) {
  const prefix = mountPath.endsWith('/') ? mountPath : `${mountPath}/`
  return async (pathname: string, res: ServerResponse): Promise<boolean> => {
    if (!pathname.startsWith(prefix)) return false
    const rel = (pathname.slice(prefix.length).replace(/^\//, '') || 'index.html')
    const clean = normalize(rel).replace(/^(\.\.[/\\])+/, '')
    const abs = join(assetsDir, clean)
    if (!assertInsideAssets(assetsDir, abs)) { res.writeHead(403); res.end('forbidden'); return true }
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
    | {
        buildGraph?: (scope?: { projectGroupId?: string }) => Promise<unknown>
        archive?: (note: { id: string; title: string; kind: string; createdAt: string; body: string; frontmatter: Record<string, unknown>; linkedProjects?: string[] }) => Promise<{ id: string; path: string }>
      }
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
    if (records.length > 200) records.length = 200
    // Fire-and-await into the engine; the panel polls /api/records. The engine
    // taskId is written back so UI records match the generator/draft logs.
    void generator.generate({ preset: preset as never, input }).then(
      (r) => {
        rec.status = r.status === 'completed' ? 'completed' : 'failed'
        if (r.taskId) rec.taskId = r.taskId
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

  // ── Drafts (L1/L2 artifacts) ────────────────────────────────────────────
  // Every generation writes a draft file; the panel lists, views, and archives
  // them (archive = confirmed-final copy into the Tolaria vault).
  router.add('GET', '/api/drafts', async () => {
    const dir = draftsDir()
    await mkdir(dir, { recursive: true })
    const byId = new Map<string, { id: string; kind: string; mtime: number; size: number; hasJson?: boolean }>()
    for (const f of await readdir(dir)) {
      const ext = f.endsWith('.md') ? '.md' : f.endsWith('.json') ? '.json' : null
      if (ext === null) continue
      const id = f.slice(0, -ext.length)
      const st = await stat(join(dir, f))
      const existing = byId.get(id)
      if (existing) {
        // decompose writes a .md and a .json twin — merge into one row.
        existing.size = Math.max(existing.size, st.size)
        existing.mtime = Math.max(existing.mtime, st.mtimeMs)
        if (ext === '.json') existing.hasJson = true
      } else {
        byId.set(id, {
          id,
          kind: id.split('-')[0] ?? 'research',
          mtime: st.mtimeMs,
          size: st.size,
          ...(ext === '.json' ? { hasJson: true } : {}),
        })
      }
    }
    return { drafts: [...byId.values()].sort((a, b) => b.mtime - a.mtime) }
  })

  router.add('GET', '/api/draft/:id', async (params) => {
    const id = params.id ?? ''
    if (!/^[a-z0-9-]+$/i.test(id)) throw new Error('invalid draft id')
    const dir = draftsDir()
    for (const ext of ['.md', '.json']) {
      const p = join(dir, `${id}${ext}`)
      try {
        return { id, content: await readFile(p, 'utf8') }
      } catch {
        // try next extension
      }
    }
    throw new Error(`draft not found: ${id}`)
  })

  router.add('POST', '/api/draft/archive', async (params, query, req) => {
    const body = await readJson(req)
    const id = typeof body.draftId === 'string' ? body.draftId : ''
    if (!/^[a-z0-9-]+$/i.test(id)) throw new Error('invalid draft id')
    const kind = body.kind === 'prd' ? 'prd' : body.kind === 'design' ? 'design' : 'research'
    const dir = draftsDir()
    let content: string | null = null
    for (const ext of ['.md', '.json']) {
      try {
        content = await readFile(join(dir, `${id}${ext}`), 'utf8')
        break
      } catch {
        // try next extension
      }
    }
    if (content === null) throw new Error(`draft not found: ${id}`)
    if (!knowledge?.archive) throw new Error('knowledge-tolaria not wired: cannot archive')
    const title = typeof body.title === 'string' && body.title.trim() !== '' ? body.title.trim() : id
    const linkedProjects = Array.isArray(body.linkedProjects) ? body.linkedProjects.map(String) : []
    const archived = await knowledge.archive({
      id,
      title,
      kind,
      createdAt: new Date().toISOString(),
      body: content,
      frontmatter: { keywords: [] },
      ...(linkedProjects.length > 0 ? { linkedProjects } : {}),
    })
    return { ok: true, ...archived }
  })

  // ── Custom commands (个人指令库) ────────────────────────────────────────
  // User-defined reusable prompts: {id, name, prompt, preset?}. One click in
  // the panel fills the textarea (and can run directly).
  const commandsFile = join(draftsDir(), '..', 'commands.json')
  const readCommands = async (): Promise<Array<{ id: string; name: string; prompt: string; preset?: string }>> => {
    try {
      const parsed = JSON.parse(await readFile(commandsFile, 'utf8')) as Array<{ id: string; name: string; prompt: string; preset?: string }>
      return Array.isArray(parsed) ? parsed : []
    } catch (err) {
      // Corrupted file: back it up instead of letting the next save clobber it.
      try {
        await copyFile(commandsFile, `${commandsFile}.corrupt-${Date.now().toString(36)}`)
      } catch {
        // best-effort backup
      }
      console.warn(`[helmsman/ui-workbench] commands.json unreadable (${err instanceof Error ? err.message : String(err)}); backed up, starting fresh`)
      return []
    }
  }
  router.add('GET', '/api/commands', async () => ({ commands: await readCommands() }))
  router.add('POST', '/api/commands', async (params, query, req) => {
    const body = await readJson(req)
    const list = Array.isArray(body.commands) ? body.commands : []
    const clean = list
      .filter((c): c is { id: string; name: string; prompt: string; preset?: string } =>
        typeof (c as any)?.name === 'string' && typeof (c as any)?.prompt === 'string')
      .map((c) => ({
        id: typeof c.id === 'string' && c.id !== '' ? c.id : `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        name: c.name,
        prompt: c.prompt,
        ...(typeof c.preset === 'string' ? { preset: c.preset } : {}),
      }))
    await mkdir(dirname(commandsFile), { recursive: true })
    // Atomic write (tmp + rename): an interrupted save can't leave a half-JSON.
    const tmp = `${commandsFile}.tmp-${randomUUID().slice(0, 8)}`
    await writeFile(tmp, JSON.stringify(clean, null, 2), 'utf8')
    await rename(tmp, commandsFile)
    return { ok: true, commands: clean }
  })

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
      // Bare mount path: redirect so relative asset URLs resolve.
      if (url.pathname === mountPath) {
        res.writeHead(301, { location: `${mountPath}/` })
        res.end()
        return
      }
      const relative = url.pathname.startsWith(mountPath)
        ? url.pathname.slice(mountPath.length) + url.search
        : req.url ?? url.pathname
      if (relative.startsWith('/api/') || relative === '/api') {
        const result = await router.handle(req, relative)
        if (!result.ok) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'not found' }))
          return
        }
        res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(result.body))
        return
      }
      const served = await staticHandler(url.pathname, res)
      if (!served) { res.writeHead(404); res.end('not found') }
    },
  })

  console.log(`[helmsman/ui-workbench] serving workbench at ${mountPath}/`)
}

async function readJson(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > maxBytes) throw new Error('request body too large')
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  try { return JSON.parse(text) as Record<string, unknown> } catch { return {} }
}
