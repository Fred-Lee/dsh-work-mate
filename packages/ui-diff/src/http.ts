/**
 * Tiny HTTP router for Helmsman UI plugins — sits on top of the DSH
 * `webServer` route handler contract (req/res pairs we fully own).
 * Method+path matching with `:param` segments; JSON helpers; static files
 * served from a whitelist directory with traversal protection.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, normalize, extname } from 'node:path'

export interface RouterRequest {
  req: IncomingMessage
  res: ServerResponse
  method: string
  pathname: string
  params: Record<string, string>
  query: URLSearchParams
}

export type RouteHandler = (r: RouterRequest) => Promise<unknown> | unknown

interface Route {
  method: string
  segments: string[]
  handler: RouteHandler
}

export class Router {
  private readonly routes: Route[] = []

  add(method: string, pattern: string, handler: RouteHandler): this {
    this.routes.push({
      method: method.toUpperCase(),
      segments: pattern.split('/').filter(Boolean),
      handler,
    })
    return this
  }

  get(pattern: string, handler: RouteHandler): this {
    return this.add('GET', pattern, handler)
  }
  post(pattern: string, handler: RouteHandler): this {
    return this.add('POST', pattern, handler)
  }
  delete(pattern: string, handler: RouteHandler): this {
    return this.add('DELETE', pattern, handler)
  }

  async handle(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    const url = new URL(pathname, 'http://localhost')
    const parts = url.pathname.split('/').filter(Boolean)
    for (const route of this.routes) {
      if (route.method !== (req.method ?? 'GET').toUpperCase()) continue
      const params = matchSegments(route.segments, parts)
      if (!params) continue
      try {
        const result = await route.handler({
          req,
          res,
          method: route.method,
          pathname: url.pathname,
          params,
          query: url.searchParams,
        })
        if (result !== undefined) await sendJson(res, 200, result)
        return true
      } catch (err) {
        await sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
        return true
      }
    }
    return false
  }
}

function matchSegments(pattern: string[], actual: string[]): Record<string, string> | null {
  if (pattern.length !== actual.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i]!
    const a = actual[i]!
    if (p.startsWith(':')) {
      params[p.slice(1)] = decodeURIComponent(a)
    } else if (p !== a) {
      return null
    }
  }
  return params
}

export async function readJsonBody(req: IncomingMessage, maxBytes = 5 * 1024 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > maxBytes) throw new Error('request body too large')
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  return JSON.parse(text) as Record<string, unknown>
}

export async function sendJson(res: ServerResponse, status: number, data: unknown): Promise<void> {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
}

/**
 * Serves files from `assetsDir` under `mountPath` (URL prefix). Only files
 * that exist inside assetsDir are served; `normalize` + containment checks
 * prevent traversal.
 */
export function createStaticHandler(mountPath: string, assetsDir: string, fallbackFile = 'index.html') {
  const prefix = mountPath.endsWith('/') ? mountPath : `${mountPath}/`
  return async (pathname: string, res: ServerResponse): Promise<boolean> => {
    if (!pathname.startsWith(prefix)) return false
    const rel = pathname.slice(prefix.length).replace(/^\//, '') || fallbackFile
    const clean = normalize(rel).replace(/^(\.\.[/\\])+/, '')
    const abs = join(assetsDir, clean)
    if (!abs.startsWith(assetsDir)) {
      res.writeHead(403)
      res.end('forbidden')
      return true
    }
    let info
    try {
      info = await stat(abs)
    } catch {
      res.writeHead(404)
      res.end('not found')
      return true
    }
    if (info.isDirectory()) {
      return await staticInner(join(abs, fallbackFile), res)
    }
    return await staticInner(abs, res)
  }
}

async function staticInner(abs: string, res: ServerResponse): Promise<boolean> {
  try {
    const content = await readFile(abs)
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(abs)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    })
    res.end(content)
    return true
  } catch {
    res.writeHead(404)
    res.end('not found')
    return true
  }
}
