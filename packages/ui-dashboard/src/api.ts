/**
 * Dashboard REST API — thin JSON façade over the helmsman services.
 * Pure factory so the routes can be unit-tested without a real HTTP server.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AuditEntry, AuditQuery, ExecutionEvent, GateOp, MergeResolution, OrchestratorService } from '@helmsman/orchestrator'
import type { ProjectTopology } from '@helmsman/memory-topology'
import type { ArtifactService } from '@helmsman/artifacts'
import { downloadHeaders } from '@helmsman/artifacts'
import { readJsonBody, Router } from './http.ts'

export interface DashboardApiDeps {
  orchestrator: OrchestratorService
  topology?: TopologyServiceLike
  /**
   * Lazy optional service resolvers (design.md D1 + ARCHITECTURE §4): artifact
   * delivery features degrade when `helmsman.artifacts` / `helmsman.worktree`
   * are absent, so we never `inject` them and resolve `ctx.get` at request time.
   */
  artifacts?: () => ArtifactService | undefined
  worktree?: () => WorktreeServiceLike | undefined
  /** SSE tuning for tests. */
  sse?: { heartbeatMs?: number }
}

export interface TopologyServiceLike {
  listGroups(): Promise<string[]>
  loadTopology(group: string): Promise<ProjectTopology | null>
  saveTopology(topology: ProjectTopology): Promise<void>
  deleteGroup(group: string): Promise<boolean>
  createGroup(group: string, name?: string): Promise<ProjectTopology>
  scanRestApis(localPath: string): Promise<Array<{ method: string; path: string; handler?: string; description?: string }>>
  importPreview(source: 'docker-compose' | 'kubernetes' | 'openapi' | 'helmsman-declaration', text: string, inferDeps?: boolean): Promise<unknown>
  importApply(group: string, preview: unknown): Promise<ProjectTopology>
  exportYaml(group: string): Promise<string>
  /**
   * Read-only graph health (design D3): dependency cycles with their members,
   * edges pointing at undeclared services, isolated services. Optional because
   * the dashboard and memory-topology ship as independent plugins — when an
   * installed service predates the health surface the route reports
   * `available: false` instead of failing.
   */
  checkHealth?(group: string): Promise<GraphHealthLike>
  /**
   * Read-only dependency-candidate derivation (`derive-dependencies-from-calls`).
   * Optional for the same reason as `checkHealth`: an older installed
   * memory-topology yields `available: false` rather than an error.
   */
  deriveDependencies?(group: string, opts?: { serviceIds?: string[] }): Promise<DeriveResultLike>
  /**
   * Confirms candidates through the topology service's (from, to) merge path, so
   * a confirmed pair can never produce a duplicate row. `register: true` on an
   * undeclared target registers the service in the same action (「登记并确认」).
   */
  applyCandidates?(group: string, candidates: ApplyCandidateInputLike[]): Promise<ApplyCandidatesResultLike>
  /**
   * Read-only ingest of a repository's own declaration
   * (`declare-dependencies-in-repo`, `.helmsman/dependencies.yml`). Optional for
   * the same reason as `checkHealth`: an older installed memory-topology yields
   * `available: false` (status `'unavailable'`) instead of an error.
   */
  declarationPreview?(group: string, service?: string): Promise<DeclarationPreviewLike>
  /**
   * Renders what a service's declaration file WOULD say — `declared` edges only,
   * with its target path and a commit hint. Writes nothing, runs no git command.
   */
  declarationRender?(group: string, service: string): Promise<DeclarationRenderLike>
}

/**
 * Structural mirror of memory-topology's declaration ingest result. The dashboard
 * consumes the shape and declares its own copy so the two plugins stay
 * independently installable (same rationale as `GraphHealthLike`).
 */
export interface DeclarationPreviewLike {
  group: string
  service: string
  file: string | null
  /**
   * `'unavailable'` is dashboard-side only: the installed topology service has no
   * declaration support (mirrors `available: false`).
   */
  status: 'ok' | 'missing' | 'invalid' | 'no-repo-path' | 'unavailable'
  /** Existing ImportPreview shape; null unless `status === 'ok'`. */
  preview: unknown | null
  errors: string[]
  warnings: string[]
  undeclaredTargets: string[]
}

