/**
 * The `workmate.proposal` service (design D2): the change-proposal middle
 * layer's domain face. M1 ships create-or-update / read; OpenSpec directory
 * generation, `[proposal:<id>]` commit association and the tool registration
 * arrive with M2.
 */
import { ProposalStore, type Proposal } from './store.ts'

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

export interface ProposalService {
  rootDir(): string
  list(): Promise<Proposal[]>
  get(id: string): Promise<Proposal | undefined>
  upsert(input: UpsertProposalInput): Promise<Proposal>
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
}
