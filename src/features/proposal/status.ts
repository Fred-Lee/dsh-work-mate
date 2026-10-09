/**
 * Aggregated proposal status: proposal record + per-project facts. Every
 * associated project resolves its root through the registry (change
 * `add-multi-project-reopen-git-visibility`); an explicit single projectRoot
 * (tool arg / config default) keeps working and takes precedence for
 * backwards compatibility. Everything is optional except the record — the
 * status call must succeed on machines without git or without the projects.
 */
import { CONFIG_DEFAULTS } from '../../config.ts'
import type { Proposal } from './store.ts'
import type { AssociatedCommit, GitInfo, GitScanResult } from './git.ts'
import type { OpenspecChangeState } from './openspec.ts'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { getGitInfo, listProposalCommits } from './git.ts'
import { readChangeState, validateProjectRoot } from './openspec.ts'
import { STATE_HINTS, nextState, prevState } from './state-machine.ts'
import { parseReviewMd, reviewTally, type ReviewReport, type ReviewTally } from '../quality/review-parser.ts'
import type { ProposalService } from './service.ts'

export interface ProjectDetail {
  project: string
  root?: string
  git?: GitInfo
  commits?: AssociatedCommit[]
  openspec?: OpenspecChangeState
  /** Parsed `changes/<id>/review.md` (proposal-auditor artifact). */
  reviewReport?: ReviewReport
  /** Machine-readable severity tally of that report (change `add-review-tally`). */
  reviewTally?: ReviewTally
  note?: string
}

export interface ProposalStatus {
  proposal: Proposal
  /** Per-associated-project aggregation (registry-resolved roots). */
  projects: ProjectDetail[]
  /**
   * Lifecycle position derived from the eight-state chain — the client renders
   * its advance/rollback controls from this instead of copying the order.
   */
  lifecycle: { status: Proposal['status']; hint: string; prev?: Proposal['status']; next?: Proposal['status'] }
  /** Back-compat projection of the first resolved project. */
  openspec?: OpenspecChangeState
  commits?: AssociatedCommit[]
  gitNote?: string
  projectNote?: string
  /**
   * Set when the next state is gated on a human approval and the agent actor
   * therefore cannot advance (change `add-approval-records`).
   */
  pendingApproval?: { gate: Proposal['status']; reason: string }
  /** Gate approvals recorded so far. */
  approvals?: Proposal['approvals']
  /**
   * The most recent forced archive (change `harden-archive-gates`): a gate was skipped
   * by `force`, so the status must be able to say who decided it and which gates were
   * bypassed. Derived from the approval record; absent when the archive was not forced.
   */
  forcedArchive?: { at: string; actor: string; rationale?: string; gates?: string[] }
}

export interface StatusOptions {
  /** Legacy single-root override; wins over the registry. */
  projectRoot?: string
  openspecRoot: string
  /** Registry resolver: project name → root (undefined = unregistered). */
  resolveRoot?: (name: string) => Promise<string | undefined>
  /** Also parse `changes/<id>/review.md` per project (panel review report). */
  withReviewReport?: boolean
  /** States gated on a human approval (`Config.approvalsRequired`). */
  approvalsRequired?: string[]
  /** Set when the agent may cross gated states (`Config.allowAgentApproval`). */
  allowAgentApproval?: boolean
  /** Severities whose open findings block archiving (`Config.reviewBlockingSeverities`). */
  reviewBlockingSeverities?: string[]
}

export async function buildProposalStatus(
  service: ProposalService,
  id: string,
  options: StatusOptions,
): Promise<ProposalStatus> {
  const proposal = await service.get(id)
  if (!proposal) throw new Error(`proposal not found: ${id}`)

  const lifecycle = lifecycleOf(proposal.status)
  const gated =
    lifecycle.next !== undefined &&
    options.allowAgentApproval !== true &&
    (options.approvalsRequired ?? CONFIG_DEFAULTS.approvalsRequired).includes(lifecycle.next)
  const status: ProposalStatus = {
    proposal,
    projects: [],
    lifecycle,
    ...(gated && lifecycle.next !== undefined
      ? {
          pendingApproval: {
            gate: lifecycle.next,
            reason: `${lifecycle.next} 需要人工批准（写码者不得批准）：在面板点「推进」，或调整 Config.approvalsRequired`,
          },
        }
      : {}),
    ...(proposal.approvals !== undefined ? { approvals: proposal.approvals } : {}),
    ...(forcedArchiveOf(proposal) !== undefined ? { forcedArchive: forcedArchiveOf(proposal) as NonNullable<ProposalStatus['forcedArchive']> } : {}),
  }
  const associated = proposal.projects.length > 0 ? proposal.projects : []

  // Legacy single-root path: an explicit projectRoot behaves as one virtual
  // association so existing callers keep their shape.
  if (associated.length === 0 && options.projectRoot) {
    validateProjectRoot(options.projectRoot)
    const single = await collectProject(
      '(explicit)',
      options.projectRoot,
      options.openspecRoot,
      proposal.openspecChangeId,
      options.withReviewReport,
      options.reviewBlockingSeverities,
    )
    status.projects.push(single)
    Object.assign(status, projectProjection(single))
    return status
  }
  if (associated.length === 0) {
    status.projectNote = 'no associated projects — project-side facts skipped'
    return status
  }

  for (const name of associated) {
    let root: string | undefined
    if (options.projectRoot && associated.length === 1) {
      root = options.projectRoot
    } else if (options.resolveRoot !== undefined) {
      root = await options.resolveRoot(name)
    }
    if (options.projectRoot && root === undefined && associated.length === 1) {
      root = options.projectRoot
    }

    if (root === undefined) {
      status.projects.push({ project: name, note: '未在项目注册表中注册 — 无根目录，跳过 Git/OpenSpec 采集' })
      continue
    }
    validateProjectRoot(root)
    status.projects.push(
      await collectProject(
        name,
        root,
        options.openspecRoot,
        proposal.openspecChangeId,
        options.withReviewReport,
        options.reviewBlockingSeverities,
      ),
    )
  }

  const first = status.projects.find((detail) => detail.root !== undefined)
  if (first !== undefined) Object.assign(status, projectProjection(first))
  return status
}

