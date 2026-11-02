/**
 * Parallel-proposal isolation (change `multiproject-branch-workbench`,
 * design D5). Occupancy is derived from active proposals and their effective
 * targets — never from a second lease file. What this module can see is a
 * branch-name collision; physical worktrees and write-scope conflicts are
 * checked elsewhere (worktree manager / proposal write scopes).
 */
import type { Proposal } from './store.ts'
import { effectiveTargets } from './targets.ts'

/** Proposal states that can still own a branch. `draft` has no branch yet. */
const OCCUPYING_STATES = new Set<Proposal['status']>([
  'proposing',
  'reviewing',
  'ready',
  'implementing',
  'merging',
  'archiving',
])

export interface BranchOccupancy {
  project: string
  branch: string
  proposalId: string
  kind: 'proposal' | 'feature'
}

export interface BranchConflict {
  project: string
  branch: string
  /** Sorted proposal ids that claim the same project + branch. */
  proposalIds: string[]
}

/** `archived` / abandoned proposals are history, not occupancy. */
export function isOccupying(proposal: Proposal): boolean {
  return proposal.abandonedAt === undefined && OCCUPYING_STATES.has(proposal.status)
}

/**
 * Derive the `(project, branch) → proposal` table. Proposal and feature
 * branches are both included: a feature branch name colliding with another
 * proposal's proposal branch is just as real a collision.
 */
export function deriveBranchOccupancy(
  proposals: readonly Proposal[],
  mainBranch: string,
): BranchOccupancy[] {
  const entries: BranchOccupancy[] = []
  for (const proposal of proposals) {
    if (!isOccupying(proposal)) continue
    for (const target of effectiveTargets(proposal, mainBranch)) {
      if (target.proposalBranch !== undefined && target.proposalBranch.trim() !== '') {
        entries.push({
          project: target.project,
          branch: target.proposalBranch,
          proposalId: proposal.id,
          kind: 'proposal',
        })
      }
      if (target.featureBranch !== undefined && target.featureBranch.trim() !== '') {
        entries.push({
          project: target.project,
          branch: target.featureBranch,
          proposalId: proposal.id,
          kind: 'feature',
        })
      }
    }
  }
  return entries.sort(
    (left, right) =>
      left.project.localeCompare(right.project) ||
      left.branch.localeCompare(right.branch) ||
      left.proposalId.localeCompare(right.proposalId),
  )
}

/** Group occupancy entries that share the same project + branch. */
export function findBranchConflicts(occupancy: readonly BranchOccupancy[]): BranchConflict[] {
  const groups = new Map<string, BranchConflict>()
  for (const entry of occupancy) {
    const key = `${entry.project}\u0000${entry.branch}`
    const existing = groups.get(key)
    if (existing === undefined) {
      groups.set(key, { project: entry.project, branch: entry.branch, proposalIds: [entry.proposalId] })
    } else if (!existing.proposalIds.includes(entry.proposalId)) {
      existing.proposalIds.push(entry.proposalId)
    }
  }
  return [...groups.values()]
    .filter((conflict) => conflict.proposalIds.length > 1)
    .map((conflict) => ({ ...conflict, proposalIds: [...conflict.proposalIds].sort() }))
    .sort((left, right) => left.project.localeCompare(right.project) || left.branch.localeCompare(right.branch))
}
