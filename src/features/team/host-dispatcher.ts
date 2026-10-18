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
import { contractFor } from './roster.ts'
import type { TeamTaskRecord } from './types.ts'

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
}

/** Role + task prompt; deliberately terse so the worker cannot invent scope. */
export function buildTaskPrompt(request: DispatchRequest): string {
  const contract = contractFor(request.task.role)
  return [
    `你是团队角色「${contract.label}」（${request.task.role}）。`,
    `任务：${request.task.title}`,
    `项目：${request.task.project}`,
    `允许写入：${request.task.writes.length > 0 ? request.task.writes.join(', ') : '未声明（先向协调器确认）'}`,
    `验收标准：${request.task.acceptance}`,
    '',
    '约束：',
    `- ${contract.responsibility}`,
    ...contract.forbidden.map((rule) => `- ${rule}`),
    '- 不要启动子代理；不要修改本任务写域之外的文件。',
    '- 结束时用一句话说明结果与证据（命令/测试/文件）；失败就说失败，不要伪造成功。',
  ].join('\n')
}

export class HostSubagentDispatcher implements TeamDispatcher {
  constructor(
    private readonly subagents: SubagentServiceLike,
    private readonly options: HostDispatcherOptions,
  ) {}

  async start(request: DispatchRequest): Promise<DispatchHandle> {
    const cwd = this.options.cwdForTask(request.task)
    const signal = this.options.signal ?? new AbortController().signal
    const activation = await this.subagents.startActivation({
      provider: this.options.provider ?? 'spawn',
      label: `team:${request.task.role}:${request.task.id}`,
      request: {
        parent: this.options.parent,
        prompt: [{ type: 'text', text: buildTaskPrompt(request) }],
        cwd,
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
