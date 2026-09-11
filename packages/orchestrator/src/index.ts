/**
 * @helmsman/orchestrator — DSH plugin entry.
 *
 * Provides the `helmsman.orchestrator` cordis service and registers agent
 * tools so the fleet can also be driven headlessly (PRD 第 6 步验证方式).
 *
 * Governance wiring: the service core is constructed with the real policy
 * (`~/.helmsman/policy.json`, HELMSMAN_HOME aware) and the JSONL audit
 * journal (`~/.helmsman/audit/audit.jsonl`), so destructive operations are
 * code-level gated and every gated decision is journaled (fsync before the
 * side effect, fail-closed).
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'
import { OrchestratorCore, type ConfirmationRequest } from './core.ts'
import { JsonlHistoryStore } from './history/jsonl.ts'
import type { ExecutionEvent, EventsPage } from './history/types.ts'
import { JsonlAuditJournal } from './audit/journal.ts'
import type { AuditQuery, AuditEntry } from './audit/journal.ts'
import { ConfirmationGate, type AuditSource, type DecideResult, type PendingApproval } from './gate/gate.ts'
import { loadPolicyFileSync, type ConfirmationPolicy, type GateOp, type PolicyMode } from './gate/policy.ts'
import type { AgentAdapter, MergeTaskParams, RunParallelParams, TaskRecord, TaskState, TopologyLike, WorktreeLike } from './types.ts'

export const name = '@helmsman/orchestrator'
/** hard deps: `tools` for tool registration; worktrees are the isolation primitive */
export const inject = ['tools', 'helmsman.worktree'] as const

export interface Config {
  defaultTimeoutSec?: number
  maxRateLimitAttempts?: number
  circuitBreakerThreshold?: number
  circuitBreakerCooldownMs?: number
  maxTasksKept?: number
  /** History directory override. @default ~/.helmsman/history (HELMSMAN_HOME aware) */
  historyDir?: string
  /** Durable history retention policy. @default { maxTasks: 50, maxEventRowsPerTask: 2000 } */
  retention?: { maxTasks?: number; maxEventRowsPerTask?: number }
  /** Confirmation-policy file override. @default ~/.helmsman/policy.json */
  policyPath?: string
  /** Audit journal file override. @default ~/.helmsman/audit/audit.jsonl */
  auditPath?: string
}

export interface OrchestratorHistoryReader {
  /** Last-known lifecycle record of one task (undefined when unknown/pruned). */
  getTask(taskId: string): Promise<TaskRecord | undefined>
  /** Cursor read over the durable timeline: events with `seq > after`. */
  getEvents(taskId: string, after: number): Promise<EventsPage>
  /** Live tail — fires after an event is durably appended; returns unsubscribe. */
  subscribe(taskId: string, listener: (event: ExecutionEvent) => void): () => void
}

export interface OrchestratorService {
  registerAdapter(adapter: AgentAdapter): void
  checkAgents(): Promise<Record<string, { installed: boolean; version?: string }>>
  runParallelTask(params: RunParallelParams): Promise<{ taskId: string }>
  /**
   * Cancel a running task. Rejects when the task does not exist or is not
   * cancellable (only RUNNING tasks can be cancelled) — rejected cancels are
   * neither gated nor journaled. `source` attributes the audit record
   * ('ui' for dashboard routes, 'tool' for the headless tool).
   */
  cancelTask(taskId: string, confirmationToken?: string, source?: AuditSource): Promise<void>
  getTaskStatus(taskId: string): TaskRecord | undefined
  listTasks(): TaskRecord[]
  retryTask(taskId: string, agents?: string[]): Promise<{ taskId: string }>
  mergeTask(params: Parameters<OrchestratorCore['mergeTask']>[0]): Promise<Awaited<ReturnType<OrchestratorCore['mergeTask']>>>
  /** Discard a task's worktrees. Optional `source` mirrors cancelTask ('ui' for dashboard routes, 'tool' default for the headless tool). */
  discardTask(taskId: string, confirmationToken?: string, source?: AuditSource): Promise<void>
  getUsage(): Record<string, { runs: number; promptChars: number; outputChars: number; estimatedTokens: number }>
  /** Read-only durable execution history (timeline + last-known task). */
  history: OrchestratorHistoryReader

