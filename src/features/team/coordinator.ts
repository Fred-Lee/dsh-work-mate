/**
 * Team coordinator loop (change `autonomous-agent-team`, T2). It turns the
 * deterministic `TeamRunner` into autonomous progress: dispatch a wave through
 * a pluggable dispatcher, await the wave, settle outcomes, repeat until the run
 * is terminal or no task can start.
 *
 * The dispatcher is the host seam: tests use a fake, the plugin will use the
 * subagent session adapter (one worker per task). The coordinator never starts
 * a second wave before the current one settles, so one Run has at most
 * `maxParallel` workers and no duplicated dispatch.
 */
import type { SettleInput, TeamRunner } from './runner.ts'
import type { TeamRun, TeamTaskRecord } from './types.ts'
import type { TeamEventSink } from './events.ts'
import { validateWorkerDone } from './inbox.ts'
import type { TeamInbox } from './inbox.ts'

export interface DispatchRequest {
  run: TeamRun
  task: TeamTaskRecord
  dispatchId: string
}

export interface DispatchHandle {
  /** Resolves once the worker reached a terminal outcome. */
  result: Promise<SettleInput>
}

export interface TeamDispatcher {
  /** Start one worker; the returned handle's promise settles the outcome. */
  start(request: DispatchRequest): Promise<DispatchHandle>
}

export interface CoordinatorResult {
  run: TeamRun
  waves: number
  /** Set when the run stopped without being terminal. */
  stopped?: string
  /** Inbox message awaiting a human/coordinator answer. */
  questionId?: string
}

const TERMINAL = new Set<TeamRun['status']>(['succeeded', 'partial', 'blocked', 'aborted'])

export class TeamCoordinator {
  constructor(
    private readonly runner: TeamRunner,
    private readonly dispatcher: TeamDispatcher,
    private readonly now: () => Date = () => new Date(),
    private readonly events?: TeamEventSink,
    private readonly inbox?: TeamInbox,
  ) {}

  /** Drive a run to a terminal status; returns the final run (never throws for task failures). */
  async run(runId: string): Promise<CoordinatorResult> {
    await this.runner.start(runId)
    let waves = 0
    for (;;) {
      const run = await this.runner.get(runId)
      if (TERMINAL.has(run.status)) {
        await this.events?.run({ run, detail: `terminal:${run.status}` })
        return { run, waves }
      }
      if (this.now().getTime() - new Date(run.createdAt).getTime() > run.budget.maxDurationMs) {
        const aborted = await this.runner.abort(runId)
        const stopped = `超过 Run 时长预算 ${run.budget.maxDurationMs}ms`
        await this.events?.run({ run: aborted, detail: stopped })
        return { run: aborted, waves, stopped }
      }

      const wave = await this.runner.nextWave(runId)
      if (wave.length === 0) {
        const final = await this.runner.get(runId)
        const stopped = TERMINAL.has(final.status) ? undefined : '没有可派发的任务（依赖/写域/重试上限）'
        await this.events?.run({ run: final, ...(stopped !== undefined ? { detail: stopped } : {}) })
        return { run: final, waves, stopped }
      }

      const handles: Array<{ task: TeamTaskRecord; dispatchId: string; handle: DispatchHandle }> = []
      for (const task of wave) {
        const dispatchId = `${runId}-${task.id}-a${task.attempts + 1}`
        try {
          const dispatched = await this.runner.dispatch(runId, task.id, dispatchId)
          const current = dispatched.tasks.find((entry) => entry.id === task.id)
          if (current === undefined) continue
          await this.events?.dispatch({ run: dispatched, task: current, dispatchId })
          const handle = await this.dispatcher.start({ run: dispatched, task: current, dispatchId })
          handles.push({ task: current, dispatchId, handle })
        } catch (error) {
          // A start failure is a failed attempt, not a crash of the whole run.
          await this.runner
            .settle(runId, dispatchId, {
              status: 'failed',
              outcome: error instanceof Error ? error.message : String(error),
            })
            .catch(() => undefined)
        }
      }
      if (handles.length === 0) {
        const final = await this.runner.get(runId)
        if (TERMINAL.has(final.status) || (await this.runner.nextWave(runId)).length > 0) continue
        return { run: final, waves, stopped: '本波次没有成功派发的任务' }
      }
      const outcomes = await Promise.all(
        handles.map((entry) =>
          entry.handle.result.catch((error: unknown) => ({
            status: 'failed' as const,
            outcome: error instanceof Error ? error.message : String(error),
          })),
        ),
      )
      let asked: { id: string } | undefined
      for (const [index, entry] of handles.entries()) {
        const outcome = outcomes[index] as SettleInput | undefined
        if (outcome === undefined) continue
        const question = outcome.question ?? outcome.escalation
        if (question !== undefined && question.trim() !== '') {
          const kind = outcome.escalation !== undefined ? 'escalation' : 'question'
          const message = this.inbox?.post({ runId, taskId: entry.task.id, kind, body: question })
          asked = message
          const settled = await this.runner.settle(runId, entry.dispatchId, {
            ...outcome,
            status: 'blocked',
            outcome: question,
          })
          const task = settled.tasks.find((item) => item.id === entry.task.id)
          if (task !== undefined) {
            await this.events?.settled({
              run: settled,
              task,
              dispatchId: entry.dispatchId,
              status: 'blocked',
              detail: question,
            })
          }
          continue
        }
        const proofErrors = validateWorkerDone(entry.task, outcome)
        const effective =
          proofErrors.length > 0
            ? { status: 'failed' as const, outcome: `缺少完成证据：${proofErrors.join('；')}` }
            : outcome
        const settled = await this.runner.settle(runId, entry.dispatchId, effective)
        const task = settled.tasks.find((item) => item.id === entry.task.id)
        if (task !== undefined) {
          await this.events?.settled({
            run: settled,
            task,
            dispatchId: entry.dispatchId,
            status: effective.status,
            ...(effective.outcome !== undefined ? { detail: effective.outcome } : {}),
          })
        }
      }
      if (asked !== undefined) {
        const run = await this.runner.get(runId)
        await this.events?.run({ run, detail: `paused:${asked.id}` })
        return { run, waves, stopped: `等待回答 ${asked.id}`, questionId: asked.id }
      }
      waves += 1
    }
  }
}
