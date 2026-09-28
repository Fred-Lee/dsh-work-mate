/**
 * Tiny HTTP router for the WorkMate UI — same contract as the four Helmsman UI
 * plugins: it sits on the DSH `webServer` route handler (raw req/res pairs),
 * does method+path matching with `:param` segments, JSON helpers, and serves
 * static files from a whitelist directory with traversal protection.
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

const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json',
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

  async handle(rawPathname: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(rawPathname, 'http://local')
    const segments = url.pathname.split('/').filter(Boolean)
    const method = (req.method ?? 'GET').toUpperCase()

    for (const route of this.routes) {
      if (route.method !== method) continue
      const params = matchSegments(route.segments, segments)
      if (!params) continue
      try {
        const result = await route.handler({
          req,
          res,
          method,
          pathname: url.pathname,
          params,
          query: url.searchParams,
        })
        if (result !== undefined && !res.writableEnded) {
          sendJson(res, 200, result)
        }
      } catch (error) {
        if (!res.writableEnded) {
          sendJson(res, 400, {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      return
    }
    sendJson(res, 404, { error: `no route for ${method} ${url.pathname}` })
  }

  /** Serve files from `assetsDir` for anything that is not an API route. */
  async serveStatic(
    pathname: string,
    res: ServerResponse,
    assetsDir: string,
  ): Promise<void> {
    const relative = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '')
    const absolute = normalize(join(assetsDir, relative))
    if (!absolute.startsWith(normalize(assetsDir))) {
      sendJson(res, 404, { error: 'not found' })
      return
    }
    const candidates = absolute.endsWith('.js') || (await isFile(absolute))
      ? [absolute]
      : [join(absolute, 'index.html'), join(assetsDir, 'index.html')]

    for (const candidate of candidates) {
      try {
        if (!(await isFile(candidate))) continue
        const body = await readFile(candidate)
        res.writeHead(200, {
          'content-type': MIME[extname(candidate)] ?? 'application/octet-stream',
          'cache-control': 'no-cache',
        })
        res.end(body)
        return
      } catch {
        continue
      }
    }
    sendJson(res, 404, { error: 'not found' })
  }
}

function matchSegments(pattern: string[], actual: string[]): Record<string, string> | undefined {
  if (pattern.length !== actual.length) return undefined
  const params: Record<string, string> = {}
  for (let i = 0; i < pattern.length; i++) {
    const expected = pattern[i] as string
    const value = actual[i] as string
    if (expected.startsWith(':')) {
      params[expected.slice(1)] = value
    } else if (expected !== value) {
      return undefined
    }
  }
  return params
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

export async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) throw new Error('request body is required')
  return JSON.parse(raw) as T
}
