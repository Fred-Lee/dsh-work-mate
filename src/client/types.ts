/** Shared REST payload types for the client half (design D5 of the change). */

export interface DecisionEntry {
  id: string
  decision: string
  rationale: string
  supersedes?: string
  at: string
}

export interface BlockerEntry {
  id: string
  question: string
  tried?: string
  answer?: string
  status: 'open' | 'resolved'
  at: string
  answeredAt?: string
}

export type ProposalState =
  | 'draft'
  | 'proposing'
  | 'reviewing'
  | 'ready'
  | 'implementing'
  | 'merging'
  | 'archiving'
  | 'archived'

export interface WikiLinkEntry {
  url: string
  pageType: 'concept' | 'synthesis' | 'entity'
  version?: number
  commit?: string
  taskId?: string
  registeredAt: string
}

export interface Proposal {
  id: string
  title: string
  status: ProposalState
  projects: string[]
  commits: string[]
  openspecChangeId: string
  decisions?: DecisionEntry[]
  blockers?: BlockerEntry[]
  wikiLinks?: WikiLinkEntry[]
  worktreePath?: string
  portRange?: number[]
  featureBranch?: string
  proposalBranch?: string
  createdAt: string
  updatedAt: string
}

export interface AssociatedCommit {
  hash: string
  short: string
  subject: string
}

export interface ProjectGitInfo {
  branch: string
  headShort: string
  dirtyCount: number
  isWorktree: boolean
  note?: string
}

export interface CriticalIssue {
  text: string
  resolved: boolean
}

export interface ReviewReport {
  confirms: string[]
  questions: string[]
  suggestions: string[]
  criticals: CriticalIssue[]
}

export interface ProjectDetail {
  project: string
  root?: string
  git?: ProjectGitInfo
  commits?: AssociatedCommit[]
  openspec?: { state: 'active' | 'archived' | 'missing'; tasks?: { done: number; total: number } }
  reviewReport?: ReviewReport
  note?: string
}

export interface ProposalStatusPayload {
  proposal: Proposal
  projects?: ProjectDetail[]
  openspec?: { state: 'active' | 'archived' | 'missing'; tasks?: { done: number; total: number } }
  commits?: AssociatedCommit[]
  gitNote?: string
  projectNote?: string
}

export interface CreateProposalBody {
  /** Optional: auto-generated host-side when omitted (chat entry only asks for a title). */
  id?: string
  title: string
  projects?: string[]
  projectRoot?: string
}
