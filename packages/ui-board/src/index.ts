/**
 * @helmsman/ui-board — host half.
 *
 * Serves the standalone task-kanban SPA and its REST API under
 * /helmsman-board/ using the DSH `webServer` service (same proven pattern as
 * ui-dashboard / ui-diff / ui-workbench).
 *
 * Required service: `helmsman.board` (change `add-task-workitem-model`) — the
 * ONLY writer of stages, gates and WIP. Optional services: `helmsman.orchestrator`
 * (run timeline / SSE, change A), `helmsman.artifacts` (artifact jump-offs,
 * change D) and `helmsman.topology` (impacted-service candidates); they are
 * resolved lazily per request so the page renders — minus the run panel /
 * artifact links — when they are absent (design D1).
 *
 * The embeddable <BoardView/> component (the very same React source as the
 * standalone SPA) is exported from the client half: `@helmsman/ui-board/client/embed`.
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { ArtifactLike, BoardServiceLike, OrchestratorLike, TopologyLike } from './api.ts'
import { createBoardApiRouter } from './api.ts'
import { createBoardGateProbe } from './gate-probe.ts'
import { createStaticHandler } from './http.ts'

export const name = '@helmsman/ui-board'
/** `helmsman.board` is REQUIRED: without the service the page has nothing to render. */
export const inject = ['webServer', 'helmsman.board'] as const

export interface Config {
  /** URL prefix for the board. @default '/helmsman-board' */
  mountPath?: string
  /**
   * Where the dashboard's durable-history SSE lives (change A). Configurable
   * because the mount is a deployment detail: if it moves, the run timeline
   * falls back to polling instead of breaking (design 风险).
   * @default '/helmsman-dashboard'
   */
  dashboardMount?: string
  /** Existing multi-agent diff view, for conflict jump-offs. @default '/helmsman-diff' */
  diffMount?: string
  /** Workbench mount, for doc/draft jump-offs. @default '/helmsman-workbench' */
  workbenchMount?: string
  /** Coarse polling interval for the run timeline fallback. @default 5000 */
  pollMs?: number
}

export function apply(ctx: Context, config: Config = {}) {
  const webServer = ctx.get('webServer') as {
    register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void> }): void
  }
  const board = ctx.get('helmsman.board') as BoardServiceLike | undefined
  if (!board) {
    console.warn('[helmsman/ui-board] helmsman.board missing — kanban page not mounted')
    return
  }

  // Wire the `dev → done` archival gate (board design D4/D5). Board stays
  // self-contained and only accepts a probe; the two adjudicated facts (merged
  // run + merge audit record) live in orchestrator, which this host resolves
  // lazily — same convention as the run panel below. Without this the gate has
  // no probe and refuses every archival advance with "未配置 gate probe".
  // Optional call: an older `helmsman.board` without the seam still mounts.
  board.setGateProbe?.(
    createBoardGateProbe(() => ctx.get('helmsman.orchestrator') as OrchestratorLike | undefined),
  )

  const mountPath = (config.mountPath ?? '/helmsman-board').replace(/\/+$/, '')
  const assetsDir = join(dirname(fileURLToPath(import.meta.url)), 'client')
  // Optional service dependencies are resolved lazily at request time
  // (ARCHITECTURE §4): the host boots without them and the run panel /
  // artifact jump-offs degrade instead of failing.
  const api = createBoardApiRouter({
    board,
    orchestrator: () => ctx.get('helmsman.orchestrator') as OrchestratorLike | undefined,
    artifacts: () => ctx.get('helmsman.artifacts') as ArtifactLike | undefined,
    topology: () => ctx.get('helmsman.topology') as TopologyLike | undefined,
    mountPath,
    ...(config.dashboardMount ? { dashboardMount: config.dashboardMount } : {}),
    ...(config.diffMount ? { diffMount: config.diffMount } : {}),
    ...(config.workbenchMount ? { workbenchMount: config.workbenchMount } : {}),
    ...(typeof config.pollMs === 'number' ? { pollMs: config.pollMs } : {}),
  })
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

  console.log(`[helmsman/ui-board] serving task kanban at ${mountPath}/`)
}
