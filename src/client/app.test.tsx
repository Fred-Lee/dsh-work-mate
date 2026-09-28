// @vitest-environment jsdom
/**
 * ProposalPanel behaviour tests (jsdom + @testing-library) — the DSH shell
 * renders the very same component in the better-sidebar tab, so these lock
 * the panel the user sees in both exits.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProposalPanel } from './App'
import type { Proposal } from './types'

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: 'batch-grading-v2',
    title: '批量批改 v2.1',
    status: 'draft',
    projects: [],
    commits: [],
    openspecChangeId: 'batch-grading-v2',
    createdAt: '2026-09-28T00:00:00.000Z',
    updatedAt: '2026-09-28T00:00:00.000Z',
    ...overrides,
  }
}

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  fetchMock.mockReset()
  vi.restoreAllMocks()
})

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body }
}

describe('ProposalPanel', () => {
  it('renders proposals from the REST API with status badges', async () => {
    fetchMock.mockResolvedValue(ok({ proposals: [proposal(), proposal({ id: 'p2', title: '另一提案', status: 'archived' })] }))

    render(<ProposalPanel />)
    expect(await screen.findByText('批量批改 v2.1')).toBeTruthy()
    expect(screen.getByText('另一提案')).toBeTruthy()
    expect(screen.getByText('2 条')).toBeTruthy()
    const badges = screen.getAllByText(/提案中|已归档/)
    expect(badges).toHaveLength(2)
  })

  it('creates a proposal through the form and refreshes', async () => {
    fetchMock.mockResolvedValueOnce(ok({ proposals: [] }))
    fetchMock.mockResolvedValueOnce(ok({ proposal: proposal() }))
    fetchMock.mockResolvedValueOnce(ok({ proposals: [proposal()] }))

    render(<ProposalPanel />)
    await screen.findByText(/还没有提案/)

    fireEvent.change(screen.getByPlaceholderText('batch-grading-v2'), { target: { value: 'p1' } })
    fireEvent.change(screen.getByPlaceholderText('批量批改 v2.1'), { target: { value: '标题' } })
    fireEvent.click(screen.getByText('创建提案'))

    await waitFor(() => expect(screen.getByText('批量批改 v2.1')).toBeTruthy())
    const createCall = fetchMock.mock.calls[1] as unknown as [string, RequestInit]
    expect(createCall[0]).toBe('/workmate/api/proposals')
    expect(JSON.parse(String(createCall[1].body))).toMatchObject({ id: 'p1', title: '标题' })
  })

  it('surfaces REST errors inline', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: '存储不可读' }) })

    render(<ProposalPanel />)
    await screen.findByText('存储不可读')
  })

  it('shows detail facts (openspec state, commits) after loading', async () => {
    fetchMock.mockResolvedValue(ok({ proposals: [proposal({ status: 'executing' })] }))
    render(<ProposalPanel />)
    await screen.findByText('批量批改 v2.1')

    fetchMock.mockResolvedValueOnce(
      ok({
        proposal: proposal({ status: 'executing' }),
        openspec: { state: 'active', tasks: { done: 2, total: 3 } },
        commits: [{ hash: 'a'.repeat(40), short: 'abc1234', subject: 'feat: 接口' }],
      }),
    )
    fireEvent.click(screen.getByText('加载详情'))

    expect(await screen.findByText(/tasks 2\/3/)).toBeTruthy()
    expect(screen.getByText('feat: 接口')).toBeTruthy()
    expect(screen.getByText(/abc1234/)).toBeTruthy()
  })
})