export interface DeclarationRenderLike {
  group: string
  service: string
  file: string | null
  content: string
  declared: number
  derived: number
  hint: string
}

/**
 * Structural mirrors of memory-topology's derivation payloads — the dashboard
 * only consumes the shapes, and declaring its own copies keeps the two plugins
 * independently installable (same rationale as `GraphHealthLike`).
 */
export interface CandidateEvidenceLike {
  kind: string
  file: string
  line?: number
  detail: string
  note?: string
}

export interface DeriveCandidateLike {
  from: string
  to: string
  confidence: 'high' | 'medium'
  evidence: CandidateEvidenceLike[]
  endpoints: string[]
  method?: string
  targetDeclared: boolean
  alreadyDeclared?: boolean
  wouldCreateCycle: boolean
}

export interface DeriveResultLike {
  candidates: DeriveCandidateLike[]
  scannedAt: number
  scanned?: string[]
  skipped?: Array<{ serviceId: string; reason: string }>
}

export interface ApplyCandidateInputLike {
  from: string
  to: string
  endpoints?: string[]
  method?: string
  register?: boolean
}

export interface ApplyCandidatesResultLike {
  group?: string
  topology: ProjectTopology
  applied: number
  registered: string[]
}

/**
 * Structural mirror of memory-topology's `GraphHealth` (the dashboard only ever
 * consumes the shape, and declares its own copy so the two plugins stay
 * independently installable).
 */
export interface GraphHealthLike {
  cyclic: boolean
  cycles: string[][]
  dangling: Array<{ from: string; to: string }>
  isolated: string[]
}

/**
 * Structural slice of @helmsman/worktree used by task-bundle packaging (the
 * dashboard reads diffs through this service; a task's worktrees are durable
 * across host restarts, so bundles stay buildable even after a restart).
 */
export interface WorktreeFileDiff {
  path: string
  status: string
  additions: number
  deletions: number
  diff: string
}

export interface WorktreeServiceLike {
  listWorktrees(taskId?: string): Promise<Array<{ id: string; agent: string; taskId: string; path: string; branch: string; baseRepo: string; baseSha: string; createdAt: number }>>
  getDiff(id: string): Promise<{
    worktreeId: string
    files: WorktreeFileDiff[]
    additions: number
    deletions: number
  }>
}

/** One registered bundle artifact (shape returned to the SPA). */
export interface BundleArtifactInfo {
  id: string
  fileName: string
  duplicate: boolean
}

/** Machine-readable companion of a task bundle (design.md D3). */
export interface TaskBundleManifest {
  version: 1
  taskId: string
  prompt: string
  status: string
  /**
   * Task start time (ISO). Derived from the task record, NEVER from the
   * packaging moment: the manifest is content-addressed, so any per-request
   * timestamp would defeat deduplication (spec artifact-delivery).
   */
  createdAt: string
  /** Terminal time (ISO) when the task reached its final state, else null. */
  endedAt: string | null
  baseSha: string | null
  /** merge/discard outcome: which agents' changes are still in their worktrees. */
  notes: string[]
  agents: Array<{
    agent: string
    state: string
    worktreeId?: string
    files: Array<{ path: string; status: string; additions: number; deletions: number }>
  }>
}

export const SSE_HEARTBEAT_MS = 15_000
export const TERMINAL_TASK_STATES: ReadonlySet<string> = new Set(['COMPLETED', 'PARTIAL_FAILED', 'ALL_FAILED', 'CANCELLED'])

function isTerminalTaskState(status: string): boolean {
  return TERMINAL_TASK_STATES.has(status)
}

function isTerminalEvent(event: ExecutionEvent): boolean {
  return event.kind === 'task-state' && isTerminalTaskState(event.payload.status)
}

