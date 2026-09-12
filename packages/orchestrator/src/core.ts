/**
 * OrchestratorCore — the scheduling engine, framework-free so it is fully
 * unit-testable. The DSH plugin entry (index.ts) wires it into cordis.
 *
 * Task lifecycle (PRD §4.2):
 *   CREATING_WORKTREES → RUNNING → AGGREGATING → COMPLETED | PARTIAL_FAILED | ALL_FAILED
 *   (CANCELLED is reachable from RUNNING via cancelTask, and from
 *   CREATING_WORKTREES/RUNNING/AGGREGATING via the discard cleanup path)
 *
 * cancelTask only applies to RUNNING tasks (agents executing): a cancel for a
 * task that is not cancellable is rejected before the gate is consulted, so a
 * stuck CREATING_WORKTREES run is stopped with discard, not a misleading
 * cancel.
 *
 * Resilience: per-agent rate-limit retry with exponential backoff (2s, 8s,
 * 32s, capped), no retry on auth failure, and a circuit breaker that stops
 * calling an agent for 30s after 5 consecutive failures.
 *
 * Governance (approval-gates / audit-trail / merge-conflict-resolution):
 *  - destructive ops (merge/discard/cancel + worktree/topology cleanup) run
 *    through a code-level two-phase gate (request → decide → execute with a
 *    one-time scoped confirmation token) that no REST/tool/internal path can
 *    bypass; policy (packages/orchestrator/src/gate) decides which ops need a
 *    token (defaults keep the historical "confirm before destructive change"
 *    behaviour, cancel is auto-grant).
 *  - every gated decision is journaled (fsync) BEFORE its side effect; a
 *    journal failure aborts the operation (fail-closed). Merge executions and
 *    terminal runs get `run-completion` audit entries.
 *  - conflicts are real patch-apply failures only (no "touched by ≥2 agents"
 *    heuristic): clean patches default-merge, genuinely conflicted files are
 *    returned to the user for per-file adjudication (`resolutions`) and are
 *    never written before adjudication. Headless merges abort wholesale on any
 *    real conflict with the base repo untouched.
 */
import { randomBytes } from 'node:crypto'
import {
  classifyFailure,
  type AgentAdapter,
  type AgentRun,
  type MergeTaskParams,
  type MergeTaskResult,
  type RunParallelParams,
  type TaskRecord,
  type TaskState,
  type TopologyLike,
  type UsageEntry,
  type WorktreeLike,
} from './types.ts'
import { InMemoryHistoryStore } from './history/in-memory.ts'
import type {
  HistoryStore,
  MergeDecisionEventPayload,
  TaskAgentStatePayload,
  TaskStateEventPayload,
} from './history/types.ts'
import { ConfirmationGate, GateDeniedError, type AuditSource, type DecideResult, type PendingApproval } from './gate/gate.ts'
import {
  allowAllPolicy,
  type ConfirmationPolicy,
  type GateOp,
  type PolicyMode,
} from './gate/policy.ts'
import {
  MemoryAuditJournal,
  type AuditCompletionEntry,
  type AuditDecisionEntry,
  type AuditEntry,
  type AuditJournal,
  type AuditQuery,
} from './audit/journal.ts'

/**
 * Structured confirmation scope used to mint / spend confirmation tokens.
 * Tokens bind to the operation + canonical task/group scope (design D1);
 * agents/files are recorded in the audit trail for traceability.
 */
export interface ConfirmationRequest {
  op: GateOp
  taskId?: string
  group?: string
}

export interface OrchestratorOptions {
  worktree: WorktreeLike
  /** Service or lazy getter — lazy avoids cordis service-startup races. */
  topology?: TopologyLike | (() => TopologyLike | undefined)
  now?: () => number
  /** setTimeout replacement for tests. */
  delay?: (ms: number) => Promise<void>
  defaultTimeoutSec?: number
  maxRateLimitAttempts?: number
  circuitBreakerThreshold?: number
  circuitBreakerCooldownMs?: number
  maxTasksKept?: number
  onTaskUpdated?: (task: TaskRecord) => void
  /**
   * Durable history backend. Defaults to an in-memory store so engine unit
   * tests never touch the filesystem; the plugin entry injects the JSONL
   * store for real hosts.
   */
  history?: HistoryStore
  /**
   * Confirmation policy (design D2). Defaults to allow-all so engine unit
   * tests keep their historical no-token behaviour; the plugin entry injects
   * the real `~/.helmsman/policy.json`-backed policy.
   */
  policy?: ConfirmationPolicy
  /**
   * Audit journal (design D3). Defaults to an in-memory journal; the plugin
   * entry injects the JSONL journal for real hosts.
   */
  journal?: AuditJournal
  /** Confirmation gate override (mostly for tests); built from `policy`. */
  gate?: ConfirmationGate
}

const RETRY_BACKOFF_MS = [2_000, 8_000, 32_000]

export class OrchestratorCore {
  private readonly adapters = new Map<string, AgentAdapter>()
  private readonly tasks = new Map<string, TaskRecord>()
  private readonly running = new Map<string, Promise<void>>()
  private readonly aborts = new Map<string, AbortController>()
  private readonly usage = new Map<string, UsageEntry>()
  /** consecutive failures per agent for the circuit breaker */
  private readonly failures = new Map<string, { count: number; openUntil: number }>()
  private readonly opts: Required<
    Omit<OrchestratorOptions, 'topology' | 'onTaskUpdated' | 'history' | 'gate'>
  > &
    Pick<OrchestratorOptions, 'topology' | 'onTaskUpdated'> & { history: HistoryStore }

