// @vitest-environment jsdom
/**
 * ProposalPanel behaviour tests (jsdom + @testing-library) — the DSH shell
 * renders the very same component in the better-sidebar tab, so these lock
 * the panel the user sees in both exits. Kanban layout per the rework change:
 * three lifecycle columns, modal creation, in-card detail expansion.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

function columnFor(status: string): HTMLElement {
  const heads = screen.getAllByText(status === 'draft' ? '提案中' : status === 'executing' ? '执行中' : '已归档')
  const head = heads[0] as HTMLElement
  const column = head.closest('section')
  if (column === null) throw new Error('column section not found')
  return column as HTMLElement
}

describe('ProposalPanel (kanban)', () => {
  it('renders three lifecycle columns with counts and places cards accordingly', async () => {
    fetchMock.mockResolvedValue(
      ok({
        proposals: [
          proposal(),
          proposal({ id: 'p2', title: '另一提案', status: 'executing' }),
          proposal({ id: 'p3', title: '旧提案', status: 'archived' }),
        ],
      }),
    )

    render(<ProposalPanel />)
    expect(await screen.findByText('批量批改 v2.1')).toBeTruthy()
    expect(screen.getByText('3 条提案')).toBeTruthy()

    expect(within(columnFor('draft')).getByText('批量批改 v2.1')).toBeTruthy()
    expect(within(columnFor('executing')).getByText('另一提案')).toBeTruthy()
    expect(within(columnFor('archived')).getByText('旧提案')).toBeTruthy()
    expect(within(columnFor('draft')).getByText('1')).toBeTruthy()
  })

  it('shows an empty column hint when a lifecycle stage has no cards', async () => {
    fetchMock.mockResolvedValue(ok({ proposals: [proposal()] }))
    render(<ProposalPanel />)
    await screen.findByText('批量批改 v2.1')
    expect(within(columnFor('archived')).getByText('暂无提案')).toBeTruthy()
  })

  it('creates through the ＋ 新提案 modal and refreshes the board', async () => {
    fetchMock.mockResolvedValueOnce(ok({ proposals: [] }))
    fetchMock.mockResolvedValueOnce(ok({ proposal: proposal() }))
    fetchMock.mockResolvedValueOnce(ok({ proposals: [proposal()] }))

    render(<ProposalPanel />)
    await screen.findAllByText('暂无提案')

    fireEvent.click(screen.getByText('＋ 新提案'))
    const modal = screen.getByText('＋ 新提案', { selector: 'h3' })
    expect(modal).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText('批量批改 v2.1'), { target: { value: '新提案标题' } })
    fireEvent.click(screen.getByText('创建提案'))

    await waitFor(() => expect(screen.getByText('批量批改 v2.1')).toBeTruthy())
    const createCall = fetchMock.mock.calls[1] as unknown as [string, RequestInit]
    expect(createCall[0]).toBe('/workmate/api/proposals')
    expect(JSON.parse(String(createCall[1].body))).toMatchObject({ title: '新提案标题' })
  })

  it('surfaces REST errors inline', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: '存储不可读' }) })

    render(<ProposalPanel />)
    await screen.findByText('存储不可读')
  })

  it('expands a card to load detail facts (openspec state, commits)', async () => {
    fetchMock.mockResolvedValue(ok({ proposals: [proposal({ status: 'executing' })] }))
    render(<ProposalPanel />)
    await screen.findByText('批量批改 v2.1')

    fireEvent.click(screen.getByText('批量批改 v2.1'))
    fetchMock.mockResolvedValueOnce(
      ok({
        proposal: proposal({ status: 'executing' }),
        openspec: { state: 'active', tasks: { done: 2, total: 3 } },
        commits: [{ hash: 'a'.repeat(40), short: 'abc1234', subject: 'feat: 接口' }],
      }),
    )
    fireEvent.click(screen.getByText('加载详情'))

    await waitFor(() => expect(screen.getByText(/tasks 2\/3/)).toBeTruthy())
    expect(screen.getByText('feat: 接口')).toBeTruthy()
    expect(screen.getByText(/abc1234/)).toBeTruthy()
  })
})
