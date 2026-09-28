/**
 * Browser-side REST client. Same-origin relative paths work both from the
 * standalone page (/workmate/) and inside the DSH shell (better-sidebar tab).
 */
import type { CreateProposalBody, Proposal, ProposalStatusPayload } from './types'

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

export function getProposal(id: string, projectRoot?: string): Promise<ProposalStatusPayload> {
  const query = projectRoot ? `?projectRoot=${encodeURIComponent(projectRoot)}` : ''
  return request(`/workmate/api/proposals/${encodeURIComponent(id)}${query}`)
}

export function createProposal(body: CreateProposalBody): Promise<{ proposal: Proposal; openspec?: { status: string; dir?: string }; note?: string }> {
  return request('/workmate/api/proposals', { method: 'POST', body: JSON.stringify(body) })
}

export function startProposal(id: string): Promise<{ proposal: Proposal }> {
  return request(`/workmate/api/proposals/${encodeURIComponent(id)}/start`, { method: 'POST', body: '{}' })
}

export function archiveProposal(id: string, force = false): Promise<{ proposal: Proposal }> {
  return request(`/workmate/api/proposals/${encodeURIComponent(id)}/archive`, {
    method: 'POST',
    body: JSON.stringify({ force }),
  })
}