/** Lifecycle projection: the client never copies the eight-state order. */
function lifecycleOf(status: Proposal['status']): ProposalStatus['lifecycle'] {
  const next = nextState(status)
  const prev = prevState(status)
  return {
    status,
    hint: STATE_HINTS[status],
    ...(prev !== undefined ? { prev } : {}),
    ...(next !== undefined ? { next } : {}),
  }
}

function projectProjection(detail: ProjectDetail): Partial<ProposalStatus> {  return {
    ...(detail.openspec !== undefined ? { openspec: detail.openspec } : {}),
    ...(detail.commits !== undefined ? { commits: detail.commits } : {}),
    ...(detail.git?.note !== undefined ? { gitNote: detail.git.note } : {}),
    ...(detail.root !== undefined ? { projectRoot: detail.root } : {}),
  }
}

/**
 * Read the review report from the active change dir; after archiving the
 * whole directory moves under `changes/archive/<date>-<id>/`, so fall back to
 * the archived location (the panel still shows the report on archived cards).
 */
async function readReviewReport(root: string, openspecRoot: string, changeId: string): Promise<string | undefined> {
  try {
    return await readFile(join(root, openspecRoot, 'changes', changeId, 'review.md'), 'utf8')
  } catch {
    // fall through to the archive location
  }
  try {
    const archiveDir = join(root, openspecRoot, 'changes', 'archive')
    const match = (await readdir(archiveDir)).find((entry) => entry.endsWith(`-${changeId}`))
    if (match !== undefined) {
      return await readFile(join(archiveDir, match, 'review.md'), 'utf8')
    }
  } catch {
    // no archive dir either
  }
  return undefined
}

async function collectProject(
  name: string,
  root: string,
  openspecRoot: string,
  changeId: string,
  withReviewReport?: boolean,
  reviewBlockingSeverities?: string[],
): Promise<ProjectDetail> {
  const detail: ProjectDetail = { project: name, root }
  const [git, gitScan, openspecState, reviewContent] = await Promise.all([
    getGitInfo(root).catch(() => undefined),
    listProposalCommits(root, changeId),
    readChangeState(root, openspecRoot, changeId),
    withReviewReport === true ? readReviewReport(root, openspecRoot, changeId) : Promise.resolve(undefined),
  ])
  if (git !== undefined) detail.git = git
  detail.commits = gitScan.commits
  if (gitScan.note !== undefined) detail.note = gitScan.note
  detail.openspec = openspecState
  if (reviewContent !== undefined) {
    const report = parseReviewMd(reviewContent)
    detail.reviewReport = report
    detail.reviewTally = reviewTally(report, reviewBlockingSeverities ?? CONFIG_DEFAULTS.reviewBlockingSeverities)
  }
  return detail
}

/**
 * Find the last forced-archive approval (change `harden-archive-gates`).
 * @param proposal - the aggregated record.
 * @returns the newest `force-archive` approval projected for the panel, or undefined.
 */
export function forcedArchiveOf(proposal: Proposal): ProposalStatus['forcedArchive'] {
  const matches = (proposal.approvals ?? []).filter(
    (record) => record.decision === 'approve' && record.forcedGates !== undefined && record.forcedGates.length > 0,
  )
  const last = matches.at(-1)
  if (last === undefined) return undefined
  return {
    at: last.at,
    actor: last.actor,
    ...(last.rationale !== undefined ? { rationale: last.rationale } : {}),
    ...(last.forcedGates !== undefined ? { gates: last.forcedGates } : {}),
  }
}
