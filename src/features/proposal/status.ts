/**
 * Aggregated proposal status: proposal record + associated commits + OpenSpec
 * change state. Everything is optional except the record itself — the status
 * call must succeed on machines without git or without the project checkout.
 */
import type { Proposal } from './store.ts'
import type { AssociatedCommit, GitScanResult } from './git.ts'
import type { OpenspecChangeState } from './openspec.ts'
import { listProposalCommits } from './git.ts'
import { readChangeState, validateProjectRoot } from './openspec.ts'
import type { ProposalService } from './service.ts'

export interface ProposalStatus {
  proposal: Proposal
  openspec?: OpenspecChangeState
  commits?: AssociatedCommit[]
  gitNote?: string
  projectNote?: string
}

export interface StatusOptions {
  projectRoot?: string
  openspecRoot: string
}

export async function buildProposalStatus(
  service: ProposalService,
  id: string,
  options: StatusOptions,
): Promise<ProposalStatus> {
  const proposal = await service.get(id)
  if (!proposal) throw new Error(`proposal not found: ${id}`)

  const projectRoot = options.projectRoot
  if (!projectRoot) {
    return { proposal, projectNote: 'no projectRoot — project-side facts skipped' }
  }

  validateProjectRoot(projectRoot)
  const status: ProposalStatus = { proposal }

  const [gitResult, openspecState]: [GitScanResult, OpenspecChangeState] = await Promise.all([
    listProposalCommits(projectRoot, proposal.id),
    readChangeState(projectRoot, options.openspecRoot, proposal.openspecChangeId),
  ])
  status.commits = gitResult.commits
  if (gitResult.note) status.gitNote = gitResult.note
  status.openspec = openspecState
  return status
}
