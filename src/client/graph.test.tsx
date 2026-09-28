// @vitest-environment jsdom
/** GraphView: layered SVG over /workmate/api/graph. */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GraphView } from './GraphView'
import type { GraphPayload } from './graph-types'

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  fetchMock.mockReset()
})

function graph(overrides: Partial<GraphPayload> = {}): GraphPayload {
  return {
    nodes: [
      { kind: 'proposal', id: 'proposal:p1', label: '批量批改', status: 'executing' },
      { kind: 'project', id: 'project:grading', label: 'grading-core' },
      { kind: 'commit', id: 'commit:abc', label: 'abc1234' },
    ],
    edges: [
      { from: 'proposal:p1', to: 'project:grading', relation: '涉及' },
      { from: 'project:grading', to: 'commit:abc', relation: '提交' },
    ],
    generatedAt: '2026-09-28T00:00:00.000Z',
    ...overrides,
  }
}

describe('GraphView', () => {
  it('renders three layers with relation labels', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => graph() })

    render(<GraphView projectRoot="/proj" />)
    await waitFor(() => expect(screen.getByRole('img')).toBeTruthy())

    const svg = screen.getByRole('img').innerHTML
    expect(svg).toContain('批量批改')
    expect(svg).toContain('grading-core')
    expect(svg).toContain('abc1234')
    expect(svg).toContain('涉及')
    expect(svg).toContain('提交')
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/workmate/api/graph?projectRoot=%2Fproj')
  })

  it('shows an empty-state hint and drops dangling edges', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => graph({ edges: [{ from: 'proposal:p1', to: 'project:ghost', relation: '涉及' }] }) })
    render(<GraphView />)
    await waitFor(() => expect(screen.getByRole('img')).toBeTruthy())
    expect(screen.getByRole('img').innerHTML).not.toContain('ghost')
  })

  it('shows the guidance copy when there is nothing to show', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => graph({ nodes: [], edges: [] }) })
    render(<GraphView />)
    expect(await screen.findByText(/还没有可展示的关联/)).toBeTruthy()
  })

  it('surfaces REST errors inline', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({}) })
    render(<GraphView />)
    expect(await screen.findByText(/graph API failed/)).toBeTruthy()
  })
})