  /** Code-level two-phase gate (request → decide → consume). */
  private readonly gate: ConfirmationGate
  /** Append-only audit journal (fsync-before-execute for gated decisions). */
  private readonly journal: AuditJournal
  /**
   * Last status published (notified/persisted) per task. Kept separately from
   * the live map because callers mutate the SAME task object stored in `tasks`
   * before calling `touch()` — reading the previous status from the map would
   * always see the already-mutated status and terminal transitions (and their
   * `run-completion` audit entries) would silently never fire.
   */
  private readonly publishedStatus = new Map<string, TaskState>()
  /**
   * In-flight `run-completion` journal writes of terminal transitions. Tracked
   * so a settled run (waitForTask / the durable-history flush) can also await
   * its audit record — tests and tooling observe the journal only after a run
   * has fully settled.
   */
  private readonly completionWrites = new Set<Promise<void>>()

  /**
   * Durable execution history. Always present (in-memory by default); the
   * engine persists through the `touch()`/`notify()` funnel and the adapter
   * log sink, so every mutation is captured on exactly one code path.
   */
  readonly history: HistoryStore

  constructor(opts: OrchestratorOptions) {
    this.opts = {
      now: opts.now ?? (() => Date.now()),
      delay: opts.delay ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      defaultTimeoutSec: opts.defaultTimeoutSec ?? 300,
      maxRateLimitAttempts: opts.maxRateLimitAttempts ?? 3,
      circuitBreakerThreshold: opts.circuitBreakerThreshold ?? 5,
      circuitBreakerCooldownMs: opts.circuitBreakerCooldownMs ?? 30_000,
      maxTasksKept: opts.maxTasksKept ?? 50,
      worktree: opts.worktree,
      topology: opts.topology,
      onTaskUpdated: opts.onTaskUpdated,
      policy: opts.policy ?? allowAllPolicy,
      journal: opts.journal ?? new MemoryAuditJournal(),
      history: opts.history ?? new InMemoryHistoryStore(),
    }
    this.history = this.opts.history
    this.journal = this.opts.journal
    this.gate = opts.gate ?? new ConfirmationGate({ policy: this.opts.policy })
  }

  registerAdapter(adapter: AgentAdapter): void {
    this.adapters.set(adapter.name, adapter)
  }

  listAdapters(): string[] {
    return [...this.adapters.keys()]
  }

  async checkAgents(): Promise<Record<string, { installed: boolean; version?: string }>> {
    const out: Record<string, { installed: boolean; version?: string }> = {}
    for (const [name, adapter] of this.adapters) {
      try {
        const status = await adapter.checkInstalled()
        out[name] = status
      } catch {
        out[name] = { installed: false }
      }
    }
    return out
  }

  getUsage(): Record<string, UsageEntry> {
    return Object.fromEntries(this.usage)
  }