  // ---- Approval gate (design D1/D4) -------------------------------------
  /** Whether an operation currently requires confirmation under the policy. */
  isConfirmRequired(op: GateOp): boolean
  /** Policy mode of an operation (UI/tool messaging). */
  policyMode(op: GateOp): PolicyMode
  /** Phase 1: record a pending confirmation request. */
  requestConfirmation(req: ConfirmationRequest, source?: AuditSource): PendingApproval
  /** Phase 2: approve (mint one-time token) or deny a pending request. The
   * decision is journaled before it returns. */
  decideConfirmation(approvalId: string, approve: boolean): Promise<DecideResult>
  /** Live pending confirmations (newest first). */
  listPendingConfirmations(): PendingApproval[]
  /** Single enforcement point for gated ops executed outside the engine. */
  assertApproved(req: ConfirmationRequest, confirmationToken: string | undefined, source?: AuditSource): Promise<void>
  /** Canonical scope key for a request (op + task/group ids). */
  scopeKey(op: GateOp, req: ConfirmationRequest): string

  // ---- Audit trail (design D3) ------------------------------------------
  /** Read-only audit query; no mutation surface exists. */
  getAudit(query?: AuditQuery): Promise<AuditEntry[]>

  // ---- Merge conflict semantics (design D5) -----------------------------
  /**
   * Real conflicts for a task = files whose combined agent patches fail a
   * dry-run `git apply --check` on the base repo (read-only; no changes).
   */
  getRealConflicts(taskId: string, agents?: string[]): Promise<string[]>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    'helmsman.orchestrator': OrchestratorService
  }
  interface Events {
    /** Emitted on every task mutation; UI/SSE consumers subscribe here. */
    'helmsman/task-updated'(task: TaskRecord): void
  }
}

const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set(['COMPLETED', 'PARTIAL_FAILED', 'ALL_FAILED', 'CANCELLED'])