export function createApiRouter(deps: DashboardApiDeps): Router {
  const router = new Router()
  const { orchestrator, topology } = deps
  const heartbeatMs = deps.sse?.heartbeatMs ?? SSE_HEARTBEAT_MS

  router.get('api/state', async () => {
    const [agents, tasks] = [await orchestrator.checkAgents(), orchestrator.listTasks()]
    return {
      serverTime: Date.now(),
      groups: topology ? await topology.listGroups() : [],
      agents,
      tasks: tasks.map(summarizeTask),
      usage: orchestrator.getUsage(),
    }
  })

  router.post('api/task', async ({ req }) => {
    const body = await readJsonBody(req)
    const prompt = String(body.prompt ?? '')
    const agents = Array.isArray(body.agents) ? body.agents.map(String) : []
    const result = await orchestrator.runParallelTask({
      prompt,
      agents,
      ...(typeof body.projectGroupId === 'string' && body.projectGroupId ? { projectGroupId: body.projectGroupId } : {}),
      ...(typeof body.repoPath === 'string' && body.repoPath ? { repoPath: body.repoPath } : {}),
      ...(body.cascade === true ? { cascade: true } : {}),
      ...(typeof body.timeoutSec === 'number' ? { timeoutSec: body.timeoutSec } : {}),
    })
    return result
  })

  router.post('api/task/:id/cancel', async ({ req, params }) => {
    const body = await readJsonBody(req)
    // UI-originated cancel → attribute the audit decision to 'ui' (not 'tool').
    await orchestrator.cancelTask(params.id!, typeof body.confirmationToken === 'string' ? body.confirmationToken : undefined, 'ui')
    return { ok: true, taskId: params.id }
  })

  router.post('api/task/:id/retry', async ({ req, params }) => {
    const body = await readJsonBody(req)
    const agents = Array.isArray(body.agents) ? body.agents.map(String) : undefined
    return await orchestrator.retryTask(params.id!, agents)
  })

  router.get('api/task/:id/log', async ({ params, query }) => {
    const agent = query.get('agent') ?? ''
    const task = orchestrator.getTaskStatus(params.id!)
    const run = task?.agents[agent]
    return { agent, log: run?.log ?? '', state: run?.state ?? null }
  })

  // Durable execution timeline: cursor-paginated events + history-pruned signal.
  router.get('api/task/:id/events', async ({ params, query }) => {
    const taskId = params.id!
    const after = parseAfter(query.get('after'))
    const task = await loadTaskRecord(orchestrator, taskId)
    const page = await orchestrator.history.getEvents(taskId, after)
    const last = page.events.length > 0 ? page.events[page.events.length - 1]!.seq : after
    return {
      task: task ? summarizeTask(task) : null,
      events: page.events,
      pruned: page.pruned,
      after,
      nextCursor: last,
    }
  })

  // Per-task SSE stream: replay from the durable timeline, then tail live.
  router.get('api/task/:id/stream', async ({ params, query, req, res }) => {
    const taskId = params.id!
    const after = parseAfter(query.get('after'))
    await streamTaskEvents({
      orchestrator,
      taskId,
      after,
      heartbeatMs,
      req,
      res,
    })
    return undefined
  })

  router.post('api/task/:id/merge', async ({ req, params }) => {
    const body = await readJsonBody(req)
    return await orchestrator.mergeTask({
      taskId: params.id!,
      ...(Array.isArray(body.agents) ? { agents: body.agents.map(String) } : {}),
      ...(Array.isArray(body.files) ? { files: body.files.map(String) } : {}),
      ...(body.discardAfterMerge === true ? { discardAfterMerge: true } : {}),
      ...(typeof body.confirmationToken === 'string' ? { confirmationToken: body.confirmationToken } : {}),
      ...(body.resolutions != null && typeof body.resolutions === 'object' ? { resolutions: body.resolutions as Record<string, MergeResolution> } : {}),
      source: 'ui',
    })
  })

  router.post('api/task/:id/discard', async ({ req, params }) => {
    const body = await readJsonBody(req)
    // UI-originated discard → attribute the audit decision to 'ui' (not 'tool').
    await orchestrator.discardTask(params.id!, typeof body.confirmationToken === 'string' ? body.confirmationToken : undefined, 'ui')
    return { ok: true }
  })

  // -----------------------------------------------------------------------
  // Delivery artifacts (add-artifact-delivery-endpoints): a terminal task's
  // per-agent diffs become a downloadable bundle. Content-addressed by the
  // registry, so repeated requests for the same task never duplicate storage.
  // -----------------------------------------------------------------------

  router.post('api/task/:id/bundle', async ({ params }) => {
    const artifacts = deps.artifacts?.()
    if (!artifacts) throw new Error('artifact registry unavailable (@helmsman/artifacts not installed)')
    const taskId = params.id!
    const task = await loadTaskRecord(orchestrator, taskId)
    if (!task) throw new Error(`task not found: ${taskId}`)
    if (!isTerminalTaskState(task.status)) {
      throw new Error(`task ${taskId} has not reached a terminal state (${task.status})`)
    }
    const worktreeSvc = deps.worktree?.()
    const worktrees = worktreeSvc ? await worktreeSvc.listWorktrees(taskId) : []
    const { manifest, sections } = await collectTaskBundle(task, worktrees, worktreeSvc)
    const enc = new TextEncoder()
    const meta: Record<string, unknown> = { producer: 'dashboard:bundle', taskId }
    const patch = await artifacts.register({
      type: 'task-bundle',
      fileName: `${taskId}.bundle.patch`,
      bytes: enc.encode(composeTaskBundleText(task, manifest, sections)),
      meta: { ...meta, kind: 'patch' },
    })
    const bundle = await artifacts.register({
      type: 'task-bundle',
      fileName: `${taskId}.bundle.json`,
      bytes: enc.encode(`${JSON.stringify(manifest, null, 2)}\n`),
      meta: { ...meta, kind: 'json' },
    })
    return {
      taskId,
      status: task.status,
      patch: { id: patch.id, fileName: `${taskId}.bundle.patch`, duplicate: patch.duplicate },
      bundle: { id: bundle.id, fileName: `${taskId}.bundle.json`, duplicate: bundle.duplicate },
    }
  })

  // List + download endpoints delegate to `helmsman.artifacts` and degrade
  // gracefully to empty/404 when the registry plugin is absent.
  router.get('api/artifacts', async () => {
    const artifacts = deps.artifacts?.()
    if (!artifacts) return { artifacts: [], available: false }
    return { artifacts: await artifacts.list(), available: true }
  })

  router.get('api/artifacts/:id', async ({ params, res }) => {
    const artifacts = deps.artifacts?.()
    const id = params.id!
    if (!artifacts) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'artifact registry unavailable' }))
      return undefined
    }
    const found = await artifacts.resolve(id)
    if (!found) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: `artifact not found: ${id}` }))
      return undefined
    }
    // CJK-safe delivery headers (design D4): ASCII fallback + RFC 5987 filename*.
    const headers = downloadHeaders(found.meta.fileName)
    res.writeHead(200, {
      'content-type': headers['content-type'],
      'content-disposition': headers['content-disposition'],
      'content-length': String(found.bytes.byteLength),
      'cache-control': 'no-store',
    })
    res.end(found.bytes)
    return undefined
  })

  // -----------------------------------------------------------------------
  // Approval gate (design D1/D4): request → decide → execute with token.
  // -----------------------------------------------------------------------

  router.get('api/approvals/pending', async () => {
    return { approvals: orchestrator.listPendingConfirmations() }
  })

  // Read-only policy lookup: lets the SPA decide whether to run the two-phase
  // request→decide flow before a destructive action (auto-grant → run direct).
  router.get('api/approvals/policy', async ({ query }) => {
    const op = String(query.get('op') ?? '')
    return { op, mode: orchestrator.policyMode(op as GateOp), confirmRequired: orchestrator.isConfirmRequired(op as GateOp) }
  })

  router.post('api/approvals', async ({ req }) => {
    const body = await readJsonBody(req)
    const op = String(body.op ?? '')
    if (!op) throw new Error('op is required (merge | discard | cancel | worktree-cleanup | topology-delete)')
    const approval = orchestrator.requestConfirmation(
      {
        op: op as GateOp,
        ...(typeof body.taskId === 'string' && body.taskId ? { taskId: body.taskId } : {}),
        ...(typeof body.group === 'string' && body.group ? { group: body.group } : {}),
      },
      'ui',
    )
    return {
      approvalId: approval.approvalId,
      op: approval.op,
      scope: approval.scope,
      source: approval.source,
      requestedAt: approval.requestedAt,
      expiresAt: approval.expiresAt,
    }
  })

  router.post('api/approvals/:id/decision', async ({ req, params }) => {
    const body = await readJsonBody(req)
    return orchestrator.decideConfirmation(params.id!, body.approve !== false)
  })

  // -----------------------------------------------------------------------
  // Read-only audit trail (design D3) — no mutation surface exists.
  // -----------------------------------------------------------------------

  router.get('api/audit', async ({ query }) => {
    const q: AuditQuery = {}
    const op = query.get('op')
    const taskId = query.get('taskId')
    const from = query.get('from')
    const to = query.get('to')
    if (op) q.op = op as GateOp
    if (taskId) q.taskId = taskId
    const nf = from === null ? NaN : Number(from)
    const nt = to === null ? NaN : Number(to)
    if (Number.isFinite(nf)) q.from = nf
    if (Number.isFinite(nt)) q.to = nt
    const entries: AuditEntry[] = await orchestrator.getAudit(q)
    return { entries }
  })

  if (topology) {
    router.get('api/topology', async ({ query }) => {
      const group = query.get('group') ?? ''
      return { group, topology: await topology.loadTopology(group) }
    })

    router.post('api/topology/save', async ({ req }) => {
      const body = await readJsonBody(req)
      await topology.saveTopology(body.topology as ProjectTopology)
      return { ok: true }
    })

    // Read-only graph health check (design D3): the SPA pulls it after a save
    // and renders a non-blocking warning strip. Purely additive — no mutation
    // surface, and 404 when the topology plugin is absent (route not mounted).
    // An older installed memory-topology without `checkHealth` degrades to
    // `available: false` rather than erroring.
    router.get('api/topology/health', async ({ query }) => {
      const group = query.get('group') ?? ''
      const checkHealth = topology.checkHealth
      if (typeof checkHealth !== 'function') return { group, health: null, available: false }
      return { group, health: await checkHealth.call(topology, group), available: true }
    })

    // Read-only dependency-candidate derivation (derive-dependencies-from-calls):
    // it scans local service trees, so it has NO mutation surface — confirming is
    // the separate POST below. Same degradation contract as the health route:
    // an older installed service → `available: false`; no plugin → route unmounted
    // (host answers 404).
    router.get('api/topology/derive', async ({ query }) => {
      const group = query.get('group') ?? ''
      const derive = topology.deriveDependencies
      if (typeof derive !== 'function') return { group, result: null, available: false }
      return { group, result: await derive.call(topology, group), available: true }
    })

    // Human confirmation of (a subset of) those candidates. The topology service
    // merges through the same (from, to) path as every other writer, so this can
    // never create a duplicate row; the response carries the persisted topology so
    // the SPA refreshes its dependency rows without another round trip.
    router.post('api/topology/apply-candidates', async ({ req }) => {
      const body = await readJsonBody(req)
      const group = String(body.group ?? '')
      if (!group) throw new Error('group is required')
      const candidates = Array.isArray(body.candidates) ? (body.candidates as ApplyCandidateInputLike[]) : []
      const apply = topology.applyCandidates
      if (typeof apply !== 'function') {
        return { group, topology: null, applied: 0, registered: [], available: false }
      }
      const result = await apply.call(topology, group, candidates)
      return { ...result, available: true }
    })

    router.post('api/topology/create', async ({ req }) => {
      const body = await readJsonBody(req)
      const group = String(body.group ?? '').trim()
      if (!group) throw new Error('group is required')
      return { topology: await topology.createGroup(group, typeof body.name === 'string' ? body.name : undefined) }
    })

    router.post('api/topology/delete', async ({ req }) => {
      const body = await readJsonBody(req)
      const group = String(body.group ?? '')
      if (!group) throw new Error('group is required')
      // Gated at the orchestrator/topology service boundary (design D4): the
      // operator must hold a valid `topology-delete:<group>` confirmation
      // token unless the policy marks the operation auto-grant.
      await orchestrator.assertApproved(
        { op: 'topology-delete', group },
        typeof body.confirmationToken === 'string' ? body.confirmationToken : undefined,
        'ui',
      )
      const ok = await topology.deleteGroup(group)
      return { ok }
    })

    router.post('api/topology/scan-api', async ({ req }) => {
      const body = await readJsonBody(req)
      const localPath = String(body.localPath ?? '')
      const endpoints = await topology.scanRestApis(localPath)
      return { total: endpoints.length, endpoints }
    })

    router.post('api/topology/import-preview', async ({ req }) => {
      const body = await readJsonBody(req)
      return await topology.importPreview(
        body.source as 'docker-compose' | 'kubernetes' | 'openapi' | 'helmsman-declaration',
        String(body.text ?? ''),
        body.inferDeps !== false,
      )
    })

    router.post('api/topology/import-apply', async ({ req }) => {
      const body = await readJsonBody(req)
      const group = String(body.group ?? '')
      const topologyAfter = await topology.importApply(group, body.preview)
      return { topology: topologyAfter }
    })

    // ---------------------------------------------------------------------
    // Repository declaration (declare-dependencies-in-repo): 「📥 从仓库抓取
    // 依赖」 reads `<repo>/.helmsman/dependencies.yml` and hands the result to the
    // EXISTING preview/apply dialog, and 「💾 写回声明文件」 drafts the file for the
    // human to commit. Both are read-only here — no git operation is performed.
    // Same degradation contract as the health/derive routes: an older installed
    // service → `available: false`; no plugin → the route is not mounted (404).
    // ---------------------------------------------------------------------

    router.get('api/topology/declaration', async ({ query }) => {
      const group = query.get('group') ?? ''
      const service = query.get('service') ?? ''
      if (!group) throw new Error('group is required')
      const read = topology.declarationPreview
      if (typeof read !== 'function') {
        return {
          group,
          service,
          file: null,
          status: 'unavailable',
          preview: null,
          errors: [],
          warnings: [],
          undeclaredTargets: [],
          available: false,
        }
      }
      const result = await read.call(topology, group, service || undefined)
      return { ...result, available: true }
    })

    router.get('api/topology/declaration/render', async ({ query }) => {
      const group = query.get('group') ?? ''
      const service = query.get('service') ?? ''
      if (!group) throw new Error('group is required')
      if (!service) throw new Error('service is required')
      const render = topology.declarationRender
      if (typeof render !== 'function') {
        return { group, service, file: null, content: '', declared: 0, derived: 0, hint: '', available: false }
      }
      return { ...(await render.call(topology, group, service)), available: true }
    })

    // Topology YAML export is delivered as a registered artifact so the file
    // keeps its real `.yaml` name (the old endpoint mislabeled the body .json).
    // Without the registry we fall back to a direct, correctly-named download.
    router.get('api/topology/export', async ({ query, res }) => {
      const group = query.get('group') ?? ''
      const yaml = await topology.exportYaml(group)
      const fileName = `helmsman-topology-${group}.yaml`
      const artifacts = deps.artifacts?.()
      if (artifacts) {
        const result = await artifacts.register({
          type: 'topology',
          fileName,
          bytes: new TextEncoder().encode(yaml),
          meta: { producer: 'dashboard:topology-export', group },
        })
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(JSON.stringify({ artifactId: result.id, fileName, mime: 'application/yaml', group, duplicate: result.duplicate }))
        return undefined
      }
      const headers = downloadHeaders(fileName)
      res.writeHead(200, {
        'content-type': headers['content-type'],
        'content-disposition': headers['content-disposition'],
        'cache-control': 'no-store',
      })
      res.end(yaml)
      return undefined
    })
  }

  return router
}

