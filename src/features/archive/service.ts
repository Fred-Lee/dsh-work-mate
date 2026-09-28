/**
 * Archive state machine (M2 semantics): proposals move along
 * `draft → executing → archived` with validation. Milestone M4 replaces the
 * internals of the archive call with full orchestration (tasks parsing →
 * swarm → openspec archive CLI → gitnexus analyze) behind the same signature.
 */
import type { Proposal } from '../proposal/store.ts'
import type { ProposalService } from '../proposal/service.ts'

export class InvalidTransitionError extends Error {
  readonly code = 'INVALID_TRANSITION'
  constructor(message: string) {
    super(message)
    this.name = 'InvalidTransitionError'
  }
}

export interface ArchiveCheckOptions {
  projectRoot?: string
  openspecRoot: string
}

export interface ArchiveServiceDeps {
  proposals: ProposalService
  /** Returns true when `openspec/changes/<id>` (or its archive) exists. */
  changeDirExists?(projectRoot: string, openspecRoot: string, changeId: string): Promise<boolean>
  now?: () => Date
}

export class ArchiveServiceImpl {
  constructor(private readonly deps: ArchiveServiceDeps) {}

  async list(): Promise<Proposal[]> {
    return this.deps.proposals.list()
  }

  /** `draft → executing`. */
  async start(id: string): Promise<Proposal> {
    const proposal = await this.mustGet(id)
    if (proposal.status !== 'draft') {
      throw new InvalidTransitionError(`only draft proposals can start, ${id} is ${proposal.status}`)
    }
    return this.writeStatus(proposal, 'executing')
  }

  /**
   * `executing → archived`. Without a resolvable projectRoot the OpenSpec
   * check is skipped (the proposal may have been created headlessly); with a
   * root, a missing change directory refuses archival unless forced.
   */
  async archive(
    id: string,
    options: ArchiveCheckOptions & { force?: boolean } = { openspecRoot: 'openspec' },
  ): Promise<Proposal> {
    const proposal = await this.mustGet(id)
    if (proposal.status === 'draft') {
      throw new InvalidTransitionError(
        `proposal ${id} is draft — move it to executing before archiving`,
      )
    }
    if (proposal.status === 'archived') return proposal

    const { projectRoot, openspecRoot, force } = options
    if (projectRoot && this.deps.changeDirExists) {
      const exists = await this.deps.changeDirExists(projectRoot, openspecRoot, proposal.openspecChangeId)
      if (!exists && !force) {
        throw new InvalidTransitionError(
          `openspec change '${proposal.openspecChangeId}' not found under ${projectRoot} — pass force: true to archive anyway`,
        )
      }
    }
    return this.writeStatus(proposal, 'archived')
  }

  private async mustGet(id: string): Promise<Proposal> {
    const proposal = await this.deps.proposals.get(id)
    if (!proposal) throw new Error(`proposal not found: ${id}`)
    return proposal
  }

  private async writeStatus(proposal: Proposal, status: Proposal['status']): Promise<Proposal> {
    return this.deps.proposals.setStatus(proposal.id, status)
  }
}
