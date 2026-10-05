/**
 * Swarm task execution (change `add-swarm-parallel`).
 *
 * One worktree and one branch per task, derived from the proposal-level carrier:
 * `<root>/.workmates/<proposal>--<task>` on `feature/<proposal>--<task>`, branched
 * off the proposal's implementation branch. Merging a task back is a `--no-ff`
 * merge inside the proposal worktree; a conflict aborts the merge and hands the
 * conflicting files back for adjudication (design D4) — this layer never guesses.
 */
import { execFile } from 'node:child_process'
import type { ProposalService } from '../proposal/service.ts'
import type { WorktreeManager } from '../worktree/manager.ts'
import { planSwarm, type SwarmPlan, type SwarmTaskInput } from './plan.ts'

export type SwarmTaskStatus = 'planned' | 'running' | 'merged' | 'failed'

export interface SwarmTaskRecord {
  id: string
  title: string
  /** Declared write scopes (empty = not declared; see design D2). */
  writes: string[]
  branch?: string
  worktreePath?: string
  portRange?: number[]
  status: SwarmTaskStatus
  startedAt?: string
  mergedAt?: string
  /** Short hash of the merge commit (or the task's tip when merged). */
  commit?: string
  note?: string
}

export interface SwarmManagerDeps {
  proposals: ProposalService
  worktrees: WorktreeManager
  now?: () => Date
}

export interface SwarmMergeResult {
  record: SwarmTaskRecord
  merged: boolean
  /** Files left in conflict; empty when the merge succeeded. */
  conflicts: string[]
  summary: string
}

const git = (args: string[], cwd: string, signal?: AbortSignal): Promise<string> =>
  new Promise((resolvePromise, reject) => {
    execFile('git', args, { cwd, timeout: 30_000, maxBuffer: 8 * 1024 * 1024, ...(signal !== undefined ? { signal } : {}) }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr?.trim() || error.message))
      else resolvePromise(stdout)
    })
  })

