/**
 * Browser-side REST client. Same-origin relative paths work both from the
 * standalone page (/workmate/) and inside the DSH shell (better-sidebar tab).
 */
import type { AggregateMetrics, BandsPayload, CreateProposalBody, Proposal, ProposalState, ProposalStatusPayload } from './types'

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

export function getMetrics(): Promise<AggregateMetrics> {
  return request('/workmate/api/metrics')
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

export interface RegisteredProject {
  name: string
  root: string
}

export function listProjects(): Promise<{ projects: RegisteredProject[] }> {
  return request('/workmate/api/projects')
}

export function registerProject(name: string, root: string): Promise<{ project: RegisteredProject }> {
  return request('/workmate/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name, root }),
  })
}
