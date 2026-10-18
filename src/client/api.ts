/**
 * Browser-side REST client. Same-origin relative paths work both from the
 * standalone page (/workmate/) and inside the DSH shell (better-sidebar tab).
 */
import type { AggregateMetrics, BandsPayload, CreateProposalBody, Proposal, ProposalState, ProposalStatusPayload } from './types'
import type { ProposalEvent } from '../features/proposal/events.ts'
import type { TeamRun } from '../features/team/types.ts'

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
): Promise<{ proposal: Proposal; orchestration?: { ok: boolean; steps: Array<{ step: string; status: string; summary: string }> } }> {
  return request(`/workmate/api/proposals/${encodeURIComponent(id)}/archive`, {
    method: 'POST',
    body: JSON.stringify({ force }),
  })
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


export type TeamRunEvent = Pick<ProposalEvent, 'at' | 'kind' | 'taskId' | 'dispatchId' | 'status' | 'detail'>

export function listTeamRuns(proposalId?: string): Promise<{ runs: TeamRun[] }> {
  const query = proposalId !== undefined && proposalId !== '' ? `?proposalId=${encodeURIComponent(proposalId)}` : ''
  return request(`/workmate/api/team/runs${query}`)
}

export function getTeamRun(id: string): Promise<{ run: TeamRun; events: TeamRunEvent[] }> {
  return request(`/workmate/api/team/runs/${encodeURIComponent(id)}`)
}
