/**
 * OrchestratorCore — the scheduling engine, framework-free so it is fully
 * unit-testable. The DSH plugin entry (index.ts) wires it into cordis.
 *
 * Task lifecycle (PRD §4.2):
 *   CREATING_WORKTREES → RUNNING → AGGREGATING → COMPLETED | PARTIAL_FAILED | ALL_FAILED
 *   (CANCELLED is reachable from RUNNING/CREATING_WORKTREES via cancelTask)
 *
 * Resilience: per-agent rate-limit retry with exponential backoff (2s, 8s,
 * 32s, capped), no retry on auth failure, and a circuit breaker that stops
 * calling an agent for 30s after 5 consecutive failures.
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
  type TopologyLike,
  type UsageEntry,
  type WorktreeLike,
} from './types.ts'

export interface OrchestratorOptions {
  worktree: WorktreeLike
  topology?: TopologyLike
  now?: () => number
  /** setTimeout replacement for tests. */
  delay?: (ms: number) => Promise<void>
  defaultTimeoutSec?: number
  maxRateLimitAttempts?: number
  circuitBreakerThreshold?: number
  circuitBreakerCooldownMs?: number
  maxTasksKept?: number
  onTaskUpdated?: (task: TaskRecord) => void
}

const RETRY_BACKOFF_MS = [2_000, 8_000, 32_000]

export class OrchestratorCore {
  private readonly adapters = new Map<string, AgentAdapter>()
  private readonly tasks = new Map<string, TaskRecord>()
  private readonly aborts = new Map<string, AbortController>()
  private readonly usage = new Map<string, UsageEntry>()
  /** consecutive failures per agent for the circuit breaker */
  private readonly failures = new Map<string, { count: number; openUntil: number }>()
  private readonly opts: Required<Omit<OrchestratorOptions, 'topology' | 'onTaskUpdated'>> & Pick<OrchestratorOptions, 'topology' | 'onTaskUpdated'>

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
    }
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

  private touch(task: TaskRecord): void {
    this.tasks.set(task.id, task)
    this.notify(task)
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
    if (params.projectGroupId && this.opts.topology) {
      const topology = await this.opts.topology.loadTopology(params.projectGroupId).catch(() => null)
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
      prompt: params.prompt,
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
    }

    // Fire in background — callers poll getTaskStatus / subscribe to events.
    void this.executeTask(task).catch((err) => {
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
    this.touch(task)
    return { taskId }
  }

  private async executeTask(task: TaskRecord): Promise<void> {
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

    if (task.status === 'CANCELLED') {
      task.endedAt = task.endedAt ?? this.opts.now()
      this.touch(task)
      return
    }

    // Phase 3: aggregate
    task.status = 'AGGREGATING'
    this.touch(task)
    await this.aggregate(task)
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

  cancelTask(taskId: string): void {
    this.aborts.get(taskId)?.abort()
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
    markConflicts(task, Object.values(task.agents))
    const states = Object.values(task.agents).map((r) => r.state)
    const completed = states.filter((s) => s === 'completed').length
    task.status = completed === states.length && states.length > 0 ? 'COMPLETED' : completed === 0 ? 'ALL_FAILED' : 'PARTIAL_FAILED'
    task.endedAt = this.opts.now()
    this.touch(task)
  }

  async mergeTask(params: MergeTaskParams): Promise<MergeTaskResult> {
    const task = this.tasks.get(params.taskId)
    if (!task) throw new Error(`unknown task: ${params.taskId}`)
    const targets = params.agents ?? Object.values(task.agents).filter((r) => r.state === 'completed').map((r) => r.agent)
    const results: MergeTaskResult['results'] = []
    for (const agent of targets) {
      const run = task.agents[agent]
      if (!run?.worktreeId) {
        results.push({ agent, ok: false, committed: false, message: 'agent has no worktree', conflictFiles: [] })
        continue
      }
      try {
        const r = await this.opts.worktree.mergeWorktree({
          worktreeId: run.worktreeId,
          ...(params.files ? { files: params.files } : {}),
          commitMessage: `helmsman: merge ${agent} for task ${task.id}`,
        })
        results.push({ agent, ...r })
      } catch (err) {
        results.push({ agent, ok: false, committed: false, message: err instanceof Error ? err.message : String(err), conflictFiles: [] })
      }
    }
    if (params.discardAfterMerge) {
      await this.discardTask(params.taskId)
    }
    return { taskId: params.taskId, results }
  }

  async discardTask(taskId: string): Promise<void> {
    this.aborts.get(taskId)?.abort()
    await this.opts.worktree.removeTaskWorktrees(taskId)
    const task = this.tasks.get(taskId)
    if (task && ['RUNNING', 'CREATING_WORKTREES', 'AGGREGATING'].includes(task.status)) {
      task.status = 'CANCELLED'
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
    void this.executeTask(task).catch((err) => {
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
    return { taskId }
  }
}

function describeTopology(t: NonNullable<Awaited<ReturnType<TopologyLike['loadTopology']>>>): string {
  const lines: string[] = []
  for (const [id, svc] of Object.entries(t.services)) {
    lines.push(`- ${id} (${svc.name})`)
  }
  for (const [from, edges] of Object.entries(t.restDependencies)) {
    for (const e of edges) {
      lines.push(`- ${from} --${e.method}--> ${e.toServiceId} ${e.endpoints.join(', ')}`)
    }
  }
  return lines.join('\n')
}

/** Marks files changed by more than one agent as conflicting. */
export function markConflicts(task: TaskRecord, runs: AgentRun[]): void {
  const byFile = new Map<string, string[]>()
  for (const run of runs) {
    for (const f of run.diffs ?? []) {
      byFile.set(f.path, [...(byFile.get(f.path) ?? []), run.agent])
    }
  }
  for (const run of runs) {
    run.conflictingFiles = (run.diffs ?? [])
      .filter((f) => (byFile.get(f.path)?.length ?? 0) > 1)
      .map((f) => f.path)
    if (run.conflictingFiles.length === 0) delete run.conflictingFiles
  }
}