function summarizeTask(task: ReturnType<OrchestratorService['listTasks']>[number]) {
  return {
    id: task.id,
    prompt: task.prompt,
    status: task.status,
    projectGroupId: task.projectGroupId ?? null,
    cascade: task.cascade,
    timeoutSec: task.timeoutSec,
    createdAt: task.createdAt,
    endedAt: task.endedAt ?? null,
    // last-known state restored after a host restart, run never finished
    interrupted: task.interrupted === true,
    agents: Object.fromEntries(
      Object.entries(task.agents).map(([name, run]) => [
        name,
        {
          state: run.state,
          attempts: run.attempts,
          startedAt: run.startedAt ?? null,
          endedAt: run.endedAt ?? null,
          exitCode: run.exitCode ?? null,
          error: run.error ?? null,
          stats: run.stats ?? null,
          conflictingFiles: run.conflictingFiles ?? [],
          hasDiff: (run.diffs?.length ?? 0) > 0,
        },
      ]),
    ),
  }
}

/** A task may live in the live map, or (after restart/pruning) in history. */
async function loadTaskRecord(orchestrator: OrchestratorService, taskId: string): Promise<ReturnType<OrchestratorService['listTasks']>[number] | undefined> {
  return orchestrator.getTaskStatus(taskId) ?? (await orchestrator.history.getTask(taskId))
}

