// @vitest-environment jsdom
/** 「🚀 转为提案」chat entry: trigger → modal → create → open-panel link. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatProposalAction } from './ChatProposalAction'

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('open', vi.fn())
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  fetchMock.mockReset()
})

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body }
}

describe('ChatProposalAction', () => {
  it('renders the trigger and creates through the modal form', async () => {
    fetchMock.mockResolvedValue(
      ok({ proposal: { id: 'proposal-abc', title: '批量批改 v2.1', status: 'draft' } }),
    )

    render(<ChatProposalAction sessionId="sess-1" />)
    fireEvent.click(screen.getByText('🚀 转为提案'))

    fireEvent.change(screen.getByPlaceholderText('比如：批量批改 v2.1'), {
      target: { value: '批量批改 v2.1' },
    })
    fireEvent.click(screen.getByText('创建提案'))

    await waitFor(() => expect(screen.getByText(/已创建/)).toBeTruthy())
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/workmate/api/proposals')
    expect(JSON.parse(String(init.body))).toEqual({ title: '批量批改 v2.1' })
    expect(screen.getByText('proposal-abc')).toBeTruthy()
  })

  it('shows the open-panel link with a fresh panel view', async () => {
    fetchMock.mockResolvedValue(
      ok({ proposal: { id: 'proposal-abc', title: 't', status: 'draft' } }),
    )
    render(<ChatProposalAction panelUrl="/workmate/" />)
    fireEvent.click(screen.getByText('🚀 转为提案'))
    fireEvent.change(screen.getByPlaceholderText('比如：批量批改 v2.1'), { target: { value: 't' } })
    fireEvent.click(screen.getByText('创建提案'))

    const link = (await screen.findByText('打开面板')) as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('/workmate/')
  })

  it('surfaces REST errors inline and keeps the form editable', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: 'storage unreadable' }) })
    render(<ChatProposalAction />)
    fireEvent.click(screen.getByText('🚀 转为提案'))
    fireEvent.change(screen.getByPlaceholderText('比如：批量批改 v2.1'), { target: { value: 't' } })
    fireEvent.click(screen.getByText('创建提案'))

    expect(await screen.findByText('storage unreadable')).toBeTruthy()
    expect(screen.getByPlaceholderText('比如：批量批改 v2.1')).toBeTruthy()
  })

  it('ignores empty submits without a network call', async () => {
    render(<ChatProposalAction />)
    fireEvent.click(screen.getByText('🚀 转为提案'))
    fireEvent.click(screen.getByText('创建提案'))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('ignores empty submits without a network call', async () => {
    render(<ChatProposalAction />)
    fireEvent.click(screen.getByText('🚀 转为提案'))
    fireEvent.click(screen.getByText('创建提案'))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
