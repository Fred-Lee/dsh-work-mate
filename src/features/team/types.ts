/** Team vocabulary (change `autonomous-agent-team`, design D1/D3). */

export const TEAM_ROLES = [
  'coordinator',
  'requirement-evaluator',
  'solution-evaluator',
  'frontend-dev',
  'backend-dev',
  'integration-tester',
  'reviewer',
] as const

export type TeamRole = (typeof TEAM_ROLES)[number]

export const TEAM_TEMPLATES = ['requirement-full', 'bug-fix', 'research', 'delivery'] as const
export type TeamTemplate = (typeof TEAM_TEMPLATES)[number]

export const TEAM_ARTIFACTS = ['REQ.md', 'PLAN.md', 'TASKS.json', 'TEST.md', 'TEAM-REVIEW.md', 'SUMMARY.md'] as const
export type TeamArtifact = (typeof TEAM_ARTIFACTS)[number]

export type TeamTaskStatus = 'planned' | 'dispatched' | 'running' | 'done' | 'failed' | 'blocked'
export type TeamRunStatus = 'planned' | 'running' | 'succeeded' | 'partial' | 'blocked' | 'aborted'
export type TeamDispatchStatus = 'dispatched' | 'running' | 'done' | 'failed' | 'blocked' | 'abandoned'

/** One `TASKS.json` entry: the unit the coordinator dispatches. */
export interface TeamTaskSpec {
  id: string
  title: string
  role: TeamRole
  /** Registered project name the task writes in. */
  project: string
  /** Declared write scopes; empty means "not declared". */
  writes: string[]
  /** Task ids that must settle before this one is dispatched. */
  dependsOn: string[]
  /** Observable acceptance criterion (checked by the worker and the reviewer). */
  acceptance: string
}

export interface TeamTaskRecord extends TeamTaskSpec {
  status: TeamTaskStatus
  attempts: number
  dispatchId?: string
}

export interface TeamDispatch {
  id: string
  taskId: string
  role: TeamRole
  /** Native session/subagent id the dispatch runs in. */
  sessionId?: string
  status: TeamDispatchStatus
  startedAt?: string
  endedAt?: string
  /** Terminal outcome summary; never a substitute for artifacts. */
  outcome?: string
  reportPath?: string
  filesModified?: string[]
}

export type InboxKind = 'worker_done' | 'question' | 'escalation' | 'reply' | 'ack'
export type InboxStatus = 'open' | 'answered' | 'acked' | 'closed'

export interface InboxMessage {
  id: string
  runId: string
  taskId?: string
  kind: InboxKind
  body: string
  at: string
  status: InboxStatus
  reply?: string
  replyAt?: string
}

export interface TeamBudget {
  maxParallel: number
  maxAttempts: number
  maxDurationMs: number
  maxTokens: number
  maxDispatches: number
}

/** Defaults confirmed by the user: 3 parallel, 2 attempts, 2h/300k/20. */
export const DEFAULT_TEAM_BUDGET: TeamBudget = {
  maxParallel: 3,
  maxAttempts: 2,
  maxDurationMs: 2 * 60 * 60 * 1000,
  maxTokens: 300_000,
  maxDispatches: 20,
}

export const isTeamRole = (value: unknown): value is TeamRole =>
  typeof value === 'string' && (TEAM_ROLES as readonly string[]).includes(value)

export const isTeamTemplate = (value: unknown): value is TeamTemplate =>
  typeof value === 'string' && (TEAM_TEMPLATES as readonly string[]).includes(value)


/** One team execution run; persisted at `$DSH_HOME/workmate/team-runs.json`. */
export interface TeamRun {
  id: string
  proposalId: string
  template: TeamTemplate
  status: TeamRunStatus
  /** Native session the coordinator runs in (opened by the user when needed). */
  coordinatorSessionId?: string
  tasks: TeamTaskRecord[]
  dispatches?: TeamDispatch[]
  /** Persisted questions/escalations; the inbox survives a host restart. */
  inbox?: InboxMessage[]
  /** Only accumulated when the host reports usage; undefined means unmeasured. */
  tokensUsed?: number
  budget: TeamBudget
  createdAt: string
  updatedAt: string
}
