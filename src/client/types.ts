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

export interface SwarmTaskRecord {
  id: string
  title: string
  writes: string[]
  branch?: string
  worktreePath?: string
  portRange?: number[]
  status: 'planned' | 'running' | 'merged' | 'failed'
  startedAt?: string
  mergedAt?: string
  commit?: string
  note?: string
}

export interface DriftReport {
  declared: string[]
  actual: string[]
  undeclared: string[]
  missing: string[]
  driftRatio: number
  note?: string
}

export interface ArtifactRecord {
  path: string
  sha256?: string
  bytes?: number
  commit?: string
  note?: string
}

export interface ArchiveManifestEntry {
  project: string
  root: string
  commits: string[]
  diffStat?: string
  specsUpdated?: boolean
  reindexed: boolean
  archivedChangeDir?: string
  note?: string
  drift?: DriftReport
  artifacts?: ArtifactRecord[]
}

export interface ArchiveManifest {
  at: string
  projects: ArchiveManifestEntry[]
}

export interface ApprovalRecord {
  gate: ProposalState
  actor: 'human' | 'system'
  decision: 'approve' | 'reject'
  rationale?: string
  at: string
  commit?: string
}

export interface ProposalTarget {
  project: string
  baseBranch: string
  baseCommit?: string
  proposalBranch?: string
  featureBranch?: string
  worktreePath?: string
  portRange?: number[]
}

export interface Proposal {
  id: string
  title: string
  status: ProposalState
  projects: string[]
  targets?: ProposalTarget[]
  primaryProject?: string
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
  /** Delivery summary of a successful archive run. */
  archiveManifest?: ArchiveManifest
  /** Per-task parallel carriers. */
  swarmTasks?: SwarmTaskRecord[]
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

export interface ReviewTally {
  bySeverity: Record<string, { total: number; open: number }>
  findings: number
  open: number
  blocking: number
  reviewer?: string
  shadow: boolean
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
  reviewTally?: ReviewTally
  note?: string
}

/** Lifecycle position as projected by the host (single source: state-machine.ts). */
export interface LifecycleInfo {
  status: ProposalState
  hint: string
  prev?: ProposalState
  next?: ProposalState
}

/** Set when the next state waits for a human approval (separation of duties). */
export interface PendingApproval {
  gate: ProposalState
  reason: string
}

export interface ProposalStatusPayload {
  proposal: Proposal
  projects?: ProjectDetail[]
  lifecycle?: LifecycleInfo
  pendingApproval?: PendingApproval
  approvals?: ApprovalRecord[]
  openspec?: { state: 'active' | 'archived' | 'missing'; tasks?: { done: number; total: number } }
  commits?: AssociatedCommit[]
  gitNote?: string
  projectNote?: string
}

/** One row of the aggregate metric projection (control room). */
export interface ProposalMetricRow {
  id: string
  title: string
  status: ProposalState
  archived: boolean
  currentStateMs: number
  cycleTimeMs?: number
  reworkCount: number
  gateFailureCount: number
  openBlockers: number
  decisions: number
  approvals: number
}

export interface AggregateMetrics {
  proposals: number
  byState: Record<string, number>
  averageTimeInStateMs: Record<string, number>
  cycleTimeMedianMs?: number
  archived7d: number
  archived30d: number
  reworkRate: number
  firstPassRate: number
  gateFailureRanking: Array<{ gate: string; count: number }>
  actorShare: { agent: number; human: number; system: number }
  perProposal: ProposalMetricRow[]
  events: number
  skippedLines: number
}

export interface BandEvaluation {
  metric: string
  direction: 'high' | 'low'
  status: 'ok' | 'insufficient-data'
  tier: 'normal' | 'log' | 'diagnose' | 'propose'
  action: string
  current: number
  baseline: number
  sigma: number
  deviation: number
  samples: number
  baselineSamples: number
  note?: string
}

export interface BandsPayload {
  evaluations: BandEvaluation[]
  windowDays: number
}

export interface CreateProposalBody {
  /** Optional: auto-generated host-side when omitted (chat entry only asks for a title). */
  id?: string
  title: string
  projects?: string[]
  targets?: ProposalTarget[]
  primaryProject?: string
  projectRoot?: string
}
