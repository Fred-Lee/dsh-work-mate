/**
 * Team run conductor (change `autonomous-agent-team`, T2 foundation).
 *
 * This layer owns the deterministic parts: create a run from `TASKS.json`,
 * decide which tasks may be dispatched next, record dispatches, settle them,
 * and derive the run status. It deliberately does not create host sessions —
 * the caller supplies a dispatch id/session; the subagent/session adapter comes
 * next so this logic stays testable without a live host.
 */
import { validateTeamTasks, writesConflict } from './tasks.ts'
import { TEAM_TEMPLATE_CONTRACTS } from './roster.ts'
import {
  DEFAULT_TEAM_BUDGET,
  type TeamBudget,
  type TeamDispatch,
  type TeamDispatchStatus,
  type TeamRun,
  type TeamRunStatus,
  type TeamTaskRecord,
  type TeamTaskSpec,
  type TeamTemplate,
} from './types.ts'
import { TeamRunStore } from './store.ts'

export interface CreateRunInput {
  /** Explicit id is allowed for tests and external callers; otherwise generated. */
  id?: string
  proposalId: string
  template: TeamTemplate
  tasks: TeamTaskSpec[]
  budget?: Partial<TeamBudget>
}

export interface SettleInput {
  status: Extract<TeamDispatchStatus, 'done' | 'failed' | 'blocked'>
  outcome?: string
  reportPath?: string
  filesModified?: string[]
  /** Worker needs a human/coordinator decision; the run pauses instead of retrying. */
  question?: string
  /** Worker is blocked by a scope/decision it cannot take alone. */
  escalation?: string
}