  getTaskStatus(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId)
  }

  listTasks(): TaskRecord[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  private notify(task: TaskRecord): void {
    this.opts.onTaskUpdated?.(task)
  }

  /**
   * Single mutation funnel: keep the in-memory map, persist the lifecycle
   * snapshot + a `task-state` event (design D2 — the durable write is enqueued
   * BEFORE the live publish so resyncing subscribers can never miss it), then
   * notify live consumers. A transition INTO a terminal state also emits a
   * governance `run-completion` audit entry (spec audit-trail).
   *
   * The previous status is tracked by `publishedStatus` — never the live map,
   * since callers mutate the shared task object before touching (reading prev
   * from the map would always equal the new status).
   */
  private touch(task: TaskRecord): void {
    const prev = this.publishedStatus.get(task.id)
    this.tasks.set(task.id, task)
    this.persistStateChange(task)
    if (prev !== undefined && prev !== task.status && TERMINAL_TASK_STATES.has(task.status)) {
      this.auditRunCompletion(task)
    }
    this.publishedStatus.set(task.id, task.status)
    this.notify(task)
  }

  private auditRunCompletion(task: TaskRecord): void {
    const agents = Object.values(task.agents)
      .filter((r) => r.state === 'completed' || r.state === 'cancelled')
      .map((r) => r.agent)
    const entry: AuditCompletionEntry = {
      v: 1,
      ts: this.opts.now(),
      type: 'run-completion',
      operation: 'run',
      scope: `run:task:${task.id}`,
      taskId: task.id,
      outcome: completionOutcomeFor(task.status),
      detail: {
        status: task.status,
        agents,
        interrupted: task.interrupted === true,
      },
    }
    const write = this.journal.recordCompletion(entry).catch(reportAuditError)
    this.completionWrites.add(write)
    void write.finally(() => this.completionWrites.delete(write))
  }

  // -------------------------------------------------------------------------
  // Approval gate + audit journal surface (design D1/D3/D4)
  // -------------------------------------------------------------------------

  /** Mode an operation is currently governed by (used by UI to decide whether
   * to run the two-phase request→decide flow before a destructive action). */
  isConfirmRequired(op: GateOp): boolean {
    return this.opts.policy.modeFor(op) === 'confirm-required'
  }

  /** Policy mode of an operation (exposed for tooling/UI messaging). */
  policyMode(op: GateOp): PolicyMode {
    return this.opts.policy.modeFor(op)
  }

  /** Canonical scope key for a confirmation request (op + normalized ids). */
  scopeKey(op: GateOp, req: ConfirmationRequest): string {
    const parts: string[] = []
    if (req.taskId) parts.push(`task:${req.taskId}`)
    if (req.group) parts.push(`group:${req.group}`)
    return `${op}:${parts.join(' ') || 'any'}`
  }

  /** Phase 1 of the gate: record a pending confirmation request. */
  requestConfirmation(req: ConfirmationRequest, source: AuditSource = 'ui'): PendingApproval {
    return this.gate.request(req.op, this.scopeKey(req.op, req), source, req.taskId)
  }

  /**
   * Phase 2: approve (mint a one-time token) or deny a pending request. The
   * human decision itself is a gated decision — it is journaled (fsync for
   * real hosts) BEFORE returning, so an operator denial — and a grant that is
   * never executed — both leave audit records (finding A). A journal write
   * failure aborts the decision (fail-closed): the caller learns the decision
   * was not durably recorded and must not treat it as made.
   */
  async decideConfirmation(approvalId: string, approve: boolean): Promise<DecideResult> {
    const result = this.gate.decide(approvalId, approve)
    if (result.granted) {
      await this.recordDecideStage(result.op, result.scope, result.source, approvalId, result.taskId, 'granted', undefined)
      return result
    }
    if (result.reason === 'denied') {
      await this.recordDecideStage(result.op, result.scope, result.source, approvalId, result.taskId, 'denied', 'operator-denied')
      return result
    }
    // not-found: nothing was pending to decide → nothing to journal.
    return result
  }

  /** One `decision` journal entry for a human approve/deny (stage 'decide'). */
  private async recordDecideStage(
    op: GateOp,
    scope: string,
    source: AuditSource,
    approvalId: string,
    taskId: string | undefined,
    decision: 'granted' | 'denied',
    reason: string | undefined,
  ): Promise<void> {
    await this.journal.recordDecision({
      v: 1,
      ts: this.opts.now(),
      type: 'decision',
      operation: op,
      scope,
      source,
      ...(taskId !== undefined ? { taskId } : {}),
      decision,
      ...(reason !== undefined ? { reason } : {}),
      stage: 'decide',
      approvalId,
    })
  }

  /** Live pending confirmations (newest first, expired dropped). */
  listPendingConfirmations(): PendingApproval[] {
    return this.gate.listPending()
  }

  /** Read-only audit query (no mutation surface exists). */
  getAudit(query?: AuditQuery): Promise<AuditEntry[]> {
    return this.journal.query(query)
  }

  /**
   * Single enforcement point for gated operations: consults the policy and —
   * when the op is `confirm-required` — consumes the caller's one-time
   * confirmation token bound to the canonical scope. Records the decision
   * (fsync for real hosts) BEFORE returning; a journal write failure aborts the
   * operation (fail-closed). Callers MUST invoke this immediately before the
   * protected side effect.
   */
  private async authorize(op: GateOp, req: ConfirmationRequest, token: string | undefined, source: AuditSource): Promise<void> {
    const scope = this.scopeKey(op, req)
    const base: Omit<AuditDecisionEntry, 'decision'> = {
      v: 1,
      ts: this.opts.now(),
      type: 'decision',
      operation: op,
      scope,
      source,
      stage: 'enforce',
      ...(req.taskId ? { taskId: req.taskId } : {}),
    }
    const mode = this.opts.policy.modeFor(op)
    if (mode === 'auto-grant') {
      await this.journal.recordDecision({ ...base, decision: 'auto-grant' })
      return
    }
    if (!token) {
      await this.journal.recordDecision({ ...base, decision: 'denied', reason: 'missing-token' })
      throw new GateDeniedError(op, scope, 'missing-token')
    }
    let info: Awaited<ReturnType<ConfirmationGate['consume']>>
    try {
      info = this.gate.consume(op, scope, token)
    } catch (err) {
      if (err instanceof GateDeniedError) {
        // A refused attempt is itself a gated decision — journal then rethrow.
        await this.journal.recordDecision({ ...base, decision: 'denied', reason: err.reason }).catch(reportAuditError)
      }
      throw err
    }
    await this.journal.recordDecision({ ...base, decision: 'granted', source: info.source })
  }

  /**
   * Public single enforcement point for gated ops that execute outside the
   * engine (e.g. topology-group deletion orchestrated by the dashboard API,
   * design D4). Records the decision and consumes the token when required.
   */
  assertApproved(req: ConfirmationRequest, confirmationToken: string | undefined, source: AuditSource): Promise<void> {
    return this.authorize(req.op, req, confirmationToken, source)
  }

  private persistStateChange(task: TaskRecord): void {
    const ts = this.opts.now()
    // Fire-and-forget: persistence must never stall the engine. Errors are
    // reported and the next write still proceeds (the store serializes them).
    this.history.upsertTask(toStoredTask(task)).catch(reportHistoryError)
    this.history.append({ ts, taskId: task.id, kind: 'task-state', payload: summarizeTaskEvent(task) }).catch(reportHistoryError)
  }

  /**
   * Re-import last-known task records after a host restart. Tasks that never
   * reached a terminal state are marked `interrupted` (last-known state, not
   * actually running). No events are emitted — restoring is an observation,
   * not an execution.
   */
  restoreTasks(tasks: TaskRecord[]): void {
    for (const task of tasks) {
      if (!TERMINAL_TASK_STATES.has(task.status)) task.interrupted = true
      this.tasks.set(task.id, task)
      this.publishedStatus.set(task.id, task.status)
    }
  }

  /** Persist one chunk of an agent's output as an `agent-log` timeline event. */
  private appendAgentLog(taskId: string, agent: string, text: string): void {
    if (text.length === 0) return
    this.history.append({ ts: this.opts.now(), taskId, agent, kind: 'agent-log', payload: { text } }).catch(reportHistoryError)
  }

  async runParallelTask(params: RunParallelParams): Promise<{ taskId: string }> {
    if (!params.prompt?.trim()) throw new Error('prompt must not be empty')
    const agents = [...new Set(params.agents)]
    if (agents.length === 0) throw new Error('no agent selected')
    for (const agent of agents) {
      if (!this.adapters.has(agent)) throw new Error(`no adapter registered for agent "${agent}"`)
    }

    let repoPath = params.repoPath
    let prompt = params.prompt
    if (params.projectGroupId && this.topo()) {
      const topology = await this.topo()!.loadTopology(params.projectGroupId).catch(() => null)
      if (params.cascade && topology) {
        prompt = `${params.prompt}\n\n---\n项目拓扑上下文（cascade 模式自动注入）：\n${describeTopology(topology)}`
      }
      if (!repoPath && topology) {
        repoPath = Object.values(topology.services).map((s) => s.localPath).find((p): p is string => typeof p === 'string' && p.length > 0)
      }
    }
    if (!repoPath) throw new Error('no repoPath: provide params.repoPath or configure services with localPath in the project group topology')

    const taskId = `t-${this.opts.now().toString(36)}-${randomBytes(3).toString('hex')}`
    const task: TaskRecord = {
      id: taskId,
      prompt,
      ...(params.projectGroupId ? { projectGroupId: params.projectGroupId } : {}),
      cascade: params.cascade === true,
      timeoutSec: params.timeoutSec ?? this.opts.defaultTimeoutSec,
      status: 'CREATING_WORKTREES',
      createdAt: this.opts.now(),
      repoPath,
      agents: Object.fromEntries(
        agents.map((agent) => [agent, { agent, state: 'idle' as const, attempts: 0, log: '' }]),
      ),
    }
    this.tasks.set(taskId, task)
    while (this.tasks.size > this.opts.maxTasksKept) {
      const oldest = [...this.tasks.values()].sort((a, b) => a.createdAt - b.createdAt)[0]
      if (!oldest || oldest.id === taskId) break
      this.tasks.delete(oldest.id)
      this.publishedStatus.delete(oldest.id)
    }

    // Fire in background — callers poll getTaskStatus / subscribe to events.
    // waitForTask() lets tests and tools await full settlement.
    const execution = this.executeTask(task).catch((err) => {
      task.status = 'ALL_FAILED'
      task.endedAt = this.opts.now()
      for (const run of Object.values(task.agents)) {
        if (run.state === 'running' || run.state === 'idle') {
          run.state = 'failed'
          run.error = err instanceof Error ? err.message : String(err)
        }
      }
      this.touch(task)
    })
    // "Settled" includes the durable history flush AND any terminal-transition
    // audit writes, so once waitForTask() or a subscriber observes the terminal
    // state, every event is on disk and every governance record is journaled.
    const settled = execution.finally(async () => {
      await this.history.flush()
      await Promise.allSettled([...this.completionWrites])
    })
    this.running.set(taskId, settled)
    void settled.finally(() => this.running.delete(taskId))
    this.touch(task)
    return { taskId }
  }

  /** Resolves when the task's background execution settles (tests/tools). */
  async waitForTask(taskId: string): Promise<void> {
    await this.running.get(taskId)
  }

  private async executeTask(task: TaskRecord): Promise<void> {
    // A restored (interrupted) record that is being run again is live now.
    if (task.interrupted) task.interrupted = false
    // Phase 1: worktrees
    for (const [agent, run] of Object.entries(task.agents)) {
      if (run.state === 'completed') continue // retry path
      try {
        const record = await this.opts.worktree.createWorktree({ taskId: task.id, agent, repoPath: task.repoPath! })
        run.worktreeId = record.id
        run.state = 'idle'
      } catch (err) {
        run.state = 'failed'
        run.error = `创建 worktree 失败: ${err instanceof Error ? err.message : String(err)}`
      }
    }
    this.touch(task)

    const runnable = Object.values(task.agents).filter((r) => r.worktreeId)
    if (runnable.length === 0) {
      task.status = 'ALL_FAILED'
      task.endedAt = this.opts.now()
      this.touch(task)
      return
    }

    // Phase 2: run agents in parallel
    task.status = 'RUNNING'
    this.touch(task)
    const controller = new AbortController()
    this.aborts.set(task.id, controller)
    await Promise.all(runnable.map((run) => this.runAgent(task, run, controller.signal)))
    this.aborts.delete(task.id)

    const cancelled = Object.values(task.agents).some((r) => r.state === 'cancelled')
    if (cancelled) {
      task.status = 'CANCELLED'
      task.endedAt = task.endedAt ?? this.opts.now()
      this.touch(task)
      return
    }

    // Phase 3: aggregate
    task.status = 'AGGREGATING'
    this.touch(task)
    await this.aggregate(task)
  }

  private topo(): TopologyLike | undefined {
    return typeof this.opts.topology === 'function' ? this.opts.topology() : this.opts.topology
  }

  private async runAgent(task: TaskRecord, run: AgentRun, signal: AbortSignal): Promise<void> {
    const adapter = this.adapters.get(run.agent)!

    const breaker = this.failures.get(run.agent)
    if (breaker && breaker.openUntil > this.opts.now()) {
      run.state = 'failed'
      run.error = `断路器打开：连续失败 ${breaker.count} 次，${Math.ceil((breaker.openUntil - this.opts.now()) / 1000)}s 后可重试`
      return
    }

    for (;;) {
      run.attempts += 1
      run.state = 'running'
      run.startedAt = this.opts.now()
      run.endedAt = undefined
      run.log = ''
      run.exitCode = undefined
      this.touch(task)

      const worktrees = await this.opts.worktree.listWorktrees(task.id)
      const record = worktrees.find((w) => w.id === run.worktreeId)
      if (!record) {
        run.state = 'failed'
        run.error = 'worktree 丢失，无法执行'
        return
      }

      const agentAbort = new AbortController()
      const onAbort = (): void => agentAbort.abort()
      signal.addEventListener('abort', onAbort, { once: true })
      let result: Awaited<ReturnType<AgentAdapter['execute']>>
      try {
        result = await adapter.execute({
          prompt: task.prompt,
          worktreePath: record.path,
          timeoutSec: task.timeoutSec,
          signal: agentAbort.signal,
          onOutput: (chunk) => {
            run.log += chunk
            if (run.log.length > 512 * 1024) run.log = run.log.slice(-256 * 1024)
            this.appendAgentLog(task.id, run.agent, chunk)
          },
        })
      } catch (err) {
        result = { exitCode: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err), timedOut: false }
      } finally {
        signal.removeEventListener('abort', onAbort)
      }

      run.endedAt = this.opts.now()
      run.exitCode = result.exitCode
      this.trackUsage(run.agent, task.prompt, result.stdout + result.stderr)

      if (signal.aborted && !result.timedOut) {
        run.state = 'cancelled'
        run.error = '用户取消'
        return
      }

      if (result.exitCode === 0 && !result.timedOut) {
        run.state = 'completed'
        this.failures.delete(run.agent)
        return
      }

      const classified = classifyFailure(result)
      run.state = classified.state
      run.error = classified.error

      if (classified.state === 'rate-limited' && run.attempts <= this.opts.maxRateLimitAttempts) {
        const backoff = RETRY_BACKOFF_MS[Math.min(run.attempts - 1, RETRY_BACKOFF_MS.length - 1)]!
        this.touch(task)
        await this.opts.delay(backoff)
        if (signal.aborted) {
          run.state = 'cancelled'
          run.error = '用户取消（限流重试等待中）'
          return
        }
        continue
      }

      if (classified.state !== 'timeout') this.recordFailure(run.agent)
      return
    }
  }

  private recordFailure(agent: string): void {
    const current = this.failures.get(agent) ?? { count: 0, openUntil: 0 }
    current.count += 1
    if (current.count >= this.opts.circuitBreakerThreshold) {
      current.openUntil = this.opts.now() + this.opts.circuitBreakerCooldownMs
      current.count = 0 // reset the streak once the breaker opens
    }
    this.failures.set(agent, current)
  }

  private trackUsage(agent: string, prompt: string, output: string): void {
    const entry = this.usage.get(agent) ?? { runs: 0, promptChars: 0, outputChars: 0, estimatedTokens: 0 }
    entry.runs += 1
    entry.promptChars += prompt.length
    entry.outputChars += output.length
    entry.estimatedTokens = Math.ceil((entry.promptChars + entry.outputChars) / 4)
    this.usage.set(agent, entry)
  }

  /**
   * Read-only real-conflict query for a task (design D5): dry-runs the combined
   * patch of the given (default: all completed) agents against the base repo
   * and returns files whose patch does not apply cleanly. Never modifies the
   * base repo and never goes through the gate (observation, not an action).
   */
  async getRealConflicts(taskId: string, agents?: string[]): Promise<string[]> {
    const task = this.tasks.get(taskId)
    if (!task) return []
    this.assertMergeDryRunAvailable()
    const targets = agents && agents.length > 0
      ? agents
      : Object.values(task.agents).filter((r) => r.state === 'completed').map((r) => r.agent)
    const worktrees: Array<{ worktreeId: string; files: string[] }> = []
    for (const agent of targets) {
      const run = task.agents[agent]
      if (!run?.worktreeId || !run.diffs) continue
      const files = run.diffs.map((d) => d.path)
      if (files.length > 0) worktrees.push({ worktreeId: run.worktreeId, files })
    }
    if (worktrees.length === 0) return []
    const check = await this.opts.worktree.mergeDryRun({ worktrees })
    return check.ok ? [] : check.conflictFiles
  }

  /**
   * Conflict detection needs the atomic `mergeDryRun` seam on the configured
   * worktree host. When it is absent (a legacy fake or custom host), fail
   * loudly instead of silently degrading to per-agent non-atomic applies.
   */
  private assertMergeDryRunAvailable(): void {
    if (!this.opts.worktree.mergeDryRun) {
      throw new Error(
        'conflict-aware merge requires the worktree host to implement mergeDryRun (atomic dry-run `git apply --check`); the configured worktree lacks it — supply WorktreeLike.mergeDryRun to enable conflict detection and atomic merges',
      )
    }
  }

  /**
   * Cancel a RUNNING task (op `cancel`). Auto-grant by default policy; still
   * journaled. When an operator configures `cancel` as confirm-required the
   * caller must pass a matching confirmation token.
   *
   * Reject-early semantics (finding E): a task that is NOT cancellable (unknown,
   * still creating worktrees, aggregating, or already terminal) rejects BEFORE
   * the gate is consulted or a token is consumed — no misleading cancel
   * decision/completion is journaled. Use discard to clean up a stuck task.
   */
  async cancelTask(taskId: string, confirmationToken?: string, source: AuditSource = 'ui'): Promise<void> {
    const task = this.tasks.get(taskId)
    if (!task) throw new Error(`unknown task: ${taskId}`)
    if (!CANCELLABLE_TASK_STATES.has(task.status)) {
      throw new Error(
        `task ${taskId} is not cancellable in its current state (${task.status}); cancel only applies to RUNNING tasks — use discard to clean up a stuck, not-yet-running, or finished task`,
      )
    }
    // Look up the abort controller BEFORE authorizing/journaling: a task that
    // settled (or never registered a controller) rejects without consuming a
    // token or leaving a misleading decision record.
    const controller = this.aborts.get(taskId)
    if (!controller) {
      throw new Error(`task ${taskId} is not cancellable: it is no longer executing`)
    }
    await this.authorize('cancel', { op: 'cancel', taskId }, confirmationToken, source)
    controller.abort()
  }

  private async aggregate(task: TaskRecord): Promise<void> {
    for (const run of Object.values(task.agents)) {
      if (run.state !== 'completed') continue
      try {
        const diff = await this.opts.worktree.getDiff(run.worktreeId!)
        run.diffs = diff.files
        run.stats = { files: diff.files.length, additions: diff.additions, deletions: diff.deletions }
      } catch (err) {
        run.state = 'failed'
        run.error = `收集 diff 失败: ${err instanceof Error ? err.message : String(err)}`
      }
    }
    // No conflict marking here (design D5): conflicts are determined by actual
    // patch-apply failure during merge, never by a "file touched by ≥2 agents"
    // heuristic. Per-agent diffs are displayed as-is; merge reports real
    // conflicts and surfaces them for per-file adjudication.
    const states = Object.values(task.agents).map((r) => r.state)
    const completed = states.filter((s) => s === 'completed').length
    task.status = completed === states.length && states.length > 0 ? 'COMPLETED' : completed === 0 ? 'ALL_FAILED' : 'PARTIAL_FAILED'
    task.endedAt = this.opts.now()
    this.touch(task)
  }

  /**
   * Merge completed agents' changes back onto the base repo (op `merge`).
   *
   * Conflict semantics (spec merge-conflict-resolution): the candidate patch
   * set is dry-run against the base repo first (`git apply --check` through the
   * worktree plugin). When it does NOT apply cleanly the merge aborts wholesale
   * with the real conflict file list and the base repo untouched — unless the
   * caller supplies a `resolutions` payload adjudicating each conflicted file
   * (adopt one agent's plan / manual-edit-keep / skip). Only files that apply
   * cleanly (including disjoint multi-agent edits to the same file) are merged.
   * The user's resolution payload is persisted to the run timeline
   * (`merge-decision` event) and the audit journal.
   */
  async mergeTask(params: MergeTaskParams): Promise<MergeTaskResult> {
    const task = this.tasks.get(params.taskId)
    if (!task) throw new Error(`unknown task: ${params.taskId}`)
    const source = params.source ?? 'ui'
    await this.authorize('merge', { op: 'merge', taskId: task.id }, params.confirmationToken, source)

    const targets = params.agents && params.agents.length > 0
      ? params.agents
      : Object.values(task.agents).filter((r) => r.state === 'completed').map((r) => r.agent)

    // Candidate (agent → repo-relative files) matrix from the collected diffs.
    const candidate = new Map<string, string[]>()
    for (const agent of targets) {
      const run = task.agents[agent]
      if (!run?.worktreeId) continue
      const changed = (run.diffs ?? []).map((d) => d.path)
      candidate.set(agent, params.files ? changed.filter((f) => params.files!.includes(f)) : [...changed])
    }
    const dryWorktrees = (matrix: Map<string, string[]>): Array<{ worktreeId: string; files: string[] }> =>
      [...matrix.entries()]
        .filter(([, files]) => files.length > 0)
        .map(([agent, files]) => ({ worktreeId: task.agents[agent]!.worktreeId!, files }))

    // Apply the user's per-file adjudication to the candidate matrix: `skip` /
    // `manual` drop the file from every agent's patch; `agent` keeps only that
    // agent's version of the file.
    const effective = new Map(candidate)
    const removeFromAll = (file: string): void => {
      for (const agent of [...effective.keys()]) {
        effective.set(agent, (effective.get(agent) ?? []).filter((f) => f !== file))
      }
    }
    const keepOnly = (file: string, keep: string): void => {
      for (const agent of [...effective.keys()]) {
        const current = effective.get(agent) ?? []
        effective.set(agent, keep === agent ? current : current.filter((f) => f !== file))
      }
    }
    const resolutions = params.resolutions ?? {}
    for (const [file, resolution] of Object.entries(resolutions)) {
      if (![...candidate.keys()].some((agent) => (candidate.get(agent) ?? []).includes(file))) continue
      if (resolution.kind === 'skip' || resolution.kind === 'manual') removeFromAll(file)
      else keepOnly(file, resolution.agent)
    }

    const results: MergeTaskResult['results'] = []
    const abortRows = (message: string, conflictFiles: string[]): void => {
      for (const agent of targets) {
        results.push({ agent, ok: false, committed: false, message, conflictFiles: [...conflictFiles] })
      }
    }

    // Dry-run the effective patch set: real conflicts = apply failures. Any
    // candidate patch requires the host's atomic dry-run seam — silently
    // proceeding with per-agent partial applies is a non-atomic degrade, so
    // fail loudly when it is absent (finding D).
    let conflictFiles: string[] = []
    const candidates = dryWorktrees(effective)
    if (candidates.length > 0) {
      this.assertMergeDryRunAvailable()
      const check = await this.opts.worktree.mergeDryRun({ worktrees: candidates })
      conflictFiles = check.ok ? [] : check.conflictFiles
    }

    const record = async (outcome: 'merged' | 'aborted', withConflicts: string[]): Promise<void> => {
      const payload: MergeDecisionEventPayload = {
        agents: targets,
        ...(params.files ? { files: params.files } : {}),
        resolutions,
        conflictFiles: withConflicts,
        discardAfterMerge: params.discardAfterMerge === true,
        outcome,
        results: results.map((r) => ({ agent: r.agent, ok: r.ok, committed: r.committed, message: r.message, conflictFiles: r.conflictFiles })),
      }
      await this.history.append({ ts: this.opts.now(), taskId: task.id, kind: 'merge-decision', payload }).catch(reportHistoryError)
      const entry: AuditCompletionEntry = {
        v: 1,
        ts: this.opts.now(),
        type: 'run-completion',
        operation: 'merge',
        scope: this.scopeKey('merge', { op: 'merge', taskId: task.id }),
        source,
        taskId: task.id,
        outcome: outcome === 'aborted' ? 'aborted' : 'completed',
        detail: {
          agents: targets,
          ...(params.files ? { files: params.files } : {}),
          resolutions,
          conflictFiles: withConflicts,
          discardAfterMerge: params.discardAfterMerge === true,
          results: results.map((r) => ({ agent: r.agent, ok: r.ok, committed: r.committed, message: r.message, conflictFiles: r.conflictFiles })),
        },
      }
      await this.journal.recordCompletion(entry)
    }

    if (conflictFiles.length > 0 && Object.keys(resolutions).length === 0) {
      // Headless / not-yet-adjudicated merge hits a real conflict: abort
      // wholesale, no silent single-side pick, base repo untouched.
      abortRows(
        `merge aborted: real conflicts on ${conflictFiles.join(', ')}; base repo untouched — adjudicate per file (adopt agent plan / manual-edit-keep / skip) and retry with resolutions`,
        conflictFiles,
      )
      await record('aborted', conflictFiles)
      return { taskId: task.id, results }
    }
    if (conflictFiles.length > 0) {
      // Adjudicated but still conflicting after the resolutions are applied.
      abortRows(
        `merge aborted: resolutions did not clear conflicts on ${conflictFiles.join(', ')}; base repo untouched`,
        conflictFiles,
      )
      await record('aborted', conflictFiles)
      return { taskId: task.id, results }
    }

    // Clean (or fully adjudicated): apply per agent, in the same patch order
    // the dry-run validated, so each `git apply` lands cleanly.
    for (const agent of targets) {
      const run = task.agents[agent]
      const files = effective.get(agent) ?? []
      if (!run?.worktreeId) {
        results.push({ agent, ok: false, committed: false, message: 'agent has no worktree', conflictFiles: [] })
        continue
      }
      if (files.length === 0) {
        results.push({ agent, ok: true, committed: false, message: 'no changes to merge', conflictFiles: [] })
        continue
      }
      try {
        const r = await this.opts.worktree.mergeWorktree({
          worktreeId: run.worktreeId,
          files,
          commitMessage: `helmsman: merge ${agent} for task ${task.id}`,
        })
        results.push({ agent, ...r })
      } catch (err) {
        results.push({ agent, ok: false, committed: false, message: err instanceof Error ? err.message : String(err), conflictFiles: [] })
      }
    }

    await record('merged', [])
    if (params.discardAfterMerge) {
      // Worktree cleanup is part of the merge decision (authorized above under
      // the merge scope) — never a second, separately gated discard.
      await this.cleanupTaskWorktrees(task.id)
    }
    return { taskId: task.id, results }
  }

  /**
   * Discard a task (op `discard`): abort any running agents and remove the
   * task's worktrees. `worktree-cleanup`/`topology-delete` stay separate policy
   * keys so operators can relax them independently; the engine's internal
   * cleanup during discard-after-merge runs under the merge authorization.
   */
  async discardTask(taskId: string, confirmationToken?: string, source: AuditSource = 'ui'): Promise<void> {
    await this.authorize('discard', { op: 'discard', taskId }, confirmationToken, source)
    await this.cleanupTaskWorktrees(taskId)
  }

  /** Ungated internal cleanup used by discard/discard-after-merge paths. */
  private async cleanupTaskWorktrees(taskId: string): Promise<void> {
    this.aborts.get(taskId)?.abort()
    await this.opts.worktree.removeTaskWorktrees(taskId)
    const task = this.tasks.get(taskId)
    if (task && ['RUNNING', 'CREATING_WORKTREES', 'AGGREGATING'].includes(task.status)) {
      task.status = 'CANCELLED'
      task.interrupted = false
      task.endedAt = this.opts.now()
      this.touch(task)
    }
  }

  /** Retry failed/timeout agents of an existing task (fresh worktrees). */
  async retryTask(taskId: string, agents?: string[]): Promise<{ taskId: string }> {
    const task = this.tasks.get(taskId)
    if (!task) throw new Error(`unknown task: ${taskId}`)
    const targets = agents ?? Object.values(task.agents).filter((r) => ['failed', 'timeout', 'cancelled'].includes(r.state)).map((r) => r.agent)
    if (targets.length === 0) throw new Error('nothing to retry')
    for (const agent of targets) {
      const run = task.agents[agent]
      if (!run) continue
      if (run.worktreeId) {
        await this.opts.worktree.removeWorktree(run.worktreeId).catch(() => undefined)
        run.worktreeId = undefined
      }
      run.state = 'idle'
      run.error = undefined
      run.attempts = 0
      run.log = ''
      run.diffs = undefined
      run.stats = undefined
      run.conflictingFiles = undefined
    }
    task.status = 'CREATING_WORKTREES'
    task.endedAt = undefined
    this.touch(task)
    const retried = this.executeTask(task).catch((err) => {
      task.status = 'ALL_FAILED'
      task.endedAt = this.opts.now()
      for (const agent of targets) {
        const run = task.agents[agent]
        if (run && run.state === 'running') {
          run.state = 'failed'
          run.error = err instanceof Error ? err.message : String(err)
        }
      }
      this.touch(task)
    })
    void retried.finally(async () => {
      await this.history.flush()
      await Promise.allSettled([...this.completionWrites])
    })
    return { taskId }
  }
}

