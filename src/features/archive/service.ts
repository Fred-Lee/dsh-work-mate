/**
 * Archive state machine (M2 semantics): proposals move along
 * `draft → executing → archived` with validation. Milestone M4 replaces the
 * internals of the archive call with full orchestration (tasks parsing →
 * swarm → openspec archive CLI → gitnexus analyze) behind the same signature.
 */
import type { Proposal } from '../proposal/store.ts'
import type { ProposalService } from '../proposal/service.ts'
import type { OrchestrationResult, OrchestrationTarget } from './orchestrate.ts'
import { orchestrateReopen } from './orchestrate.ts'

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
  /** Resolves the proposal's associated project names into per-project roots. */
  resolveProjectRoots?(proposal: Proposal): Promise<OrchestrationTarget[]>
  /**
   * M4 orchestration: when present, archive runs the full pipeline against
   * the resolvable targets and only stamps `archived` on success.
   */
  orchestrate?(
    proposal: Proposal,
    targets: OrchestrationTarget[],
    options: { openspecRoot: string },
  ): Promise<OrchestrationResult>
  /** Reverse orchestration (archive dir moved back). */
  orchestrateReopen?(
    proposal: Proposal,
    targets: OrchestrationTarget[],
    options: { openspecRoot: string },
  ): Promise<OrchestrationResult>
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
   * `executing → archived`. With an orchestrator wired and a resolvable
   * projectRoot this runs the full M4 pipeline (tasks snapshot → swarm →
   * openspec archive → gitnexus analyze) and stamps `archived` only on
   * success; the M2 state-machine path remains for headless proposals.
   */
  private async resolveTargets(
    proposal: Proposal,
    explicitRoot?: string,
  ): Promise<OrchestrationTarget[]> {
    if (explicitRoot !== undefined) {
      return [{ project: '(explicit)', root: explicitRoot }]
    }
    if (this.deps.resolveProjectRoots !== undefined) {
      return this.deps.resolveProjectRoots(proposal)
    }
    return []
  }

  async archive(
    id: string,
    options: ArchiveCheckOptions & { force?: boolean } = { openspecRoot: 'openspec' },
  ): Promise<Proposal | (Proposal & { orchestration: OrchestrationResult })> {
    const proposal = await this.mustGet(id)
    if (proposal.status === 'draft') {
      throw new InvalidTransitionError(
        `proposal ${id} is draft — move it to executing before archiving`,
      )
    }
    if (proposal.status === 'archived') return proposal

    const { projectRoot, openspecRoot, force } = options
    if (this.deps.orchestrate && force !== true) {
      const targets = await this.resolveTargets(proposal, projectRoot)
      const orchestration = await this.deps.orchestrate(proposal, targets, { openspecRoot })
      if (!orchestration.ok) {
        // pipeline failed: state untouched, caller inspects the step log
        return Object.assign(proposal, { orchestration })
      }
      return { ...(await this.writeStatus(proposal, 'archived')), orchestration }
    }

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

  /**
   * `executing → draft` (change make-lifecycle-fully-reversible): the reverse
   * of `start`. No project-side action — the change directory never moved.
   */
  async stop(id: string): Promise<Proposal> {
    const proposal = await this.mustGet(id)
    if (proposal.status !== 'executing') {
      throw new InvalidTransitionError(`only executing proposals can stop, ${id} is ${proposal.status}`)
    }
    return this.writeStatus(proposal, 'draft')
  }

  /**
   * `archived → executing` (change add-multi-project-reopen-git-visibility):
   * reverse the per-project directory moves where possible — a failed move
   * never blocks the state rollback.
   */
  async reopen(
    id: string,
    options: { openspecRoot: string } = { openspecRoot: 'openspec' },
  ): Promise<Proposal & { orchestration: OrchestrationResult }> {
    const proposal = await this.mustGet(id)
    if (proposal.status !== 'archived') {
      throw new InvalidTransitionError(`only archived proposals can reopen, ${id} is ${proposal.status}`)
    }
    const targets = await this.resolveTargets(proposal)
    const orchestration =
      this.deps.orchestrateReopen !== undefined
        ? await this.deps.orchestrateReopen(proposal, targets, options)
        : { ok: true, steps: [{ step: 'reopen-dir' as const, status: 'skipped' as const, summary: 'no reopen orchestration wired' }] }
    return { ...(await this.writeStatus(proposal, 'executing')), orchestration }
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
