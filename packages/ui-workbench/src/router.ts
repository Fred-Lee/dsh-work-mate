/**
 * @helmsman/ui-workbench — host-side mini router + request helpers.
 *
 * Extracted verbatim from index.ts so the REST surface is testable without a
 * live cordis context (same convention as `@helmsman/ui-dashboard`'s
 * `createApiRouter`): the host registers routes on one instance and the tests
 * drive `handle()` directly with fake req/res.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

/** A route handler that returns `undefined` has written the response itself
 * (binary download streams); every other handler returns a JSON body. */
export type RouteHandler = (
  params: Record<string, string>,
  query: URLSearchParams,
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<unknown>

/** Minimal method+path router (same contract as the other UI plugins). */
export class MiniRouter {
  private routes: Array<{ method: string; parts: string[]; handler: RouteHandler }> = []
  add(method: string, pattern: string, handler: RouteHandler): this {
    this.routes.push({ method: method.toUpperCase(), parts: pattern.split('/').filter(Boolean), handler })
    return this
  }
  async handle(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<{ ok: false } | { ok: true; status: number; body?: unknown }> {
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
        return { ok: true, status: 200, body: await route.handler(params, url.searchParams, req, res) }
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

/** Reads + parses a JSON request body (empty body → `{}`). */
export async function readJson(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<Record<string, unknown>> {
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
