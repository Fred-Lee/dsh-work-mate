/** Shared REST payload types for the client half (design D5 of the change). */

export interface Proposal {
  id: string
  title: string
  status: 'draft' | 'executing' | 'archived'
  projects: string[]
  commits: string[]
  openspecChangeId: string
  createdAt: string
  updatedAt: string
}

export interface AssociatedCommit {
  hash: string
  short: string
  subject: string
}

export interface ProposalStatusPayload {
  proposal: Proposal
  openspec?: { state: 'active' | 'archived' | 'missing'; tasks?: { done: number; total: number } }
  commits?: AssociatedCommit[]
  gitNote?: string
  projectNote?: string
}

export interface CreateProposalBody {
  id: string
  title: string
  projects?: string[]
  projectRoot?: string
}