export class SwarmManager {
  constructor(private readonly deps: SwarmManagerDeps) {}

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString()
  }

  /** Replace the task records with a fresh plan, keeping status of matching ids. */
  async plan(proposalId: string, tasks: readonly SwarmTaskInput[], options: { maxParallel?: number } = {}): Promise<{ plan: SwarmPlan; tasks: SwarmTaskRecord[] }> {
    const proposal = await this.mustGet(proposalId)
    const previous = new Map((proposal.swarmTasks ?? []).map((record) => [record.id, record]))
    const plan = planSwarm(tasks, options)
    const records: SwarmTaskRecord[] = tasks.map((task) => {
      const existing = previous.get(task.id)
      return {
        id: task.id,
        title: task.title,
        writes: [...task.writes],
        status: existing?.status ?? 'planned',
        ...(existing?.branch !== undefined ? { branch: existing.branch } : {}),
        ...(existing?.worktreePath !== undefined ? { worktreePath: existing.worktreePath } : {}),
        ...(existing?.portRange !== undefined ? { portRange: existing.portRange } : {}),
        ...(existing?.startedAt !== undefined ? { startedAt: existing.startedAt } : {}),
        ...(existing?.mergedAt !== undefined ? { mergedAt: existing.mergedAt } : {}),
        ...(existing?.commit !== undefined ? { commit: existing.commit } : {}),
        ...(existing?.note !== undefined ? { note: existing.note } : {}),
      }
    })
    await this.deps.proposals.patchFields(proposalId, { swarmTasks: records })
    return { plan, tasks: records }
  }

  async list(proposalId: string): Promise<SwarmTaskRecord[]> {
    return (await this.mustGet(proposalId)).swarmTasks ?? []
  }

  /** Create the task's own worktree + branch and mark it running. */
  async start(
    proposalId: string,
    taskId: string,
    options: { projectRoot: string; mainBranch?: string; signal?: AbortSignal },
  ): Promise<SwarmTaskRecord> {
    const records = await this.list(proposalId)
    const record = records.find((entry) => entry.id === taskId)
    if (record === undefined) throw new Error(`unknown swarm task '${taskId}' — run workmate_swarm_plan first`)
    if (record.status === 'merged') throw new Error(`task '${taskId}' is already merged`)
    if (record.status === 'running') return record

    const carrierId = `${proposalId}--${taskId}`
    const created = await this.deps.worktrees.create({
      projectRoot: options.projectRoot,
      proposalId: carrierId,
      mainBranch: options.mainBranch ?? `feature/${proposalId}`,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    })
    const updated: SwarmTaskRecord = {
      ...record,
      branch: created.featureBranch,
      worktreePath: created.worktreePath,
      portRange: created.portRange,
      status: 'running',
      startedAt: this.now(),
      note: created.install === 'failed' ? `dependency install failed: ${created.installNote ?? 'unknown'}` : undefined,
    }
    await this.persist(proposalId, records, updated)
    return updated
  }

  /**
   * Merge the task branch back into the proposal's implementation branch,
   * inside the proposal worktree. Conflicts abort the merge and are reported.
   */
  async merge(
    proposalId: string,
    taskId: string,
    options: { projectRoot: string; signal?: AbortSignal },
  ): Promise<SwarmMergeResult> {
    const records = await this.list(proposalId)
    const record = records.find((entry) => entry.id === taskId)
    if (record === undefined) throw new Error(`unknown swarm task '${taskId}'`)
    if (record.status === 'merged') return { record, merged: true, conflicts: [], summary: `task '${taskId}' already merged` }
    if (record.branch === undefined) throw new Error(`task '${taskId}' has no branch — start it first`)

    const carrier = this.deps.worktrees.worktreePath(options.projectRoot, proposalId)
    const mergeArgs = ['merge', '--no-ff', record.branch, '-m', `merge ${taskId} into feature/${proposalId}`]
    try {
      await git(mergeArgs, carrier, options.signal)
    } catch (error) {
      // A previous attempt may have left the index dirty: clear it, collect the
      // conflicted files, and hand the decision back (design D4).
      let conflicts: string[] = []
      try {
        conflicts = (await git(['diff', '--name-only', '--diff-filter=U'], carrier, options.signal))
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line !== '')
      } catch {
        conflicts = []
      }
      await git(['merge', '--abort'], carrier, options.signal).catch(() => '')
      const failed: SwarmTaskRecord = {
        ...record,
        status: 'failed',
        note: `merge conflict (${conflicts.length} file(s)${conflicts.length > 0 ? `: ${conflicts.slice(0, 5).join(', ')}` : ''}) — ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
      }
      await this.persist(proposalId, records, failed)
      return {
        record: failed,
        merged: false,
        conflicts,
        summary: `merge aborted; ${conflicts.length} conflicted file(s) need adjudication`,
      }
    }

    let commit: string | undefined
    try {
      commit = (await git(['rev-parse', '--short', 'HEAD'], carrier, options.signal)).trim()
    } catch {
      commit = undefined
    }
    const merged: SwarmTaskRecord = {
      ...record,
      status: 'merged',
      mergedAt: this.now(),
      ...(commit !== undefined && commit !== '' ? { commit } : {}),
    }
    await this.persist(proposalId, records, merged)
    return { record: merged, merged: true, conflicts: [], summary: `merged ${record.branch} into feature/${proposalId}` }
  }

  private async persist(proposalId: string, records: SwarmTaskRecord[], updated: SwarmTaskRecord): Promise<void> {
    const next = records.map((entry) => (entry.id === updated.id ? updated : entry))
    await this.deps.proposals.patchFields(proposalId, { swarmTasks: next })
  }

  private async mustGet(proposalId: string): Promise<NonNullable<Awaited<ReturnType<ProposalService['get']>>>> {
    const proposal = await this.deps.proposals.get(proposalId)
    if (proposal === undefined) throw new Error(`proposal not found: ${proposalId}`)
    return proposal
  }
}
