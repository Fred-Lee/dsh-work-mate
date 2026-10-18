/**
 * Baseline drift (change `multiproject-branch-workbench`, design D5.4): a
 * target records the base-branch tip it was cut from; if that branch moved,
 * the worktree is based on a stale commit. This is a warning, never an
 * auto-reset — rebasing is the caller's decision.
 */
import { gitExec } from '../worktree/git.ts'
import type { ProposalTarget } from './store.ts'

export interface TargetDrift {
  project: string
  baseBranch: string
  /** Tip recorded when the target worktree was created. */
  baseCommit: string
  /** Current tip of the base branch. */
  currentCommit: string
  drifted: boolean
}

/** `undefined` when there is nothing to compare (no recorded commit / git failure). */
export async function checkTargetDrift(
  projectRoot: string,
  target: Pick<ProposalTarget, 'project' | 'baseBranch' | 'baseCommit'>,
): Promise<TargetDrift | undefined> {
  if (target.baseCommit === undefined || target.baseCommit.trim() === '') return undefined
  try {
    const out = await gitExec(['rev-parse', '--verify', `${target.baseBranch}^{commit}`], projectRoot, 5_000)
    const currentCommit = out.trim()
    if (currentCommit === '') return undefined
    return {
      project: target.project,
      baseBranch: target.baseBranch,
      baseCommit: target.baseCommit,
      currentCommit,
      drifted: currentCommit !== target.baseCommit,
    }
  } catch {
    return undefined
  }
}
