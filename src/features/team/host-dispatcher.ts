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
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { TeamRole, TeamTaskRecord } from './types.ts'

export interface SubagentResultLike {
  readonly stopReason?: string
  readonly diagnostic?: string
  readonly output?: readonly unknown[]
  /** Host usage when exposed; omitted means the seam cannot measure tokens. */
  readonly usage?: { totalTokens?: number }
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
    agentOptions?: { provider?: string; model?: string; reasoningEffort?: string }
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
  /** Optional role→model overrides; omitted inherits the parent session model. */
  agentOptionsForRole?: (role: TeamRole) => { provider?: string; model?: string; reasoningEffort?: string } | undefined
  /** Measure actual files changed in the worktree (git diff against the base commit). */
  changedFilesForTask?: (task: TeamTaskRecord) => Promise<string[] | undefined>
  /** Require REPORT paths to exist under cwd before accepting done. */
  verifyReportPath?: boolean
}

const textOf = (output: readonly unknown[] | undefined): string =>
  (output ?? [])
    .map((block) =>
      block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
        ? String((block as { text?: unknown }).text ?? '')
        : '',
    )
    .join('\n')

/** A worker can pause the run by ending with QUESTION:/ESCALATION: instead of pretending success. */
export function extractWorkerMarker(
  output: readonly unknown[] | undefined,
): { kind: 'question' | 'escalation'; body: string } | undefined {
  const text = textOf(output)
  const question = /(?:^|\n)\s*QUESTION:\s*(.+)/i.exec(text)
  if (question?.[1] !== undefined) return { kind: 'question', body: question[1].trim() }
  const escalation = /(?:^|\n)\s*ESCALATION:\s*(.+)/i.exec(text)
  if (escalation?.[1] !== undefined) return { kind: 'escalation', body: escalation[1].trim() }
  return undefined
}

/** Optional `FILES: a, b` report for write-scope checks. */
export function extractFilesModified(output: readonly unknown[] | undefined): string[] | undefined {
  const match = /(?:^|\n)\s*FILES:\s*(.+)/i.exec(textOf(output))
  if (match?.[1] === undefined) return undefined
  const files = match[1]
    .split(',')
    .map((file) => file.trim())
    .filter((file) => file !== '')
  return files.length > 0 ? files : undefined
}

/** Optional `REPORT: path` marker for artifact-owning roles. */
export function extractReportPath(output: readonly unknown[] | undefined): string | undefined {
  const match = /(?:^|\n)\s*REPORT:\s*(.+)/i.exec(textOf(output))
  const path = match?.[1]?.trim()
  return path === undefined || path === '' ? undefined : path.replace(/^["'`]|["'`]$/g, '')
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
    const agentOptions = this.options.agentOptionsForRole?.(request.task.role)
    const activation = await this.subagents.startActivation({
      provider: this.options.provider ?? 'spawn',
      label: `team:${request.task.role}:${request.task.id}`,
      request: {
        parent: this.options.parent,
        prompt: [{ type: 'text', text: buildTaskPrompt(request) }],
        cwd,
        ...(preset !== undefined ? { agentPreset: preset } : {}),
        ...(agentOptions !== undefined ? { agentOptions } : {}),
      },
      signal,
      delivery: 'caller',
    })
    return {
      result: (async (): Promise<SettleInput> => {
        try {
          const result = await activation.result
          const marker = extractWorkerMarker(result.output)
          if (marker !== undefined) {
            if (marker.kind === 'question') {
              return { status: 'blocked', question: marker.body, outcome: `child ${activation.childId} asked a question` }
            }
            return {
              status: 'blocked',
              escalation: marker.body,
              outcome: `child ${activation.childId} escalated`,
            }
          }
          const markerReport = extractReportPath(result.output)
          const markerFiles = extractFilesModified(result.output)
          const measured = await this.options.changedFilesForTask?.(request.task)
          const filesModified =
            measured !== undefined || markerFiles !== undefined
              ? [...new Set([...(measured ?? []), ...(markerFiles ?? [])])]
              : undefined
          const reportPath = markerReport
          if (reportPath !== undefined && this.options.verifyReportPath === true) {
            try {
              await stat(join(cwd, reportPath))
            } catch {
              return {
                status: 'failed',
                outcome: `REPORT 路径不存在：${reportPath}`,
              }
            }
          }
          const completed = result.stopReason === undefined || result.stopReason === 'completed'
          return {
            status: completed ? 'done' : 'failed',
            ...(completed
              ? { outcome: `child ${activation.childId} completed` }
              : { outcome: result.diagnostic ?? `child ${activation.childId} stopped: ${String(result.stopReason)}` }),
            ...(result.usage?.totalTokens !== undefined ? { tokensUsed: result.usage.totalTokens } : {}),
            ...(filesModified !== undefined ? { filesModified } : {}),
            ...(reportPath !== undefined ? { reportPath } : {}),
          }
        } finally {
          await activation.dispose().catch(() => undefined)
        }
      })(),
    }
  }
}
