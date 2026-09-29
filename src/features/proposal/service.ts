/**
 * The `workmate.proposal` service (design D2): the change-proposal middle
 * layer's domain face. M1 ships create-or-update / read; OpenSpec directory
 * generation, `[proposal:<id>]` commit association and the tool registration
 * arrive with M2.
 */
import { ProposalStore, type BlockerEntry, type DecisionEntry, type Proposal } from './store.ts'

export interface UpsertProposalInput {
  id: string
  title: string
  projects?: string[]
  /**
   * OpenSpec change directory name; defaults to the proposal id so that
   * `workmate_proposal_create` can seed `openspec/changes/<id>/` (M2).
   */
  openspecChangeId?: string
}

export interface AddDecisionInput {
  decision: string
  rationale: string
  /** Explicitly overturned earlier entry; must exist. */
  supersedes?: string
}

export interface BlockInput {
  question: string
  tried?: string
}

export interface ProposalService {
  rootDir(): string
  list(): Promise<Proposal[]>
  get(id: string): Promise<Proposal | undefined>
  upsert(input: UpsertProposalInput): Promise<Proposal>
  /** Transition `status` (draft/executing/archived) with a single read-modify-write. */
  setStatus(id: string, status: Proposal['status']): Promise<Proposal>
  /** Append a materialized decision; `supersedes` must reference an existing entry. */
  addDecision(id: string, input: AddDecisionInput): Promise<DecisionEntry>
  /** Escalate a blocker (open) — the finite human round-trip replaces endless thinking. */
  block(id: string, input: BlockInput): Promise<BlockerEntry>
  /** Answer and resolve one blocker. */
  unblock(id: string, blockerId: string, answer: string): Promise<BlockerEntry>
}

export class ProposalServiceImpl implements ProposalService {
  constructor(
    private readonly store: ProposalStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  rootDir(): string {
    return this.store.rootDir
  }

  list(): Promise<Proposal[]> {
    return this.store.load()
  }

  async get(id: string): Promise<Proposal | undefined> {
    return (await this.store.load()).find((proposal) => proposal.id === id)
  }

  async upsert(input: UpsertProposalInput): Promise<Proposal> {
    const id = input.id.trim()
    if (!id) throw new Error('proposal id must be a non-empty string')

    const proposals = await this.store.load()
    const timestamp = this.now().toISOString()
    const existing = proposals.find((proposal) => proposal.id === id)

    if (existing) {
      existing.title = input.title
      if (input.projects !== undefined) existing.projects = [...input.projects]
      if (input.openspecChangeId !== undefined) existing.openspecChangeId = input.openspecChangeId
      existing.updatedAt = timestamp
      await this.store.save(proposals)
      return existing
    }

    const created: Proposal = {
      id,
      title: input.title,
      status: 'draft',
      projects: input.projects ? [...input.projects] : [],
      commits: [],
      openspecChangeId: input.openspecChangeId ?? id,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    proposals.push(created)
    await this.store.save(proposals)
    return created
  }

  async addDecision(id: string, input: AddDecisionInput): Promise<DecisionEntry> {
    const decision = input.decision.trim()
    const rationale = input.rationale.trim()
    if (!decision) throw new Error('decision must be a non-empty string')
    if (!rationale) throw new Error('rationale must be a non-empty string')

    const proposals = await this.store.load()
    const existing = proposals.find((proposal) => proposal.id === id)
    if (!existing) throw new Error(`proposal not found: ${id}`)
    if (input.supersedes !== undefined) {
      const superseded = (existing.decisions ?? []).some((entry) => entry.id === input.supersedes)
      if (!superseded) {
        throw new Error(`supersedes '${input.supersedes}' does not reference an existing decision of ${id}`)
      }
    }

    const entry: DecisionEntry = {
      id: `decision-${(existing.decisions ?? []).length + 1}`,
      decision,
      rationale,
      at: this.now().toISOString(),
      ...(input.supersedes !== undefined ? { supersedes: input.supersedes } : {}),
    }
    existing.decisions = [...(existing.decisions ?? []), entry]
    existing.updatedAt = entry.at
    await this.store.save(proposals)
    return entry
  }

  async block(id: string, input: BlockInput): Promise<BlockerEntry> {
    const question = input.question.trim()
    if (!question) throw new Error('question must be a non-empty string')

    const proposals = await this.store.load()
    const existing = proposals.find((proposal) => proposal.id === id)
    if (!existing) throw new Error(`proposal not found: ${id}`)

    const entry: BlockerEntry = {
      id: `blocker-${(existing.blockers ?? []).length + 1}`,
      question,
      status: 'open',
      at: this.now().toISOString(),
      ...(input.tried !== undefined && input.tried.trim() !== '' ? { tried: input.tried.trim() } : {}),
    }
    existing.blockers = [...(existing.blockers ?? []), entry]
    existing.updatedAt = entry.at
    await this.store.save(proposals)
    return entry
  }

  async unblock(id: string, blockerId: string, answer: string): Promise<BlockerEntry> {
    const trimmed = answer.trim()
    if (!trimmed) throw new Error('answer must be a non-empty string')

    const proposals = await this.store.load()
    const existing = proposals.find((proposal) => proposal.id === id)
    if (!existing) throw new Error(`proposal not found: ${id}`)
    const blocker = (existing.blockers ?? []).find((entry) => entry.id === blockerId)
    if (!blocker) throw new Error(`blocker not found: ${blockerId}`)
    if (blocker.status === 'resolved') throw new Error(`blocker ${blockerId} is already resolved`)

    blocker.status = 'resolved'
    blocker.answer = trimmed
    blocker.answeredAt = this.now().toISOString()
    existing.updatedAt = blocker.answeredAt
    await this.store.save(proposals)
    return blocker
  }

  async setStatus(id: string, status: Proposal['status']): Promise<Proposal> {
    const proposals = await this.store.load()
    const existing = proposals.find((proposal) => proposal.id === id)
    if (!existing) throw new Error(`proposal not found: ${id}`)
    existing.status = status
    existing.updatedAt = this.now().toISOString()
    await this.store.save(proposals)
    return existing
  }
}
