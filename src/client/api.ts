/**
 * Browser-side REST client. Same-origin relative paths work both from the
 * standalone page (/workmate/) and inside the DSH shell (better-sidebar tab).
 */
import type { AggregateMetrics, BandsPayload, CreateProposalBody, Proposal, ProposalState, ProposalStatusPayload } from './types'
import type { ProposalEvent } from '../features/proposal/events.ts'
import type { PanelLane, PanelSubstate } from '../features/superagent/project.ts'
import type { TaskRecord } from '../features/task/files.ts'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const message =
      body !== null && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${response.status}`
    throw new Error(message)
  }
  return body as T
}

export function listProposals(): Promise<{ proposals: Proposal[] }> {
  return request('/workmate/api/proposals')
}

/**
 * `GET /metrics` answers `{metrics, skippedLines}` for a single proposal and
 * `{metrics}` for the aggregate; older hosts may answer the aggregate flat. Unwrap
 * defensively so a shape drift renders as empty data instead of a crash.
 */
export async function getMetrics(): Promise<AggregateMetrics> {
  const body = await request<AggregateMetrics | { metrics?: AggregateMetrics }>('/workmate/api/metrics')
  const metrics = (body as { metrics?: AggregateMetrics }).metrics
  return metrics ?? (body as AggregateMetrics)
}

export function getBands(): Promise<BandsPayload> {
  return request('/workmate/api/bands')
}

export function getProposal(id: string, projectRoot?: string): Promise<ProposalStatusPayload> {
  const query = projectRoot ? `?projectRoot=${encodeURIComponent(projectRoot)}` : ''
  return request(`/workmate/api/proposals/${encodeURIComponent(id)}${query}`)
}

export function createProposal(body: CreateProposalBody): Promise<{ proposal: Proposal; openspec?: { status: string; dir?: string }; note?: string }> {
  return request('/workmate/api/proposals', { method: 'POST', body: JSON.stringify(body) })
}

export function advanceProposal(id: string, rationale?: string): Promise<{ proposal: Proposal }> {
  return request(`/workmate/api/proposals/${encodeURIComponent(id)}/advance`, {
    method: 'POST',
    body: JSON.stringify(rationale !== undefined && rationale !== '' ? { rationale } : {}),
  })
}

/** Adjacent-state move (forward checks preconditions, backward is free). */
export function transitionProposal(id: string, to: ProposalState, rationale?: string): Promise<{ proposal: Proposal }> {
  return request(`/workmate/api/proposals/${encodeURIComponent(id)}/transition`, {
    method: 'POST',
    body: JSON.stringify({ to }),
  })
}

/**
 * Run the archive orchestration. `force` skips the review gate only
 * (missing review.md / unresolved CRITICAL) — never the CLI steps.
 */
export function archiveProposal(
  id: string,
  force = false,
  rationale?: string,
): Promise<{ proposal: Proposal; orchestration?: { ok: boolean; steps: Array<{ step: string; status: string; summary: string }> } }> {
  return request(`/workmate/api/proposals/${encodeURIComponent(id)}/archive`, {
    method: 'POST',
    body: JSON.stringify({ force, ...(rationale !== undefined && rationale.trim() !== '' ? { rationale } : {}) }),
  })
}

/** 撤销「终止」：把提案恢复到终止前的状态（change: 整体体检 #4）。 */
export function unabandonProposal(id: string): Promise<{ proposal: Proposal }> {
  return request(`/workmate/api/proposals/${encodeURIComponent(id)}/unabandon`, { method: 'POST', body: '{}' })
}

export function abandonProposal(id: string, reason: string): Promise<{ proposal: Proposal }> {
  return request(`/workmate/api/proposals/${encodeURIComponent(id)}/abandon`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  })
}

export interface RegisteredProject {
  name: string
  root: string
  defaultBranch?: string
  workspace?: string
}

export function listProjects(): Promise<{ projects: RegisteredProject[] }> {
  return request('/workmate/api/projects')
}

export function registerProject(
  name: string,
  root: string,
  options: { defaultBranch?: string; workspace?: string } = {},
): Promise<{ project: RegisteredProject }> {
  return request('/workmate/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name, root, ...options }),
  })
}

export interface ProjectBranches {
  current: string
  default?: string
  local: string[]
  remote: string[]
}

export function listProjectBranches(name: string): Promise<{ project: string; branches: ProjectBranches }> {
  return request(`/workmate/api/projects/${encodeURIComponent(name)}/branches`)
}

export interface WorkspaceCandidate {
  path: string
  title: string
  name: string
  suggestedName: string
  registered: boolean
  registeredAs?: string
  hasOpenspec: boolean
  workspace: string
}

export function listWorkspaceCandidates(): Promise<{
  candidates: WorkspaceCandidate[]
  note?: string
}> {
  return request('/workmate/api/projects/candidates')
}

export interface IsolationPayload {
  occupancy: Array<{ project: string; branch: string; proposalId: string; kind: 'proposal' | 'feature' }>
  conflicts: Array<{ project: string; branch: string; proposalIds: string[] }>
}

export function getIsolation(): Promise<IsolationPayload> {
  return request('/workmate/api/isolation')
}

export function approvePlan(id: string, rationale?: string): Promise<{ fingerprint: { hash?: string } }> {
  return request(`/workmate/api/proposals/${encodeURIComponent(id)}/plan-approve`, {
    method: 'POST',
    body: JSON.stringify(rationale !== undefined && rationale !== '' ? { rationale } : {}),
  })
}

export function reconcileProposal(id: string): Promise<{
  proposal: Proposal
  transitions: Array<{ from: ProposalState; to: ProposalState }>
  blocked?: string
}> {
  return request(`/workmate/api/proposals/${encodeURIComponent(id)}/reconcile`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
}


export function rejectMerge(
  id: string,
  category: 'plan' | 'implementation',
  rationale: string,
): Promise<{ approval: unknown; proposal: Proposal }> {
  return request(`/workmate/api/proposals/${encodeURIComponent(id)}/reject-merge`, {
    method: 'POST',
    body: JSON.stringify({ category, rationale }),
  })
}

export interface ProjectGitStatus {
  branch: string
  headShort: string
  dirtyCount: number
  isWorktree: boolean
}

export function getProjectStatus(name: string): Promise<{ project: string; status?: ProjectGitStatus }> {
  return request(`/workmate/api/projects/${encodeURIComponent(name)}/status`)
}

export interface ProposalEventRow {
  at: string
  kind: string
  from?: string
  to?: string
  actor: string
  gate?: string
  reason?: string
  detail?: string
}

export function listProposalEvents(id: string): Promise<{ events: ProposalEventRow[] }> {
  return request(`/workmate/api/proposals/${encodeURIComponent(id)}/events`)
}

/* ── 任务（change `adopt-superagent-openspec-source`） ───────────────────── */

/**
 * 单个执行器端点的健康（change `support-multi-repo-executors`）。
 *
 * 多端点部署时由服务端逐端点取 health 后聚合；单端点或旧服务端不提供
 * `TaskBoardView.endpoints`，此时面板仍读单值 `health`（兼容投影）。
 */
export interface TaskEndpointView {
  endpoint: string
  online: boolean
  reason?: string
  paused?: boolean
}

export interface TaskCardView {
  lane: PanelLane
  substate: PanelSubstate
  note?: string
  task: TaskRecord
  connectable: boolean
  /**
   * 待办的仓库不在「已接入执行器的仓库集合」内时，服务端给出该仓库。
   * 面板据此显示「未接入执行器（仓库 X）」；旧服务端不提供，回退 `task.repo`。
   */
  unservedRepo?: string
  ticket?: {
    id: string
    title: string
    stage?: string
    action?: string
    ended?: { outcome?: string }
    directory?: string
    summary?: string
  }
}

export interface TaskBoardView {
  cards: TaskCardView[]
  lanes: Record<PanelLane, TaskCardView[]>
  /** 单值健康（保留兼容）：单端点部署或旧服务端读它。 */
  health: { online: boolean; endpoint: string; reason?: string; paused?: boolean }
  /** 多端点部署的逐端点健康；单端点 / 旧服务端不提供。 */
  endpoints?: TaskEndpointView[]
  attention: number
  notes: string[]
}

export function getPanelConfig(): Promise<{ taskExecutor: 'superagent'; pollMs: number }> {
  return request('/workmate/api/config')
}

export function getTaskBoard(): Promise<TaskBoardView> {
  return request('/workmate/api/tasks')
}

export interface CreateTaskBody {
  intent: string
  repo?: string
  baseBranch?: string
  acceptance?: string
  priority?: 'P0' | 'P1' | 'P2'
  mode?: 'superagent' | 'proposal' | 'record'
  proposalId?: string
}

export function createTask(body: CreateTaskBody): Promise<{ task: TaskRecord }> {
  return request('/workmate/api/tasks', { method: 'POST', body: JSON.stringify(body) })
}

export function assignTask(id: string): Promise<{ task: TaskRecord }> {
  return request(`/workmate/api/tasks/${encodeURIComponent(id)}/assign`, { method: 'POST', body: '{}' })
}

export function retryTask(id: string): Promise<{ task: TaskRecord }> {
  return request(`/workmate/api/tasks/${encodeURIComponent(id)}/retry`, { method: 'POST', body: '{}' })
}

export function replyTask(id: string, text: string, replyTo?: string): Promise<{ seq: number }> {
  return request(`/workmate/api/tasks/${encodeURIComponent(id)}/reply`, {
    method: 'POST',
    body: JSON.stringify({ text, ...(replyTo !== undefined ? { replyTo } : {}) }),
  })
}

export function stopTask(id: string): Promise<{ task: TaskRecord; stopped?: string }> {
  return request(`/workmate/api/tasks/${encodeURIComponent(id)}/stop`, { method: 'POST', body: '{}' })
}

export function reopenTask(id: string): Promise<{ task: TaskRecord }> {
  return request(`/workmate/api/tasks/${encodeURIComponent(id)}/reopen`, { method: 'POST', body: '{}' })
}

export function listLeftoverWorktrees(): Promise<{ entries: Array<{ taskId: string; repo: string; directory: string; ticketId?: string }> }> {
  return request('/workmate/api/worktrees/leftover')
}

export function reclaimWorktree(taskId: string, options: { force?: boolean } = {}): Promise<unknown> {
  return request('/workmate/api/worktrees/reclaim', {
    method: 'POST',
    body: JSON.stringify({ taskId, ...(options.force === true ? { force: true } : {}) }),
  })
}
