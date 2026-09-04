/**
 * @helmsman/ui-dashboard — host half.
 *
 * Serves the React dashboard SPA and its REST API under /helmsman-dashboard/
 * using the DSH `webServer` service (same proven pattern as the
 * dsh-Visual-Workflow community plugin).
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { OrchestratorService } from '@helmsman/orchestrator'
import type { TopologyServiceLike } from './api.ts'
import { createApiRouter } from './api.ts'
import { createStaticHandler } from './http.ts'

export const name = '@helmsman/ui-dashboard'
export const inject = ['webServer', 'helmsman.orchestrator'] as const

export interface Config {
  /** URL prefix for the dashboard. @default '/helmsman-dashboard' */
  mountPath?: string
}

export function apply(ctx: Context, config: Config = {}) {
  const webServer = ctx.get('webServer') as {
    register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void> }): void
  }
  const orchestrator = ctx.get('helmsman.orchestrator') as OrchestratorService
  // topology is optional — the dashboard degrades to a repoPath-only mode
  const topology = ctx.get('helmsman.topology') as TopologyServiceLike | undefined

  const mountPath = (config.mountPath ?? '/helmsman-dashboard').replace(/\/+$/, '')
  const assetsDir = join(dirname(fileURLToPath(import.meta.url)), 'client')
  const api = createApiRouter({ orchestrator, topology })
  const staticHandler = createStaticHandler(`${mountPath}/`, assetsDir)

  webServer.register({
    kind: 'prefix',
    path: mountPath,
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const pathname = url.pathname
      // Bare mount path: redirect so relative asset URLs resolve.
      if (pathname === mountPath) {
        res.writeHead(301, { location: `${mountPath}/` })
        res.end()
        return
      }
      // keep the query string for API routes
      const relative = pathname.startsWith(mountPath)
        ? pathname.slice(mountPath.length) + url.search
        : req.url ?? pathname

      if (relative.startsWith('/api/') || relative === '/api') {
        const handled = await api.handle(req, res, relative)
        if (!handled) {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: 'not found' }))
        }
        return
      }

      const served = await staticHandler(pathname, res)
      if (!served) {
        res.writeHead(404)
        res.end('not found')
      }
    },
  })

  console.log(`[helmsman/ui-dashboard] serving dashboard at ${mountPath}/`)
}
