// @vitest-environment jsdom
/**
 * ProposalPanel behaviour tests (jsdom + @testing-library) — the DSH shell
 * renders the very same component in the better-sidebar tab, so these lock
 * the panel the user sees in both exits. Kanban layout per the rework change:
 * three lifecycle columns, modal creation, in-card detail expansion.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConsoleView, ProposalPanel } from './App'
import { PANEL_STYLE } from './styles'
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


function routeMock(handler: (url: string, method: string, body: unknown) => unknown): void {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) : undefined
    return ok(handler(url, method, body))
  })
}

function postedCall(url: string): [string, RequestInit] {
  const found = fetchMock.mock.calls.find(
    ([candidate, init]) =>
      candidate === url && ((init as RequestInit | undefined)?.method ?? 'GET') === 'POST',
  )
  if (found === undefined) throw new Error(`no POST ${url}`)
  return found as unknown as [string, RequestInit]
}

function columnFor(status: string): HTMLElement {
  const label =
    status === 'draft' || status === 'proposing'
      ? '方案'
      : status === 'reviewing'
        ? '待确认'
        : status === 'ready' || status === 'implementing' || status === 'executing'
          ? '执行中'
          : status === 'merging' || status === 'archiving'
            ? '待合并'
            : '已归档'
  const heads = screen.getAllByText(label)
  const head = heads[0] as HTMLElement
  const column = head.closest('section')
  if (column === null) throw new Error('column section not found')
  return column as HTMLElement
}

const renderPanel = (): ReturnType<typeof render> => {
  const view = render(<ProposalPanel />)
  // The panel is list-first now; board-specific tests switch explicitly.
  fireEvent.click(screen.getByText('看板'))
  return view
}

describe('ProposalPanel (kanban)', () => {
  it('renders three lifecycle columns with counts and places cards accordingly', async () => {
    fetchMock.mockResolvedValue(
      ok({
        proposals: [
          proposal(),
          proposal({ id: 'p2', title: '另一提案', status: 'implementing' }),
          proposal({ id: 'p3', title: '旧提案', status: 'archived' }),
        ],
      }),
    )

    renderPanel()
    expect(await screen.findByText('批量批改 v2.1')).toBeTruthy()
    expect(screen.getByText('3 条提案')).toBeTruthy()

    expect(within(columnFor('draft')).getByText('批量批改 v2.1')).toBeTruthy()
    expect(within(columnFor('executing')).getByText('另一提案')).toBeTruthy()
    fireEvent.click(screen.getByText('显示已归档'))
    expect(within(columnFor('archived')).getByText('旧提案')).toBeTruthy()
    expect(within(columnFor('draft')).getByText('1')).toBeTruthy()
  })

  it('shows an empty column hint when a lifecycle stage has no cards', async () => {
    fetchMock.mockResolvedValue(ok({ proposals: [proposal()] }))
    renderPanel()
    await screen.findByText('批量批改 v2.1')
    expect(within(columnFor('archived')).getByText('暂无提案')).toBeTruthy()
  })

  it('creates through the ＋ 新提案 modal and refreshes the board', async () => {
    let created = false
    routeMock((url, method) => {
      if (url === '/workmate/api/proposals' && method === 'GET') return { proposals: created ? [proposal()] : [] }
      if (url === '/workmate/api/projects') return { projects: [] }
      if (url === '/workmate/api/isolation') return { occupancy: [], conflicts: [] }
      if (url === '/workmate/api/proposals' && method === 'POST') {
        created = true
        return { proposal: proposal() }
      }
      return {}
    })

    renderPanel()
    await screen.findAllByText('暂无提案')

    fireEvent.click(screen.getByText('＋ 新提案'))
    expect(screen.getByText('＋ 新提案', { selector: 'h3' })).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText('批量批改 v2.1'), { target: { value: '新提案标题' } })
    fireEvent.click(screen.getByText('创建提案'))

    await waitFor(() => expect(screen.getByText('批量批改 v2.1')).toBeTruthy())
    const createCall = postedCall('/workmate/api/proposals')
    expect(JSON.parse(String(createCall[1].body))).toMatchObject({ title: '新提案标题' })
  })

  it('filters by project, loads branches, and imports a Workspace candidate', async () => {
    routeMock((url, method) => {
      if (url === '/workmate/api/proposals' && method === 'GET') {
        return {
          proposals: [
            proposal({ id: 'a1', title: 'A 提案', projects: ['a'] }),
            proposal({ id: 'b1', title: 'B 提案', projects: ['b'] }),
          ],
        }
      }
      if (url === '/workmate/api/projects' && method === 'GET') {
        return { projects: [{ name: 'a', root: '/repo/a', defaultBranch: 'main', workspace: 'xkw' }] }
      }
      if (url === '/workmate/api/projects/a/branches') {
        return { project: 'a', branches: { current: 'main', default: 'main', local: ['main', 'dev'], remote: [] } }
      }
      if (url === '/workmate/api/projects/candidates') {
        return {
          candidates: [
            {
              path: '/repo/b',
              title: 'B',
              name: 'b',
              suggestedName: 'b',
              registered: false,
              hasOpenspec: true,
              workspace: 'xkw',
            },
          ],
        }
      }
      if (url === '/workmate/api/projects' && method === 'POST') {
        return { project: { name: 'b', root: '/repo/b' } }
      }
      if (url === '/workmate/api/isolation') return { occupancy: [], conflicts: [] }
      return {}
    })

    renderPanel()
    await screen.findByText('A 提案')
    expect(screen.getByText('B 提案')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('项目'), { target: { value: 'a' } })
    await waitFor(() => expect(screen.queryByText('B 提案')).toBeNull())
    expect(await screen.findByLabelText('分支')).toBeTruthy()
    expect(screen.getByText('当前 ⎇ main')).toBeTruthy()

    fireEvent.click(screen.getByText('从 Workspace 导入'))
    await screen.findByText('/repo/b')
    fireEvent.click(screen.getByText('加入项目'))

    await waitFor(() => {
      const call = postedCall('/workmate/api/projects')
      expect(JSON.parse(String(call[1].body))).toMatchObject({ name: 'b', root: '/repo/b', workspace: 'xkw' })
    })
  })

  it('opens a list row in the detail drawer', async () => {
    routeMock((url, method) => {
      if (url === '/workmate/api/proposals' && method === 'GET') {
        return { proposals: [proposal({ status: 'reviewing' })] }
      }
      if (url === '/workmate/api/projects') return { projects: [] }
      if (url === '/workmate/api/isolation') return { occupancy: [], conflicts: [] }
      if (url.endsWith('/batch-grading-v2') && method === 'GET') {
        return {
          proposal: proposal({ status: 'reviewing' }),
          projects: [],
          lifecycle: { status: 'reviewing', hint: '确认方案后进入执行', prev: 'proposing', next: 'ready' },
        }
      }
      return {}
    })

    renderPanel()
    await screen.findByText('批量批改 v2.1')
    fireEvent.click(screen.getByText('列表'))
    const rows = await screen.findAllByText('批量批改 v2.1')
    fireEvent.click(rows[rows.length - 1] as HTMLElement)

    expect(await screen.findByText('关闭')).toBeTruthy()
    expect(screen.getByText('下一步：确认方案后进入执行')).toBeTruthy()
    expect(screen.getByText('目标矩阵')).toBeTruthy()
    expect(screen.getByText('任务')).toBeTruthy()
    expect(screen.getByText('审查')).toBeTruthy()
    expect(screen.getByText('确认方案')).toBeTruthy()
  })

  it('drives the lifecycle from the expanded card (rollback posts the adjacent target)', async () => {
    let status: Proposal['status'] = 'reviewing'
    routeMock((url, method) => {
      if (url === '/workmate/api/proposals' && method === 'GET') return { proposals: [proposal({ status })] }
      if (url === '/workmate/api/projects') return { projects: [] }
      if (url === '/workmate/api/isolation') return { occupancy: [], conflicts: [] }
      if (url.endsWith('/batch-grading-v2') && method === 'GET') {
        return {
          proposal: proposal({ status }),
          projects: [],
          lifecycle: { status: 'reviewing', hint: '评审提案分支，完成后合并进 main', prev: 'proposing', next: 'ready' },
        }
      }
      if (url.endsWith('/transition') && method === 'POST') {
        status = 'proposing'
        return { proposal: proposal({ status }) }
      }
      return {}
    })

    renderPanel()
    await screen.findByText('批量批改 v2.1')
    fireEvent.click(screen.getByText('批量批改 v2.1'))
    fireEvent.click(screen.getByText('加载详情'))

    await screen.findByText('推进到 待实现 ›')
    expect(screen.getByText('‹ 回退到 提案分支')).toBeTruthy()
    expect(screen.getByText('下一步：评审提案分支，完成后合并进 main')).toBeTruthy()

    fireEvent.click(screen.getByText('‹ 回退到 提案分支'))

    await waitFor(() => {
      const call = postedCall('/workmate/api/proposals/batch-grading-v2/transition')
      expect(JSON.parse(String(call[1].body))).toEqual({ to: 'proposing' })
    })
  })

  it('offers force-archive while archiving and never advances to the terminal state', async () => {
    routeMock((url, method) => {
      if (url === '/workmate/api/proposals' && method === 'GET') return { proposals: [proposal({ status: 'archiving' })] }
      if (url === '/workmate/api/projects') return { projects: [] }
      if (url === '/workmate/api/isolation') return { occupancy: [], conflicts: [] }
      if (url.endsWith('/batch-grading-v2') && method === 'GET') {
        return {
          proposal: proposal({ status: 'archiving' }),
          projects: [],
          lifecycle: { status: 'archiving', hint: '推进后运行归档编排', prev: 'merging', next: 'archived' },
        }
      }
      if (url.endsWith('/archive') && method === 'POST') {
        return { proposal: proposal({ status: 'archiving' }), orchestration: { ok: false, steps: [] } }
      }
      return {}
    })

    renderPanel()
    await screen.findByText('批量批改 v2.1')
    fireEvent.click(screen.getByText('批量批改 v2.1'))
    fireEvent.click(screen.getByText('加载详情'))

    await screen.findByText('完成归档')
    expect(screen.getByText('强制归档（跳过审查门）')).toBeTruthy()
    expect(screen.queryByText(/^推进到/)).toBeNull()

    fireEvent.click(screen.getByText('强制归档（跳过审查门）'))

    await waitFor(() => {
      const call = postedCall('/workmate/api/proposals/batch-grading-v2/archive')
      expect(JSON.parse(String(call[1].body))).toEqual({ force: true })
    })
  })

  it('surfaces REST errors inline', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: '存储不可读' }) })

    renderPanel()
    await screen.findByText('存储不可读')
  })

  it('expands a card to load per-project detail facts', async () => {
    fetchMock.mockResolvedValue(ok({ proposals: [proposal({ status: 'implementing', projects: ['grading-core'] })] }))
    renderPanel()
    await screen.findByText('批量批改 v2.1')

    fireEvent.click(screen.getByText('批量批改 v2.1'))
    fetchMock.mockResolvedValueOnce(
      ok({
        proposal: proposal({ status: 'implementing', projects: ['grading-core'] }),
        projects: [
          {
            project: 'grading-core',
            root: '/srv/grading-core',
            git: { branch: 'feat/proposal', headShort: 'abc1234', dirtyCount: 2, isWorktree: true },
            openspec: { state: 'active', tasks: { done: 2, total: 3 } },
            commits: [{ hash: 'a'.repeat(40), short: 'abc1234', subject: 'feat: 接口' }],
          },
        ],
      }),
    )
    fireEvent.click(screen.getByText('加载详情'))

    await waitFor(() => expect(screen.getByText(/tasks 2\/3/)).toBeTruthy())
    expect(screen.getByText(/⎇ feat\/proposal/)).toBeTruthy()
    expect(screen.getByText('worktree')).toBeTruthy()
    expect(screen.getByText('2 个未提交变更')).toBeTruthy()
    expect(screen.getByText('feat: 接口')).toBeTruthy()
  })
})

describe('control room (workbench panel)', () => {
  const metricsBody = {
    proposals: 3,
    byState: { reviewing: 1 },
    averageTimeInStateMs: {},
    cycleTimeMedianMs: 4 * 60 * 60 * 1000,
    archived7d: 2,
    archived30d: 2,
    reworkRate: 1 / 3,
    firstPassRate: 2 / 3,
    gateFailureRanking: [{ gate: 'proposal-branch', count: 2 }],
    actorShare: { agent: 3, human: 3, system: 0 },
    perProposal: [
      {
        id: 'a',
        title: '提案 A',
        status: 'reviewing',
        archived: false,
        currentStateMs: 9 * 60 * 60 * 1000,
        reworkCount: 1,
        gateFailureCount: 2,
        openBlockers: 1,
        decisions: 0,
      },
    ],
    events: 7,
    skippedLines: 1,
  }
  const bandsBody = {
    windowDays: 30,
    evaluations: [
      {
        metric: 'cycleTime',
        direction: 'high' as const,
        status: 'insufficient-data' as const,
        tier: 'normal' as const,
        action: 'normal',
        current: 0,
        baseline: 0,
        sigma: 0,
        deviation: 0,
        samples: 4,
        baselineSamples: 0,
        note: 'baseline needs 8 samples, has 0',
      },
    ],
  }

  beforeEach(() => {
    fetchMock.mockImplementation((input: unknown) => {
      const url = String(input)
      // The real endpoint wraps the aggregate in `{metrics}` — mock the real shape.
      if (url.includes('/api/metrics')) return Promise.resolve(ok({ metrics: metricsBody, skippedLines: 0 }))
      if (url.includes('/api/bands')) return Promise.resolve(ok(bandsBody))
      return Promise.resolve(ok({ proposals: [] }))
    })
  })

  it('renders aggregate KPIs, per-proposal rows and the gate-failure ranking', async () => {
    render(<ConsoleView onError={() => {}} />)

    expect(await screen.findByText('提案总数')).toBeTruthy()
    expect(screen.getByText('33%')).toBeTruthy()
    expect(screen.getByText('67%')).toBeTruthy()
    expect(screen.getByText('4.0h')).toBeTruthy()
    expect(screen.getByText('提案 A')).toBeTruthy()
    expect(screen.getByText(/proposal-branch×2/)).toBeTruthy()
    expect(screen.getByText(/1 行无法解析/)).toBeTruthy()
  })

  it('shows a thin baseline as 数据不足 instead of normal', async () => {
    render(<ConsoleView onError={() => {}} />)

    expect(await screen.findByText('数据不足')).toBeTruthy()
    expect(screen.queryByText('normal')).toBeNull()
  })

  it('offers the console as a third panel view', () => {
    fetchMock.mockResolvedValue(ok({ proposals: [] }))
    renderPanel()

    expect(screen.getByText('控制台')).toBeTruthy()
  })
})

describe('console view tolerance (regression)', () => {
  it('renders instead of blanking when the payload lacks perProposal', async () => {
    fetchMock.mockImplementation((input: unknown) => {
      const url = String(input)
      if (url.includes('/api/metrics')) {
        // An older/partial host answer: aggregate present, per-proposal missing.
        return Promise.resolve(ok({ metrics: { proposals: 1, cycleTimeMedianMs: 3600_000, archived7d: 0, archived30d: 0, reworkRate: 0, firstPassRate: 0, events: 0, skippedLines: 0 } }))
      }
      return Promise.resolve(ok({ windowDays: 30, evaluations: [] }))
    })

    render(<ConsoleView onError={() => {}} />)

    expect(await screen.findByText('提案总数')).toBeTruthy()
    expect(screen.getByText('还没有提案')).toBeTruthy()
  })

  it('accepts a flat legacy payload as well', async () => {
    fetchMock.mockImplementation((input: unknown) => {
      const url = String(input)
      if (url.includes('/api/metrics')) {
        return Promise.resolve(ok({ proposals: 0, perProposal: [], gateFailureRanking: [], actorShare: { agent: 0, human: 0, system: 0 }, events: 0, skippedLines: 0 }))
      }
      return Promise.resolve(ok({ windowDays: 30, evaluations: [] }))
    })

    render(<ConsoleView onError={() => {}} />)

    expect(await screen.findByText('提案总数')).toBeTruthy()
  })

  it('still shows the metrics when only the bands endpoint fails', async () => {
    fetchMock.mockImplementation((input: unknown) => {
      const url = String(input)
      if (url.includes('/api/metrics')) {
        return Promise.resolve(ok({ metrics: { proposals: 2, perProposal: [], gateFailureRanking: [], actorShare: { agent: 0, human: 0, system: 0 }, reworkRate: 0, firstPassRate: 0, archived7d: 0, archived30d: 0, events: 0, skippedLines: 0 } }))
      }
      return Promise.reject(new Error('bands.json is corrupt'))
    })

    render(<ConsoleView onError={() => {}} />)

    expect(await screen.findByText('提案总数')).toBeTruthy()
    expect(screen.getByText(/窗口 0 天/)).toBeTruthy()
  })
})

/**
 * Panel scroll contract (change `fix-panel-scroll`, design C1–C6).
 *
 * jsdom has no layout engine — these assertions cannot prove scrolling (the
 * real proof is the post-restart screenshot, task 7). What they lock is the
 * STRUCTURE the fix stands on, so a future refactor cannot silently delete
 * the height contract and reintroduce the ancestor-clipping bug.
 */