function parseAfter(raw: string | null): number {
  const n = raw === null ? 0 : Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
}

/** Task shape needed by task-bundle packaging (structural — avoids importing
 * the orchestrator's TaskRecord wholesale into the router layer). */
interface BundleTaskShape {
  id: string
  prompt: string
  status: string
  /** Task start time (epoch ms) — stable across requests, so bundle bytes dedupe. */
  createdAt: number
  /** Terminal time (epoch ms) when reached; absent while running. */
  endedAt?: number
  agents: Record<string, {
    state: string
    diffs?: Array<{ path: string; status: string; additions: number; deletions: number; diff: string }>
  }>
}

/**
 * Task-bundle collection (design D3): prefer each agent's LIVE worktree diff
 * (durable across host restarts) and fall back to the run snapshot held by the
 * orchestrator when a worktree was removed (merged/discarded) or unreadable.
 * `manifest` is the machine-readable `.json` companion; `sections` carry the
 * raw diff text used to compose the `.patch` file.
 */
async function collectTaskBundle(
  task: BundleTaskShape,
  worktrees: Array<{ id: string; agent: string; baseSha: string }>,
  worktreeSvc: WorktreeServiceLike | undefined,
): Promise<{ manifest: TaskBundleManifest; sections: Array<{ agent: string; state: string; files: WorktreeFileDiff[] }> }> {
  const notes: string[] = []
  const sections: Array<{ agent: string; state: string; files: WorktreeFileDiff[] }> = []
  for (const [agent, run] of Object.entries(task.agents)) {
    const record = worktrees.find((w) => w.agent === agent)
    let files: WorktreeFileDiff[] = (run.diffs ?? []).map((d) => ({ ...d }))
    let worktreeId: string | undefined
    if (record) {
      worktreeId = record.id
      if (worktreeSvc) {
        try {
          const fresh = await worktreeSvc.getDiff(record.id)
          if (fresh.files.length > 0) files = fresh.files
          else notes.push(`${agent}: worktree has no pending diff (changes merged or none)`)
        } catch {
          notes.push(`${agent}: worktree diff unreadable, packaging the run snapshot`)
        }
      }
    } else if (run.diffs?.length) {
      notes.push(`${agent}: worktree already removed (merged/discarded), packaging the run snapshot`)
    }
    if (files.length === 0) continue
    sections.push({ agent, state: run.state, files })
  }
  const first = worktrees[0]
  const manifest: TaskBundleManifest = {
    version: 1,
    taskId: task.id,
    prompt: task.prompt,
    status: task.status,
    // Stable inputs only — see the TaskBundleManifest doc comment.
    createdAt: new Date(task.createdAt).toISOString(),
    endedAt: typeof task.endedAt === 'number' ? new Date(task.endedAt).toISOString() : null,
    baseSha: first?.baseSha ?? null,
    notes,
    agents: sections.map((s) => ({
      agent: s.agent,
      state: s.state,
      ...(worktrees.find((w) => w.agent === s.agent) ? { worktreeId: worktrees.find((w) => w.agent === s.agent)!.id } : {}),
      files: s.files.map((f) => ({ path: f.path, status: f.status, additions: f.additions, deletions: f.deletions })),
    })),
  }
  return { manifest, sections }
}

