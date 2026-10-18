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
import type { TeamRunner } from './runner.ts'
import type { SettleInput } from './runner.ts'
import type { TeamRun, TeamTaskRecord } from './types.ts'

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
}

const TERMINAL = new Set<TeamRun['status']>(['succeeded', 'partial', 'blocked', 'aborted'])

export class TeamCoordinator {
  constructor(
    private readonly runner: TeamRunner,
    private readonly dispatcher: TeamDispatcher,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Drive a run to a terminal status; returns the final run (never throws for task failures). */
  async run(runId: string): Promise<CoordinatorResult> {
    await this.runner.start(runId)
    let waves = 0
    for (;;) {
      const run = await this.runner.get(runId)
      if (TERMINAL.has(run.status)) return { run, waves }
      if (this.now().getTime() - new Date(run.createdAt).getTime() > run.budget.maxDurationMs) {
        const aborted = await this.runner.abort(runId)
        return { run: aborted, waves, stopped: `超过 Run 时长预算 ${run.budget.maxDurationMs}ms` }
      }

      const wave = await this.runner.nextWave(runId)
      if (wave.length === 0) {
        const final = await this.runner.get(runId)
        return {
          run: final,
          waves,
          stopped: TERMINAL.has(final.status) ? undefined : '没有可派发的任务（依赖/写域/重试上限）',
        }
      }

      const handles: Array<{ taskId: string; dispatchId: string; handle: DispatchHandle }> = []
      for (const task of wave) {
        const dispatchId = `${runId}-${task.id}-a${task.attempts + 1}`
        const dispatched = await this.runner.dispatch(runId, task.id, dispatchId)
        const current = dispatched.tasks.find((entry) => entry.id === task.id)
        if (current === undefined) continue
        const handle = await this.dispatcher.start({ run: dispatched, task: current, dispatchId })
        handles.push({ taskId: task.id, dispatchId, handle })
      }
      if (handles.length === 0) {
        return { run: await this.runner.get(runId), waves, stopped: '本波次没有成功派发的任务' }
      }
      const outcomes = await Promise.all(handles.map((entry) => entry.handle.result))
      for (const [index, entry] of handles.entries()) {
        const outcome = outcomes[index]
        if (outcome !== undefined) await this.runner.settle(runId, entry.dispatchId, outcome)
      }
      waves += 1
    }
  }
}