describe('panel scroll contract (fix-panel-scroll)', () => {
  const cssBlock = (selector: string): string => {
    const match = new RegExp(`${selector} \\{[^}]*\\}`).exec(PANEL_STYLE)
    if (match === null) throw new Error(`css block not found: ${selector}`)
    return match[0]
  }

  it('keeps the header outside and the board inside the single scroll layer (C3/C4)', async () => {
    fetchMock.mockResolvedValue(ok({ proposals: [proposal()] }))
    const { container } = renderPanel()
    await screen.findByText('批量批改 v2.1')

    const root = container.querySelector('.wm-root') as HTMLElement
    const body = root.querySelector('.wm-body') as HTMLElement
    const header = root.querySelector('.wm-header') as HTMLElement

    // Header and body are both DIRECT children of the root — the header stays
    // outside the scroll layer so navigation is reachable at any scroll depth.
    expect(header.parentElement).toBe(root)
    expect(body.parentElement).toBe(root)
    expect(body.contains(header)).toBe(false)
    // The board view is what the scroll layer carries.
    expect(body.querySelector('.wm-board')).toBeTruthy()
  })

  it('renders the console and graph views inside the same scroll layer (C4)', async () => {
    fetchMock.mockImplementation((input: unknown) => {
      const url = String(input)
      if (url.includes('/api/graph')) {
        return Promise.resolve(ok({ nodes: [], edges: [], generatedAt: '2026-10-08T00:00:00.000Z' }))
      }
      return Promise.resolve(ok({ proposals: [] }))
    })
    const { container } = renderPanel()
    const root = container.querySelector('.wm-root') as HTMLElement
    const body = root.querySelector('.wm-body') as HTMLElement

    fireEvent.click(screen.getByText('控制台'))
    await waitFor(() => expect(body.querySelector('.wm-console')).toBeTruthy())

    fireEvent.click(screen.getByText('知识图谱'))
    // GraphView's loading/empty/error roots are all `.wm-*` divs; whichever one
    // the mocked payload produces must live inside the scroll layer.
    await waitFor(() => expect(body.querySelector('.wm-graph, .wm-empty, .wm-error')).toBeTruthy())
  })

  it('does not put the create modal inside the scroll layer (C6)', async () => {
    fetchMock.mockImplementation((input: unknown) => {
      const url = String(input)
      if (url.includes('/api/projects')) return Promise.resolve(ok({ projects: [] }))
      return Promise.resolve(ok({ proposals: [] }))
    })
    const { container } = renderPanel()
    await screen.findAllByText('暂无提案')

    fireEvent.click(screen.getByText('＋ 新提案'))
    const modal = container.querySelector('.wm-modal') as HTMLElement
    expect(modal).toBeTruthy()
    // The modal is a sibling of the scroll layer, never a descendant — the
    // overlay must not inherit the body's scrolling context.
    expect(modal.closest('.wm-body')).toBeNull()
  })

  it('locks the height/scroll CSS contract in the stylesheet text (C1/C2)', () => {
    const root = cssBlock('\\.wm-root')
    expect(root).toMatch(/display:\s*flex/)
    expect(root).toMatch(/flex-direction:\s*column/)
    expect(root).toMatch(/height:\s*100%/)
    expect(root).toMatch(/min-height:\s*0/)

    const body = cssBlock('\\.wm-body')
    expect(body).toMatch(/flex:\s*1 1 auto/)
    expect(body).toMatch(/min-height:\s*0/)
    expect(body).toMatch(/overflow-y:\s*auto/)
  })
  it('shows team runs and their task/event detail', async () => {
    const run = {
      id: 'r1',
      proposalId: 'p1',
      template: 'bug-fix',
      status: 'running',
      tasks: [
        {
          id: 't1',
          title: 't1',
          role: 'backend-dev',
          project: 'repo',
          writes: [],
          dependsOn: [],
          acceptance: 'ok',
          status: 'dispatched',
          attempts: 1,
        },
      ],
      dispatches: [],
      budget: { maxParallel: 3, maxAttempts: 2, maxDurationMs: 1000, maxTokens: 100, maxDispatches: 5 },
      createdAt: '2026-10-19T00:00:00.000Z',
      updatedAt: '2026-10-19T00:00:00.000Z',
    }
    routeMock((url, method) => {
      if (url === '/workmate/api/proposals' && method === 'GET') return { proposals: [] }
      if (url === '/workmate/api/projects') return { projects: [] }
      if (url === '/workmate/api/isolation') return { occupancy: [], conflicts: [] }
      if (url === '/workmate/api/team/runs' && method === 'GET') return { runs: [run] }
      if (url === '/workmate/api/team/runs/r1') {
        return {
          run,
          events: [{ at: '2026-10-19T00:00:00.000Z', kind: 'team-dispatch', taskId: 't1', status: 'dispatched', detail: 'role=backend-dev' }],
        }
      }
      return {}
    })

    renderPanel()
    fireEvent.click(screen.getByText('团队'))
    await screen.findByText('r1')
    fireEvent.click(screen.getByText('r1'))

    await screen.findByText('backend-dev')
    expect(screen.getByText(/当前 worker：t1/)).toBeTruthy()
    expect(screen.getByText('team-dispatch t1 dispatched role=backend-dev')).toBeTruthy()
  })

})