export class TeamRunner {
  constructor(
    private readonly store: TeamRunStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Validate the task file, enforce template roles, and persist a planned run. */
  async createRun(input: CreateRunInput): Promise<TeamRun> {
    const validation = validateTeamTasks(input.tasks)
    if (!validation.ok) throw new Error(`TASKS.json 校验失败：${validation.errors.join('；')}`)
    const contract = TEAM_TEMPLATE_CONTRACTS[input.template]
    const outside = validation.tasks.filter((task) => !contract.roles.includes(task.role))
    if (outside.length > 0) {
      throw new Error(
        `模板 ${input.template} 不包含角色：${[...new Set(outside.map((task) => task.role))].join(', ')}`,
      )
    }
    const id = input.id?.trim() || `run-${input.proposalId}-${this.now().getTime().toString(36)}`
    if (await this.store.get(id)) throw new Error(`team run already exists: ${id}`)
    const timestamp = this.now().toISOString()
    const tasks: TeamTaskRecord[] = validation.tasks.map((task) => ({ ...task, status: 'planned', attempts: 0 }))
    const budget: TeamBudget = { ...DEFAULT_TEAM_BUDGET, ...(input.budget ?? {}) }
    return this.store.upsert(
      {
        id,
        proposalId: input.proposalId,
        template: input.template,
        status: 'planned',
        tasks,
        dispatches: [],
        budget,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      this.now,
    )
  }

  async get(id: string): Promise<TeamRun> {
    const run = await this.store.get(id)
    if (run === undefined) throw new Error(`team run not found: ${id}`)
    return run
  }

  async start(id: string): Promise<TeamRun> {
    const run = await this.get(id)
    if (run.status !== 'planned') return run
    return this.store.patch(id, { status: 'running' }, this.now)
  }

  /** Planned tasks that may start now, respecting dependencies, active slots and write scopes. */
  async nextWave(id: string): Promise<TeamTaskRecord[]> {
    const run = await this.get(id)
    const active = run.tasks.filter((task) => task.status === 'dispatched' || task.status === 'running')
    const slots = Math.max(0, run.budget.maxParallel - active.length)
    if (slots === 0) return []
    const done = new Set(run.tasks.filter((task) => task.status === 'done').map((task) => task.id))
    const planned = run.tasks.filter(
      (task) => task.status === 'planned' && task.dependsOn.every((dependency) => done.has(dependency)),
    )
    const selected: TeamTaskRecord[] = []
    for (const task of planned) {
      if (selected.length >= slots) break
      if ([...active, ...selected].some((other) => writesConflict(other, task))) continue
      selected.push(task)
    }
    return selected
  }

  /** Mark one task dispatched and append its dispatch record. */
  async dispatch(id: string, taskId: string, dispatchId: string): Promise<TeamRun> {
    const run = await this.get(id)
    if (run.dispatches !== undefined && run.dispatches.length >= run.budget.maxDispatches) {
      throw new Error(`Run 达到 Dispatch 上限 ${run.budget.maxDispatches} — 暂停并上报`)
    }
    const task = run.tasks.find((entry) => entry.id === taskId)
    if (task === undefined) throw new Error(`task not found: ${taskId}`)
    if (task.status !== 'planned') throw new Error(`task ${taskId} is ${task.status} — 只有 planned 可派发`)
    if (task.attempts >= run.budget.maxAttempts) {
      throw new Error(`task ${taskId} 已达到重试上限 ${run.budget.maxAttempts} — 升级给人`)
    }
    const timestamp = this.now().toISOString()
    const dispatch: TeamDispatch = {
      id: dispatchId,
      taskId,
      role: task.role,
      status: 'dispatched',
      startedAt: timestamp,
    }
    task.status = 'dispatched'
    task.attempts += 1
    task.dispatchId = dispatchId
    return this.store.patch(
      id,
      {
        status: 'running',
        tasks: [...run.tasks],
        dispatches: [...(run.dispatches ?? []), dispatch],
      },
      this.now,
    )
  }

  /** Settle one dispatch; a failed attempt requeues the task until the retry cap. */
  async settle(id: string, dispatchId: string, input: SettleInput): Promise<TeamRun> {
    const run = await this.get(id)
    const dispatches = [...(run.dispatches ?? [])]
    const index = dispatches.findIndex((dispatch) => dispatch.id === dispatchId)
    if (index === -1) throw new Error(`dispatch not found: ${dispatchId}`)
    const dispatch = dispatches[index] as TeamDispatch
    if (dispatch.status !== 'dispatched' && dispatch.status !== 'running') {
      throw new Error(`dispatch ${dispatchId} is already settled (${dispatch.status})`)
    }
    const task = run.tasks.find((entry) => entry.id === dispatch.taskId)
    if (task === undefined) throw new Error(`task not found: ${dispatch.taskId}`)
    const timestamp = this.now().toISOString()
    dispatches[index] = {
      ...dispatch,
      status: input.status,
      endedAt: timestamp,
      ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
      ...(input.reportPath !== undefined ? { reportPath: input.reportPath } : {}),
      ...(input.filesModified !== undefined ? { filesModified: [...input.filesModified] } : {}),
    }
    if (input.status === 'done') {
      task.status = 'done'
      dispatch.status = 'done'
    } else if (input.status === 'blocked') {
      task.status = 'blocked'
    } else {
      task.status = task.attempts >= run.budget.maxAttempts ? 'failed' : 'planned'
      if (task.status === 'planned') delete task.dispatchId
    }
    return this.store.patch(
      id,
      { tasks: [...run.tasks], dispatches, status: deriveRunStatus(run.tasks) },
      this.now,
    )
  }

  async abort(id: string): Promise<TeamRun> {
    return this.store.patch(id, { status: 'aborted' }, this.now)
  }

  /** Requeue one blocked task after a human answer; attempts restart so the worker can try again. */
  async resetTask(id: string, taskId: string): Promise<TeamRun> {
    const run = await this.get(id)
    const task = run.tasks.find((entry) => entry.id === taskId)
    if (task === undefined) throw new Error(`task not found: ${taskId}`)
    if (task.status !== 'blocked' && task.status !== 'failed') {
      throw new Error(`task ${taskId} is ${task.status} — 只有 blocked/failed 可重置`)
    }
    task.status = 'planned'
    task.attempts = 0
    delete task.dispatchId
    return this.store.patch(id, { status: 'running', tasks: [...run.tasks] }, this.now)
  }
}

export function deriveRunStatus(tasks: readonly TeamTaskRecord[]): TeamRunStatus {
  if (tasks.every((task) => task.status === 'planned')) return 'planned'
  if (tasks.every((task) => task.status === 'done')) return 'succeeded'
  if (tasks.some((task) => task.status === 'blocked')) return 'blocked'
  if (tasks.some((task) => task.status === 'failed')) return 'partial'
  return 'running'
}
