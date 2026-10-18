/**
 * Host subagent dispatcher (change `autonomous-agent-team`, T2/T3 seam).
 *
 * One team task runs as one native DSH child session: `startActivation` gets a
 * `cwd` (the target worktree), the role prompt and the caller's signal. The
 * dispatcher maps the child's terminal result onto a `SettleInput`; it never
 * treats "started" as "done". Real host objects are behind small structural
 * interfaces so this file stays testable.
 */
import type { DispatchHandle, DispatchRequest, TeamDispatcher } from './coordinator.ts'
import type { SettleInput } from './runner.ts'
import { buildTaskPrompt as buildTaskPromptFromRole } from './prompts/index.ts'
import type { TeamRole, TeamTaskRecord } from './types.ts'

export interface SubagentResultLike {
  readonly stopReason?: string
  readonly diagnostic?: string
  readonly output?: readonly unknown[]
}

export interface SubagentActivationLike {
  readonly childId: string
  readonly result: Promise<SubagentResultLike>
  dispose(): Promise<void>
}

export interface SubagentStartSpecLike {
  provider: string
  label: string
  request: {
    parent: unknown
    prompt: Array<{ type: 'text'; text: string }>
    cwd?: string
    maxDepth?: number
    agentPreset?: string
  }
  signal: AbortSignal
  delivery: 'caller'
}

export interface SubagentServiceLike {
  startActivation(spec: SubagentStartSpecLike): Promise<SubagentActivationLike>
}

export interface HostDispatcherOptions {
  /** Exact live parent Agent (the tool caller); the host rejects a replaced one. */
  parent: unknown
  provider?: string
  /** Resolve the target worktree for one task; throw when it has none. */
  cwdForTask: (task: TeamTaskRecord) => string
  signal?: AbortSignal
  /** Optional role→agent preset id; the host enforces the preset's composition. */
  agentPresetForRole?: (role: TeamRole) => string | undefined
}

/** One worker prompt built from the role contract and the task (kept for callers/tests). */
export function buildTaskPrompt(request: DispatchRequest): string {
  return buildTaskPromptFromRole({
    task: request.task,
    ...(request.run.id !== undefined ? { runId: request.run.id } : {}),
    ...(request.run.proposalId !== undefined ? { proposalId: request.run.proposalId } : {}),
  })
}

export class HostSubagentDispatcher implements TeamDispatcher {
  constructor(
    private readonly subagents: SubagentServiceLike,
    private readonly options: HostDispatcherOptions,
  ) {}

  async start(request: DispatchRequest): Promise<DispatchHandle> {
    const cwd = this.options.cwdForTask(request.task)
    const signal = this.options.signal ?? new AbortController().signal
    const preset = this.options.agentPresetForRole?.(request.task.role)
    const activation = await this.subagents.startActivation({
      provider: this.options.provider ?? 'spawn',
      label: `team:${request.task.role}:${request.task.id}`,
      request: {
        parent: this.options.parent,
        prompt: [{ type: 'text', text: buildTaskPrompt(request) }],
        cwd,
        ...(preset !== undefined ? { agentPreset: preset } : {}),
      },
      signal,
      delivery: 'caller',
    })
    return {
      result: (async (): Promise<SettleInput> => {
        try {
          const result = await activation.result
          const completed = result.stopReason === undefined || result.stopReason === 'completed'
          return {
            status: completed ? 'done' : 'failed',
            ...(completed
              ? { outcome: `child ${activation.childId} completed` }
              : { outcome: result.diagnostic ?? `child ${activation.childId} stopped: ${String(result.stopReason)}` }),
          }
        } finally {
          await activation.dispose().catch(() => undefined)
        }
      })(),
    }
  }
}