/**
 * Concatenates each agent's file diffs into ONE git-applyable `.patch` text.
 * Separator lines start with `#`, which `git apply` ignores, so the file is
 * both human-readable AND directly consumable via `git apply <bundle.patch>`.
 */
export function composeTaskBundleText(
  task: Pick<BundleTaskShape, 'id'>,
  manifest: TaskBundleManifest,
  sections: Array<{ agent: string; files: WorktreeFileDiff[] }>,
): string {
  const out: string[] = []
  out.push('# Helmsman task bundle')
  out.push(`# taskId: ${task.id}`)
  out.push(`# status: ${manifest.status}`)
  out.push(`# created: ${manifest.createdAt}`)
  if (manifest.baseSha) out.push(`# baseSha: ${manifest.baseSha}`)
  const prompt = manifest.prompt.replace(/\r?\n/g, ' ').slice(0, 200)
  out.push(`# prompt: ${prompt}`)
  out.push('#')
  out.push('# git apply this file to consume the combined agent patches.')
  for (const section of sections) {
    out.push('')
    out.push(`# ============ agent: ${section.agent} ============`)
    for (const file of section.files) {
      out.push('')
      out.push(`# --- file: ${file.path} (${file.status}, +${file.additions}/-${file.deletions}) ---`)
      out.push(file.diff)
    }
  }
  return `${out.join('\n')}\n`
}