/** Task states that mean "nothing else will happen unless the user retries". */
const TERMINAL_TASK_STATES = new Set(['COMPLETED', 'PARTIAL_FAILED', 'ALL_FAILED', 'CANCELLED'])

/**
 * States from which cancelTask can still abort a live run. Agents are only
 * executing (and an abort controller only registered) while RUNNING — the
 * worktree-creation window, aggregation and terminal states are handled by
 * discard / no-op respectively (finding E).
 */
const CANCELLABLE_TASK_STATES: ReadonlySet<TaskState> = new Set(['RUNNING'])

/**
 * Audit outcome of a run reaching a terminal state (finding B): COMPLETED →
 * `completed`, CANCELLED → `cancelled`, PARTIAL_FAILED / ALL_FAILED →
 * `failed`. The precise terminal state is also kept in `detail.status`.
 * Non-terminal states are unreachable here (auditRunCompletion only fires on a
 * terminal transition) and fall back to `completed` defensively.
 */
function completionOutcomeFor(status: TaskState): AuditCompletionEntry['outcome'] {
  switch (status) {
    case 'CANCELLED':
      return 'cancelled'
    case 'PARTIAL_FAILED':
    case 'ALL_FAILED':
      return 'failed'
    case 'COMPLETED':
    default:
      return 'completed'
  }
}