export async function apply(ctx: Context, config: Config = {}) {
  const worktree = ctx.get('helmsman.worktree') as WorktreeLike
  // topology is optional: orchestrator works without it (direct repoPath runs)
  const topology = ctx.get('helmsman.topology') as TopologyLike | undefined

  const retention = config.retention ?? {}
  const history = new JsonlHistoryStore({
    ...(config.historyDir ? { rootDir: config.historyDir } : {}),
    maxTasks: retention.maxTasks ?? 50,
    maxEventRowsPerTask: retention.maxEventRowsPerTask ?? 2000,
  })

  // Governance: real policy + durable JSONL audit journal (design D2/D3).
  const policy: ConfirmationPolicy = loadPolicyFileSync(config.policyPath)
  const journal = new JsonlAuditJournal(config.auditPath)

  // Startup retention pass (D6): bound durable history before restoring.
  await history.prune()

  const previousStates = new Map<string, TaskState>()

  const core = new OrchestratorCore({
    worktree,
    topology: (): TopologyLike | undefined => {
      const t = ctx.get('helmsman.topology') as TopologyLike | undefined
      return t
    },
    defaultTimeoutSec: config.defaultTimeoutSec ?? 300,
    maxRateLimitAttempts: config.maxRateLimitAttempts ?? 3,
    circuitBreakerThreshold: config.circuitBreakerThreshold ?? 5,
    circuitBreakerCooldownMs: config.circuitBreakerCooldownMs ?? 30_000,
    maxTasksKept: config.maxTasksKept ?? 50,
    history,
    policy,
    journal,
    onTaskUpdated: (task) => {
      // D6: also prune once per task *completing* (transition into a terminal
      // state), so a long-lived host cannot accumulate unbounded history.
      const wasTerminal = previousStates.has(task.id) && TERMINAL_TASK_STATES.has(previousStates.get(task.id)!)
      const nowTerminal = TERMINAL_TASK_STATES.has(task.status)
      previousStates.set(task.id, task.status)
      if (!wasTerminal && nowTerminal) {
        history.prune().catch((err) => {
          console.error(`[helmsman/history] prune failed: ${err instanceof Error ? err.message : String(err)}`)
        })
      }
      ctx.emit('helmsman/task-updated', task)
    },
  })

  // Restore last-known task records so a restarted host keeps showing them.
  // Interrupted tasks surface at their last-known state (never auto-resumed).
  const restored = await history.listTasks()
  if (restored.length > 0) core.restoreTasks(restored)

  const service: OrchestratorService = {
    registerAdapter: (adapter) => core.registerAdapter(adapter),
    checkAgents: () => core.checkAgents(),
    runParallelTask: (params) => core.runParallelTask(params),
    cancelTask: (taskId, confirmationToken, source) => core.cancelTask(taskId, confirmationToken, source ?? 'tool'),
    getTaskStatus: (taskId) => core.getTaskStatus(taskId),
    listTasks: () => core.listTasks(),
    retryTask: (taskId, agents) => core.retryTask(taskId, agents),
    mergeTask: (params) => core.mergeTask({ ...params, source: params.source ?? 'tool' }),
    discardTask: (taskId, confirmationToken, source) => core.discardTask(taskId, confirmationToken, source ?? 'tool'),
    getUsage: () => core.getUsage(),
    history: {
      getTask: (taskId) => core.history.getTask(taskId),
      getEvents: (taskId, after) => core.history.eventsAfter(taskId, after),
      subscribe: (taskId, listener) => core.history.subscribe(taskId, listener),
    },
    isConfirmRequired: (op) => core.isConfirmRequired(op),
    policyMode: (op) => core.policyMode(op),
    requestConfirmation: (req, source) => core.requestConfirmation(req, source ?? 'tool'),
    decideConfirmation: (approvalId, approve) => core.decideConfirmation(approvalId, approve),
    listPendingConfirmations: () => core.listPendingConfirmations(),
    assertApproved: (req, token, source) => core.assertApproved(req, token, source ?? 'tool'),
    scopeKey: (op, req) => core.scopeKey(op, req),
    getAudit: (query) => core.getAudit(query),
    getRealConflicts: (taskId, agents) => core.getRealConflicts(taskId, agents),
  }
  ctx.provide('helmsman.orchestrator', service)

  registerTools(ctx, service)
  console.log(`[helmsman/orchestrator] ready (adapters register themselves via inject)`)
}

export type {
  ExecutionEvent,
  ExecutionEventKind,
  ExecutionEventPayload,
  EventsPage,
  HistoryStore,
  MergeDecisionEventPayload,
  MergeResolution,
  PruneOptions,
} from './history/types.ts'
export { JsonlHistoryStore } from './history/jsonl.ts'
export { OrchestratorCore, type ConfirmationRequest } from './core.ts'
export { JsonlAuditJournal, MemoryAuditJournal, AuditUnavailableError } from './audit/journal.ts'
export type { AuditCompletionEntry, AuditDecisionEntry, AuditEntry, AuditJournal, AuditQuery } from './audit/journal.ts'
export { ConfirmationGate, GateDeniedError } from './gate/gate.ts'
export type { AuditSource, DecideResult, PendingApproval, TokenInfo } from './gate/gate.ts'
export {
  DEFAULT_POLICY,
  DEFAULT_TOKEN_TTL_SEC,
  FilePolicy,
  allowAllPolicy,
  confirmAllPolicy,
  loadPolicyFileSync,
} from './gate/policy.ts'
export type { ConfirmationPolicy, GateOp, PolicyFile, PolicyMode } from './gate/policy.ts'