/**
 * SSE task stream (design D4): subscribe to the task's live tail FIRST (events
 * arriving meanwhile are buffered), then replay `seq > after` from the durable
 * timeline, merge anything the buffer holds beyond the replay end, and finally
 * tail live. A cursor read therefore never misses and never duplicates, and
 * the stream closes once the task reaches a terminal state (or disconnects).
 */
async function streamTaskEvents(args: {
  orchestrator: OrchestratorService
  taskId: string
  after: number
  heartbeatMs: number
  req: IncomingMessage
  res: ServerResponse
}): Promise<void> {
  const { orchestrator, taskId, after, heartbeatMs, req, res } = args
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // ask any buffering intermediary to pass the stream through untouched
    'x-accel-buffering': 'no',
  })
  res.write(': connected\n\n')

  let closed = false
  let sentMax = after
  let heartbeat: ReturnType<typeof setInterval> | undefined

  const send = (event: ExecutionEvent): void => {
    if (closed || event.seq <= sentMax) return
    sentMax = event.seq
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }
  const sendPruned = (): void => {
    if (closed) return
    res.write(`event: history-pruned\ndata: ${JSON.stringify({ after })}\n\n`)
  }

  const close = (): void => {
    if (closed) return
    closed = true
    if (heartbeat) clearInterval(heartbeat)
    unsubscribe()
    if (!res.writableEnded) {
      try {
        res.end()
      } catch {
        // socket already gone
      }
    }
  }

  // Subscribe first, replay second (D4) — events landing in between are kept
  // in `buffered` and merged after the replay so none are lost.
  let replaying = true
  const buffered: ExecutionEvent[] = []
  let unsubscribe: () => void = () => undefined
  unsubscribe = orchestrator.history.subscribe(taskId, (event) => {
    if (closed) return
    if (replaying) {
      buffered.push(event)
      return
    }
    send(event)
    if (isTerminalEvent(event)) close()
  })

  // Disconnect: client gone → tear everything down.
  res.on('close', close)
  req.on('close', close)

  heartbeat = setInterval(() => {
    if (closed) return
    res.write(': hb\n\n')
  }, heartbeatMs)

  const page = await orchestrator.history.getEvents(taskId, after)
  if (page.pruned) sendPruned()
  for (const event of page.events) send(event)
  replaying = false
  // Flush anything that arrived while we were replaying, skipping duplicates
  // that the durable page already covered (cursor comparison in send()).
  for (const event of [...buffered].sort((a, b) => a.seq - b.seq)) send(event)
  buffered.length = 0

  // Terminal now — or restored from a host restart (interrupted, nothing will
  // be produced unless the user retries) → close. The client reconnects (with
  // its cursor) if the task later runs again.
  const current = await loadTaskRecord(orchestrator, taskId)
  if (current && (isTerminalTaskState(current.status) || current.interrupted === true)) close()
  else if (!current) close() // unknown/pruned task id — nothing to follow
}
