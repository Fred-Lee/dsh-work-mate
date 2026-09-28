/**
 * Aggregated proposal status: proposal record + per-project facts. Every
 * associated project resolves its root through the registry (change
 * `add-multi-project-reopen-git-visibility`); an explicit single projectRoot
 * (tool arg / config default) keeps working and takes precedence for
 * backwards compatibility. Everything is optional except the record — the
 * status call must succeed on machines without git or without the projects.
 */
import type { Proposal } from './store.ts'
import type { AssociatedCommit, GitInfo, GitScanResult } from './git.ts'
import type { OpenspecChangeState } from './openspec.ts'
import { getGitInfo, listProposalCommits } from './git.ts'
import { readChangeState, validateProjectRoot } from './openspec.ts'
import type { ProposalService } from './service.ts'

export interface ProjectDetail {
  project: string
  root?: string
  git?: GitInfo
  commits?: AssociatedCommit[]
  openspec?: OpenspecChangeState
  note?: string
}

export interface ProposalStatus {
  proposal: Proposal
  /** Per-associated-project aggregation (registry-resolved roots). */
  projects: ProjectDetail[]
  /** Back-compat projection of the first resolved project. */
  openspec?: OpenspecChangeState
  commits?: AssociatedCommit[]
  gitNote?: string
  projectNote?: string
}

export interface StatusOptions {
  /** Legacy single-root override; wins over the registry. */
  projectRoot?: string
  openspecRoot: string
  /** Registry resolver: project name → root (undefined = unregistered). */
  resolveRoot?: (name: string) => Promise<string | undefined>
}

export async function buildProposalStatus(
  service: ProposalService,
  id: string,
  options: StatusOptions,
): Promise<ProposalStatus> {
  const proposal = await service.get(id)
  if (!proposal) throw new Error(`proposal not found: ${id}`)

  const status: ProposalStatus = { proposal, projects: [] }
  const associated = proposal.projects.length > 0 ? proposal.projects : []

  // Legacy single-root path: an explicit projectRoot behaves as one virtual
  // association so existing callers keep their shape.
  if (associated.length === 0 && options.projectRoot) {
    validateProjectRoot(options.projectRoot)
    const single = await collectProject('(explicit)', options.projectRoot, options.openspecRoot, proposal.openspecChangeId)
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
    status.projects.push(await collectProject(name, root, options.openspecRoot, proposal.openspecChangeId))
  }

  const first = status.projects.find((detail) => detail.root !== undefined)
  if (first !== undefined) Object.assign(status, projectProjection(first))
  return status
}

function projectProjection(detail: ProjectDetail): Partial<ProposalStatus> {
  return {
    ...(detail.openspec !== undefined ? { openspec: detail.openspec } : {}),
    ...(detail.commits !== undefined ? { commits: detail.commits } : {}),
    ...(detail.git?.note !== undefined ? { gitNote: detail.git.note } : {}),
    ...(detail.root !== undefined ? { projectRoot: detail.root } : {}),
  }
}

async function collectProject(
  name: string,
  root: string,
  openspecRoot: string,
  changeId: string,
): Promise<ProjectDetail> {
  const detail: ProjectDetail = { project: name, root }
  const [git, gitScan, openspecState] = await Promise.all([
    getGitInfo(root).catch(() => undefined),
    listProposalCommits(root, changeId),
    readChangeState(root, openspecRoot, changeId),
  ])
  if (git !== undefined) detail.git = git
  detail.commits = gitScan.commits
  if (gitScan.note !== undefined) detail.note = gitScan.note
  detail.openspec = openspecState
  return detail
}