function registerTools(ctx: Context, service: OrchestratorService): void {
  ctx.tools.register(
    defineTool({
      name: 'helmsman_run_parallel',
      description: 'Fan a task out to multiple coding agents (claude/codex/pi/oh-my-pi), each in an isolated git worktree. Returns a taskId immediately; poll helmsman_task_status for progress.',
      parameters: {
        prompt: { type: 'string', required: true, description: 'The task prompt, executed by every selected agent.' },
        agents: { type: 'string', required: true, description: 'Comma-separated agent names, e.g. "claude,codex".' },
        projectGroupId: { type: 'string', description: 'Helmsman project group id (resolves repoPath + optional cascade topology context).' },
        repoPath: { type: 'string', description: 'Direct path to the base git repository (alternative to projectGroupId).' },
        cascade: { type: 'boolean', description: 'Inject dependency-topology context into the prompt (default false).' },
        timeoutSec: { type: 'integer', description: 'Per-agent timeout in seconds (default 300).' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args) {
        const agents = args.agents.split(',').map((a) => a.trim()).filter(Boolean)
        const { taskId } = await service.runParallelTask({
          prompt: args.prompt,
          agents,
          ...(args.projectGroupId !== undefined ? { projectGroupId: args.projectGroupId } : {}),
          ...(args.repoPath !== undefined ? { repoPath: args.repoPath } : {}),
          ...(args.cascade !== undefined ? { cascade: args.cascade } : {}),
          ...(args.timeoutSec !== undefined ? { timeoutSec: args.timeoutSec } : {}),
        })
        return { taskId, agents, note: 'poll helmsman_task_status with this taskId' }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'helmsman_task_status',
      description: 'Get the status of a Helmsman parallel task: per-agent states, logs, diff stats and conflicting files.',
      parameters: {
        taskId: { type: 'string', required: true },
        withLog: { type: 'boolean', description: 'Include per-agent log tail (last 4KB).' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args) {
        const task = service.getTaskStatus(args.taskId)
        if (!task) return { found: false, taskId: args.taskId }
        const agents = Object.fromEntries(
          Object.entries(task.agents).map(([name, run]) => [
            name,
            {
              state: run.state,
              attempts: run.attempts,
              exitCode: run.exitCode ?? null,
              error: run.error ?? null,
              stats: run.stats ?? null,
              conflictingFiles: run.conflictingFiles ?? [],
              log: args.withLog === true ? run.log.slice(-4096) : undefined,
            },
          ]),
        )
        return JSON.parse(JSON.stringify({
          found: true,
          taskId: task.id,
          status: task.status,
          prompt: task.prompt,
          projectGroupId: task.projectGroupId ?? null,
          cascade: task.cascade,
          timeoutSec: task.timeoutSec,
          createdAt: task.createdAt,
          endedAt: task.endedAt ?? null,
          agents,
        }))
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'helmsman_cancel_task',
      description: 'Cancel a running Helmsman parallel task (aborts all agents). Only tasks in the RUNNING state can be cancelled: a cancel for an unknown task, a task still creating worktrees, or a finished task is rejected (returns ok:false) without journaling or consuming any confirmation token — use helmsman_discard_task to clean up a stuck task. Cancel is auto-grant by default policy; pass a confirmationToken when the operator configured cancel as confirm-required (mint one via helmsman_request_confirmation + helmsman_decide_confirmation).',
      parameters: {
        taskId: { type: 'string', required: true },
        confirmationToken: { type: 'string', description: 'Confirmation token minted for cancel:<taskId> when the policy requires confirmation.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args) {
        const task = service.getTaskStatus(args.taskId)
        if (!task) return { ok: false, error: `unknown task: ${args.taskId}` }
        try {
          await service.cancelTask(args.taskId, args.confirmationToken)
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
        return JSON.parse(JSON.stringify({ ok: true, taskId: args.taskId }))
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'helmsman_merge_task',
      description: 'Merge completed agents\' changes from their worktrees back onto the base repository (optionally restricted to agents/files), or discard all worktrees. Headless merges are all-or-nothing: any real conflict aborts the whole merge (base repo untouched) and returns the conflict files for per-file adjudication via the diff UI.',
      parameters: {
        taskId: { type: 'string', required: true },
        mode: { type: 'string', description: '"merge" (default) applies patches onto the base repo; "discard" removes all worktrees of the task.' },
        agents: { type: 'string', description: 'Comma-separated agent names to merge; default = all completed agents.' },
        files: { type: 'string', description: 'Comma-separated repo-relative paths to restrict the merge to.' },
        discardAfterMerge: { type: 'boolean', description: 'Remove worktrees after merging.' },
        confirmationToken: { type: 'string', description: 'Confirmation token minted for merge:<taskId> when the policy requires confirmation (default).' },
        resolutions: {
          type: 'string',
          description: 'Optional JSON string mapping each real conflict file to a per-file adjudication: {"<file>":{"kind":"agent","agent":"claude"}} | {"kind":"manual"} | {"kind":"skip"}. Omit for a clean headless merge.',
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args) {
        if (args.mode === 'discard') {
          await service.discardTask(args.taskId, args.confirmationToken)
          return { taskId: args.taskId, discarded: true }
        }
        let resolutions: Record<string, unknown> | undefined
        if (args.resolutions !== undefined) {
          resolutions = JSON.parse(args.resolutions) as Record<string, unknown>
        }
        const result = await service.mergeTask({
          taskId: args.taskId,
          ...(args.agents !== undefined ? { agents: args.agents.split(',').map((a) => a.trim()).filter(Boolean) } : {}),
          ...(args.files !== undefined ? { files: args.files.split(',').map((f) => f.trim()).filter(Boolean) } : {}),
          ...(args.discardAfterMerge === true ? { discardAfterMerge: true } : {}),
          ...(args.confirmationToken !== undefined ? { confirmationToken: args.confirmationToken } : {}),
          ...(resolutions !== undefined ? { resolutions: resolutions as MergeTaskParams['resolutions'] } : {}),
          source: 'tool',
        })
        return JSON.parse(JSON.stringify(result))
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'helmsman_request_confirmation',
      description: 'Phase 1 of the confirmation gate: record a pending approval request for a gated operation (merge/discard/cancel/worktree-cleanup/topology-delete) scoped to a task or project group. Returns an approvalId to decide with helmsman_decide_confirmation.',
      parameters: {
        op: { type: 'string', required: true, description: 'Gated operation: merge | discard | cancel | worktree-cleanup | topology-delete.' },
        taskId: { type: 'string', description: 'Task id scope for task-scoped operations.' },
        group: { type: 'string', description: 'Project group scope for topology-delete.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args) {
        const approval = service.requestConfirmation(
          { op: String(args.op) as GateOp, ...(args.taskId !== undefined ? { taskId: String(args.taskId) } : {}), ...(args.group !== undefined ? { group: String(args.group) } : {}) },
          'tool',
        )
        return JSON.parse(JSON.stringify({
          approvalId: approval.approvalId,
          op: approval.op,
          scope: approval.scope,
          source: approval.source,
          requestedAt: approval.requestedAt,
          expiresAt: approval.expiresAt,
        }))
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'helmsman_decide_confirmation',
      description: 'Phase 2 of the confirmation gate: approve (mints a one-time scoped confirmation token with a 5-minute default TTL) or deny a pending request. Pass the returned token as confirmationToken to helmsman_merge_task / helmsman_cancel_task / helmsman_topology_delete.',
      parameters: {
        approvalId: { type: 'string', required: true },
        approve: { type: 'boolean', required: true },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args) {
        return JSON.parse(JSON.stringify(await service.decideConfirmation(args.approvalId, args.approve === true)))
      },
    }),
  )
}