/** Persistence must never crash the engine; report and keep going. */
function reportHistoryError(err: unknown): void {
  console.error(`[helmsman/history] persist failed: ${err instanceof Error ? err.message : String(err)}`)
}

/** How much of each agent's in-memory log the snapshot carries (full output
 * is preserved in `agent-log` timeline events). */
const STORED_LOG_TAIL = 4096

/**
 * Serializable lifecycle snapshot stored in history/tasks.json. Full
 * `TaskRecord` shape minus the bulky in-memory log (kept as a short tail; the
 * durable `agent-log` timeline events hold the full output).
 */
function toStoredTask(task: TaskRecord): TaskRecord {
  const agents: TaskRecord['agents'] = {}
  for (const [name, run] of Object.entries(task.agents)) {
    agents[name] = { ...run, log: run.log.slice(-STORED_LOG_TAIL) }
  }
  return { ...task, agents }
}

function summarizeAgentState(run: AgentRun): TaskAgentStatePayload {
  return {
    agent: run.agent,
    state: run.state,
    attempts: run.attempts,
    ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
    ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
    ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
    ...(run.error !== undefined ? { error: run.error } : {}),
    ...(run.stats !== undefined ? { stats: run.stats } : {}),
    ...(run.conflictingFiles !== undefined ? { conflictingFiles: run.conflictingFiles } : {}),
    hasDiff: (run.diffs?.length ?? 0) > 0,
  }
}

