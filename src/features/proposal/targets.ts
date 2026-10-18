/**
 * Proposal targets: the per-project carriers introduced by
 * `multiproject-branch-workbench` (design D1/D3).
 *
 * `targets` is authoritative when present; `effectiveTargets` projects legacy
 * single-target proposals (scalar worktreePath/proposalBranch/featureBranch)
 * onto one synthesized target so every reader has the same shape without a
 * data migration. Pure functions only — no git, no filesystem.
 */
import type { Proposal, ProposalTarget } from './store.ts'

export type TargetProjection = Pick<
  Proposal,
  'targets' | 'projects' | 'proposalBranch' | 'featureBranch' | 'worktreePath' | 'portRange'
>

const requireToken = (value: string, field: string): string => {
  const trimmed = value.trim()
  if (trimmed === '') throw new Error(`${field} must be a non-empty string`)
  if (/\s/.test(trimmed)) throw new Error(`${field} must not contain whitespace`)
  return trimmed
}

const optionalToken = (value: string | undefined, field: string): string | undefined =>
  value === undefined ? undefined : requireToken(value, field)

/** Validate and copy targets for persistence. Duplicate projects are rejected. */
export function normalizeTargets(targets: readonly ProposalTarget[]): ProposalTarget[] {
  const seen = new Set<string>()
  return targets.map((target) => {
    const project = requireToken(target.project, 'target.project')
    if (seen.has(project)) throw new Error(`duplicate target project: ${project}`)
    seen.add(project)
    const baseBranch = requireToken(target.baseBranch, `target ${project}.baseBranch`)
    const next: ProposalTarget = { project, baseBranch }
    const baseCommit = optionalToken(target.baseCommit, `target ${project}.baseCommit`)
    const proposalBranch = optionalToken(target.proposalBranch, `target ${project}.proposalBranch`)
    const featureBranch = optionalToken(target.featureBranch, `target ${project}.featureBranch`)
    if (baseCommit !== undefined) next.baseCommit = baseCommit
    if (proposalBranch !== undefined) next.proposalBranch = proposalBranch
    if (featureBranch !== undefined) next.featureBranch = featureBranch
    if (target.worktreePath !== undefined) next.worktreePath = target.worktreePath
    if (target.portRange !== undefined) next.portRange = [...target.portRange]
    return next
  })
}

/**
 * Effective targets for a proposal: explicit `targets` win; otherwise a legacy
 * single-target proposal projects its scalar carrier fields onto one target.
 * Headless proposals (no associated project) return an empty list.
 */
export function effectiveTargets(proposal: TargetProjection, mainBranch: string): ProposalTarget[] {
  if (proposal.targets !== undefined && proposal.targets.length > 0) {
    return proposal.targets.map((target) => ({
      ...target,
      ...(target.portRange !== undefined ? { portRange: [...target.portRange] } : {}),
    }))
  }
  const project = proposal.projects[0]
  if (project === undefined || project.trim() === '') return []
  const target: ProposalTarget = { project, baseBranch: mainBranch }
  if (proposal.proposalBranch !== undefined) target.proposalBranch = proposal.proposalBranch
  if (proposal.featureBranch !== undefined) target.featureBranch = proposal.featureBranch
  if (proposal.worktreePath !== undefined) target.worktreePath = proposal.worktreePath
  if (proposal.portRange !== undefined) target.portRange = [...proposal.portRange]
  return [target]
}


/**
 * Parse the compact tool/CLI spelling: `project:branch,project2:branch2`.
 * Empty entries are ignored; a missing project or branch is rejected.
 */
export function parseTargetsSpec(spec: string): ProposalTarget[] {
  const entries = spec
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
  return entries.map((entry) => {
    const separator = entry.indexOf(':')
    if (separator <= 0 || separator === entry.length - 1) {
      throw new Error(`invalid target '${entry}' — expected project:branch`)
    }
    return {
      project: entry.slice(0, separator).trim(),
      baseBranch: entry.slice(separator + 1).trim(),
    }
  })
}
