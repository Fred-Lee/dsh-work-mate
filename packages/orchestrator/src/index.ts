/**
 * @helmsman/orchestrator — DSH plugin entry.
 *
 * Provides the `helmsman.orchestrator` cordis service and registers agent
 * tools so the fleet can also be driven headlessly (PRD 第 6 步验证方式).
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'
import { OrchestratorCore } from './core.ts'
import type { AgentAdapter, RunParallelParams, TaskRecord, TopologyLike, WorktreeLike } from './types.ts'

export const name = '@helmsman/orchestrator'
/** hard dependency: worktrees are the isolation primitive of every task */
export const inject = ['helmsman.worktree'] as const

export interface Config {
  defaultTimeoutSec?: number
  maxRateLimitAttempts?: number
  circuitBreakerThreshold?: number
  circuitBreakerCooldownMs?: number
  maxTasksKept?: number
}

export interface OrchestratorService {
  registerAdapter(adapter: AgentAdapter): void
  checkAgents(): Promise<Record<string, { installed: boolean; version?: string }>>
  runParallelTask(params: RunParallelParams): Promise<{ taskId: string }>
  cancelTask(taskId: string): void
  getTaskStatus(taskId: string): TaskRecord | undefined
  listTasks(): TaskRecord[]
  retryTask(taskId: string, agents?: string[]): Promise<{ taskId: string }>
  mergeTask(params: Parameters<OrchestratorCore['mergeTask']>[0]): Promise<Awaited<ReturnType<OrchestratorCore['mergeTask']>>>
  discardTask(taskId: string): Promise<void>
  getUsage(): Record<string, { runs: number; promptChars: number; outputChars: number; estimatedTokens: number }>
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

export function apply(ctx: Context, config: Config = {}) {
  const worktree = ctx.get('helmsman.worktree') as WorktreeLike
  // topology is optional: orchestrator works without it (direct repoPath runs)
  const topology = ctx.get('helmsman.topology') as TopologyLike | undefined

  const core = new OrchestratorCore({
    worktree,
    topology,
    defaultTimeoutSec: config.defaultTimeoutSec ?? 300,
    maxRateLimitAttempts: config.maxRateLimitAttempts ?? 3,
    circuitBreakerThreshold: config.circuitBreakerThreshold ?? 5,
    circuitBreakerCooldownMs: config.circuitBreakerCooldownMs ?? 30_000,
    maxTasksKept: config.maxTasksKept ?? 50,
    onTaskUpdated: (task) => {
      ctx.emit('helmsman/task-updated', task)
    },
  })

  const service: OrchestratorService = {
    registerAdapter: (adapter) => core.registerAdapter(adapter),
    checkAgents: () => core.checkAgents(),
    runParallelTask: (params) => core.runParallelTask(params),
    cancelTask: (taskId) => core.cancelTask(taskId),
    getTaskStatus: (taskId) => core.getTaskStatus(taskId),
    listTasks: () => core.listTasks(),
    retryTask: (taskId, agents) => core.retryTask(taskId, agents),
    mergeTask: (params) => core.mergeTask(params),
    discardTask: (taskId) => core.discardTask(taskId),
    getUsage: () => core.getUsage(),
  }
  ctx.provide('helmsman.orchestrator', service)

  registerTools(ctx, service)
  console.log(`[helmsman/orchestrator] ready (adapters register themselves via inject)`)
}

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
      description: 'Cancel a running Helmsman parallel task (aborts all agents).',
      parameters: {
        taskId: { type: 'string', required: true },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args) {
        const task = service.getTaskStatus(args.taskId)
        if (!task) return { ok: false, error: `unknown task: ${args.taskId}` }
        service.cancelTask(args.taskId)
        return JSON.parse(JSON.stringify({ ok: true, taskId: args.taskId }))
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'helmsman_merge_task',
      description: 'Merge completed agents\' changes from their worktrees back onto the base repository (optionally restricted to agents/files), or discard all worktrees.',
      parameters: {
        taskId: { type: 'string', required: true },
        mode: { type: 'string', description: '"merge" (default) applies patches onto the base repo; "discard" removes all worktrees of the task.' },
        agents: { type: 'string', description: 'Comma-separated agent names to merge; default = all completed agents.' },
        files: { type: 'string', description: 'Comma-separated repo-relative paths to restrict the merge to.' },
        discardAfterMerge: { type: 'boolean', description: 'Remove worktrees after merging.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args) {
        if (args.mode === 'discard') {
          await service.discardTask(args.taskId)
          return { taskId: args.taskId, discarded: true }
        }
        const result = await service.mergeTask({
          taskId: args.taskId,
          ...(args.agents !== undefined ? { agents: args.agents.split(',').map((a) => a.trim()).filter(Boolean) } : {}),
          ...(args.files !== undefined ? { files: args.files.split(',').map((f) => f.trim()).filter(Boolean) } : {}),
          ...(args.discardAfterMerge === true ? { discardAfterMerge: true } : {}),
        })
        return JSON.parse(JSON.stringify(result))
      },
    }),
  )
}