/** Task-level summary carried by each `task-state` event (no logs, no diffs). */
function summarizeTaskEvent(task: TaskRecord): TaskStateEventPayload {
  const agents: Record<string, TaskAgentStatePayload> = {}
  for (const [name, run] of Object.entries(task.agents)) {
    agents[name] = summarizeAgentState(run)
  }
  return {
    id: task.id,
    prompt: task.prompt,
    status: task.status,
    cascade: task.cascade,
    timeoutSec: task.timeoutSec,
    createdAt: task.createdAt,
    ...(task.projectGroupId !== undefined ? { projectGroupId: task.projectGroupId } : {}),
    ...(task.endedAt !== undefined ? { endedAt: task.endedAt } : {}),
    ...(task.interrupted === true ? { interrupted: true } : {}),
    agents,
  }
}

function describeTopology(t: NonNullable<Awaited<ReturnType<TopologyLike['loadTopology']>>>): string {
  const lines: string[] = []
  for (const [id, svc] of Object.entries(t.services)) {
    lines.push(`- ${id} (${svc.name})`)
  }
  for (const [from, edges] of Object.entries(t.restDependencies)) {
    for (const e of edges) {
      // A service-level edge (no endpoint detail) degrades to `- A --▶ B`
      // instead of leaving a dangling `--*--> ` fragment with trailing space;
      // edges carrying details keep the historical `--METHOD--> path` form.
      lines.push(
        e.endpoints.length === 0
          ? `- ${from} --▶ ${e.toServiceId}`
          : `- ${from} --${e.method}--> ${e.toServiceId} ${e.endpoints.join(', ')}`,
      )
    }
  }
  return lines.join('\n')
}

/** Audit writes after a side effect must never crash the engine. */
function reportAuditError(err: unknown): void {
  console.error(`[helmsman/audit] journal write failed: ${err instanceof Error ? err.message : String(err)}`)
}
