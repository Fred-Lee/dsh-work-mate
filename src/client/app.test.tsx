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
  const head = screen.getAllByText(label).find((element) => element.closest('section') !== null)
  if (head === undefined) throw new Error('column section not found')
  return head.closest('section') as HTMLElement
}

const renderPanel = (): ReturnType<typeof render> => {
  const view = render(<ProposalPanel />)
  // The panel is list-first now; board-specific tests switch explicitly.
  fireEvent.click(screen.getByText('看板'))
  return view
}

describe('ProposalPanel (kanban)', () => {

  it('看板列归属：reviewing 在「待确认」、merging/archiving 在「待合并」(clarify-panel-gates)', async () => {
    fetchMock.mockResolvedValue(
      ok({
        proposals: [
          proposal({ id: 'p-review', title: '等确认的', status: 'reviewing' }),
          proposal({ id: 'p-merge', title: '等合并的', status: 'merging' }),
          proposal({ id: 'p-arch', title: '归档中的', status: 'archiving' }),
          proposal({ id: 'p-prop', title: '写方案中', status: 'proposing' }),
        ],
      }),
    )
    renderPanel()
    expect(await screen.findByText('等确认的')).toBeTruthy()
    // 用与生产同一套映射的 columnFor：断言的是"卡片落在哪一列"，不是复制一份映射
    expect(within(columnFor('reviewing')).getByText('等确认的')).toBeTruthy()
    expect(within(columnFor('merging')).getByText('等合并的')).toBeTruthy()
    expect(within(columnFor('archiving')).getByText('归档中的')).toBeTruthy()
    expect(within(columnFor('proposing')).getByText('写方案中')).toBeTruthy()
  })
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
    expect(screen.getByText('3 条提案（含已归档）')).toBeTruthy()

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
    expect(screen.getByText(/＋ 新提案/, { selector: 'h3' })).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText('批量批改 v2.1'), { target: { value: '新提案标题' } })
    fireEvent.click(screen.getByText('下一步'))
    fireEvent.click(screen.getByText('下一步'))
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
    await screen.findByText('加入项目')
    fireEvent.click(screen.getByText('加入项目'))

    await waitFor(() => {
      const call = postedCall('/workmate/api/projects')
      expect(JSON.parse(String(call[1].body))).toMatchObject({ name: 'b', root: '/repo/b', workspace: 'xkw' })
    })
  })

  it('选项目不自动锁 default 分支，分支下拉以「全部分支」开头可撤销', async () => {
    routeMock((url, method) => {
      if (url === '/workmate/api/proposals' && method === 'GET') {
        return {
          proposals: [
            proposal({ id: 'a-main', title: '主线提案', projects: ['a'], featureBranch: 'main' }),
            proposal({ id: 'a-dev', title: '开发提案', projects: ['a'], featureBranch: 'dev' }),
            proposal({ id: 'b1', title: 'B 提案', projects: ['b'], featureBranch: 'main' }),
          ],
        }
      }
      if (url === '/workmate/api/projects' && method === 'GET') {
        return { projects: [{ name: 'a', root: '/repo/a', defaultBranch: 'main', workspace: 'xkw' }] }
      }
      if (url === '/workmate/api/projects/a/branches') {
        return { project: 'a', branches: { current: 'main', default: 'main', local: ['main', 'dev'], remote: [] } }
      }
      if (url === '/workmate/api/isolation') return { occupancy: [], conflicts: [] }
      return {}
    })

    renderPanel()
    await screen.findByText('主线提案')

    fireEvent.change(screen.getByLabelText('项目'), { target: { value: 'a' } })
    // 选项目只刷新分支清单：项目下两条提案都留在视野里，不被静默滤成 default 分支那一条。
    expect(await screen.findByLabelText('分支')).toBeTruthy()
    expect(screen.getByText('主线提案')).toBeTruthy()
    expect(screen.getByText('开发提案')).toBeTruthy()

    // 下拉首项是「全部分支」，与「全部项目」对称——这是用户撤销分支过滤的出口。
    const branchSelect = screen.getByLabelText('分支') as HTMLSelectElement
    expect(branchSelect.options[0]?.value).toBe('')
    expect(branchSelect.options[0]?.textContent).toBe('全部分支')

    // 分支只作为用户主动选择的过滤器：选 dev 只剩 dev 提案，选回「全部分支」即恢复。
    fireEvent.change(branchSelect, { target: { value: 'dev' } })
    expect(screen.queryByText('主线提案')).toBeNull()
    expect(screen.getByText('开发提案')).toBeTruthy()
    fireEvent.change(branchSelect, { target: { value: '' } })
    expect(screen.getByText('主线提案')).toBeTruthy()
    expect(screen.getByText('开发提案')).toBeTruthy()

    // 切到另一项目时旧分支过滤一并清空：若残留 'dev'，B 提案会被陈旧过滤器静默藏掉。
    fireEvent.change(screen.getByLabelText('项目'), { target: { value: 'b' } })
    expect(await screen.findByText('B 提案')).toBeTruthy()
  })

  it('labels task actions in the drawer event list instead of repeating task-settled (#16)', async () => {
    routeMock((url, method) => {
      if (url === '/workmate/api/proposals' && method === 'GET') {
        return { proposals: [proposal({ id: 'p-task', title: '有任务的提案', status: 'reviewing' })] }
      }
      if (url === '/workmate/api/projects') return { projects: [] }
      if (url === '/workmate/api/isolation') return { occupancy: [], conflicts: [] }
      if (url.endsWith('/p-task') && method === 'GET') {
        return { proposal: proposal({ id: 'p-task', title: '有任务的提案', status: 'reviewing' }), projects: [], lifecycle: {} }
      }
      if (url.endsWith('/p-task/events')) {
        return {
          events: [
            { at: '2026-11-09T01:00:00.000Z', kind: 'task-settled', status: 'task-create', taskId: 'task-1', actor: 'human' },
            { at: '2026-11-09T02:00:00.000Z', kind: 'task-settled', status: 'task-stop', taskId: 'task-1', actor: 'human' },
            // 提案级事件保持英文 kind：它是排查用的可 grep 标识。
            { at: '2026-11-09T03:00:00.000Z', kind: 'transition', from: 'reviewing', to: 'ready', actor: 'agent' },
          ],
        }
      }
      return {}
    })

    render(<ProposalPanel />)
    fireEvent.click(screen.getByText('列表'))
    const rows = await screen.findAllByText('有任务的提案')
    fireEvent.click(rows[rows.length - 1] as HTMLElement)

    // 动作名 + taskId 可见，两种动作可区分；kind 原文不再重复出现。
    expect(await screen.findByText(/任务 · 创建待办（task-1）/)).toBeTruthy()
    expect(screen.getByText(/任务 · 停止（task-1）/)).toBeTruthy()
    expect(screen.queryByText(/^task-settled$/)).toBeNull()
    expect(screen.getByText(/状态迁移 reviewing→ready/)).toBeTruthy()
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
      if (url.endsWith('/batch-grading-v2/events')) {
        return {
          events: [{ at: '2026-10-19T00:00:00.000Z', kind: 'transition', from: 'reviewing', to: 'ready', actor: 'agent' }],
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
    const dialog = screen.getByRole('dialog', { name: /提案详情/ })
    expect(within(dialog).getByText('下一步：确认方案后进入执行')).toBeTruthy()
    expect(within(dialog).getByText('目标矩阵')).toBeTruthy()
    // 「任务」现在同时是视图页签名与详情段名，断言要限定在抽屉内。
    expect(within(dialog).getByText('任务')).toBeTruthy()
    expect(screen.getByText('审查')).toBeTruthy()
    expect(screen.getByText('事件')).toBeTruthy()
    expect(screen.getByText(/状态迁移 reviewing→ready/)).toBeTruthy()
    expect(screen.getByText('确认方案')).toBeTruthy()
    expect(screen.getByRole('dialog', { name: /提案详情/ })).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByText('关闭')).toBeNull())
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
    expect(screen.getByText('‹ 回退到 提案分支已建')).toBeTruthy()
    expect(screen.getByText('下一步：评审提案分支，完成后合并进 main')).toBeTruthy()

    fireEvent.click(screen.getByText('‹ 回退到 提案分支已建'))

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
    expect(screen.getByText('强制归档（跳过四道门）')).toBeTruthy()
    expect(screen.queryByText(/^推进到/)).toBeNull()

    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('验收后强制归档')
    fireEvent.click(screen.getByText('强制归档（跳过四道门）'))

    await waitFor(() => {
      const call = postedCall('/workmate/api/proposals/batch-grading-v2/archive')
      expect(JSON.parse(String(call[1].body))).toEqual({ force: true, rationale: '验收后强制归档' })
    })

    // orchestration.ok=false 也是 HTTP 200，但提案仍在 archiving：卡片必须报 ❌，
    // 不得写「归档完成」（否则失败的门禁会被一句成功文案盖掉）。
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('归档编排失败，提案仍在 archiving')
    await waitFor(() => expect(screen.getByText(/❌ 归档编排失败，提案仍在 archiving/)).toBeTruthy())
    expect(screen.queryByText(/归档完成/)).toBeNull()
    prompt.mockRestore()
  })

  it('shows the failed orchestration step when the archive run aborts', async () => {
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
        return {
          proposal: proposal({ status: 'archiving' }),
          orchestration: {
            ok: false,
            steps: [{ step: 'review-gate', status: 'failed', summary: '审查报告缺失 — 运行 proposal-auditor 生成 review.md（或 force 跳过）' }],
          },
        }
      }
      return {}
    })

    renderPanel()
    await screen.findByText('批量批改 v2.1')
    fireEvent.click(screen.getByText('批量批改 v2.1'))
    fireEvent.click(screen.getByText('加载详情'))

    await screen.findByText('完成归档')
    fireEvent.click(screen.getByText('完成归档'))

    // 失败步骤的 summary 原样透出：人要知道该补哪一件，而不是只看到「失败」。
    await waitFor(() =>
      expect(screen.getByText(/❌ 审查报告缺失 — 运行 proposal-auditor 生成 review.md/)).toBeTruthy(),
    )
    expect(screen.queryByText(/归档完成/)).toBeNull()
    // 提案没有被改动：卡片仍在「待合并」列。
    expect(within(columnFor('archiving')).getByText('批量批改 v2.1')).toBeTruthy()
  })

  it('reports archive success only when the orchestration succeeded', async () => {
    routeMock((url, method) => {
      // 列表故意停留在 archiving（聚合可能慢一拍）：卡片留在看板上，断言才看得到 note。
      // 判定只看 orchestration.ok，不看卡片后来落到哪一列。
      if (url === '/workmate/api/proposals' && method === 'GET') {
        return { proposals: [proposal({ status: 'archiving' })] }
      }
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
        return {
          proposal: proposal({ status: 'archived' }),
          orchestration: { ok: true, steps: [{ step: 'openspec-archive', status: 'ok', summary: 'moved' }] },
        }
      }
      return {}
    })

    renderPanel()
    await screen.findByText('批量批改 v2.1')
    fireEvent.click(screen.getByText('批量批改 v2.1'))
    fireEvent.click(screen.getByText('加载详情'))

    await screen.findByText('完成归档')
    fireEvent.click(screen.getByText('完成归档'))

    // 反过来也要守住：ok=true 时不能因为新加的判定把成功误报成失败。
    await waitFor(() => expect(screen.getByText('✅ 归档完成')).toBeTruthy())
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('surfaces REST errors inline', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: '存储不可读' }) })

    renderPanel()
    await screen.findByText(/提案列表加载失败：存储不可读/)
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
        note: '基线样本不足：至少 8 条，当前 0 条',
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

    expect(await screen.findByText('活跃提案')).toBeTruthy()
    expect(screen.getByText('33%')).toBeTruthy()
    expect(screen.getByText('67%')).toBeTruthy()
    expect(screen.getByText('4.0h')).toBeTruthy()
    expect(screen.getByText('提案 A')).toBeTruthy()
    expect(screen.getByText(/proposal-branch×2/)).toBeTruthy()
    expect(screen.getByText(/1 行无法解析/)).toBeTruthy()
  })

  it('shows a stale-abandonedAt proposal in the console rows (真机 2026-11-11)', async () => {
    fetchMock.mockImplementation((input: unknown) => {
      const url = String(input)
      if (url.includes('/api/metrics')) {
        return Promise.resolve(
          ok({
            metrics: {
              proposals: 1,
              byState: { merging: 1 },
              averageTimeInStateMs: {},
              perProposal: [
                {
                  id: 'live',
                  title: '等合并提案',
                  status: 'merging',
                  archived: false,
                  currentStateMs: 60_000,
                  reworkCount: 0,
                  gateFailureCount: 0,
                  openBlockers: 0,
                  decisions: 0,
                  approvals: 0,
                },
              ],
              events: 0,
              skippedLines: 0,
            },
            skippedLines: 0,
          }),
        )
      }
      // abandonedIds 从全量提案拉取：残留 abandonedAt + 非 archived 状态不得进集合。
      if (url.includes('/api/proposals')) {
        return Promise.resolve(
          ok({
            proposals: [proposal({ id: 'live', title: '等合并提案', status: 'merging', abandonedAt: '2026-11-01T00:00:00.000Z' })],
          }),
        )
      }
      if (url.includes('/api/bands')) return Promise.resolve(ok({ windowDays: 0, evaluations: [] }))
      return Promise.resolve(ok({}))
    })

    render(<ConsoleView onError={() => {}} />)

    expect(await screen.findByText('等合并提案')).toBeTruthy()
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
  it('renders the proposal status in the same Chinese label as board/list (#8)', async () => {
    fetchMock.mockImplementation((input: unknown) => {
      const url = String(input)
      if (url.includes('/api/metrics')) {
        return Promise.resolve(
          ok({
            metrics: {
              proposals: 1,
              perProposal: [
                { id: 'p-arch', title: '已归档提案', status: 'archived', archived: true, abandoned: false, currentStateMs: 0, reworkCount: 0, gateFailureCount: 0, openBlockers: 0, approvals: 0 },
              ],
              gateFailureRanking: [],
              actorShare: { agent: 0, human: 0, system: 0 },
              reworkRate: 0,
              firstPassRate: 0,
              archived7d: 1,
              archived30d: 1,
              events: 0,
              skippedLines: 0,
            },
          }),
        )
      }
      return Promise.resolve(ok({ windowDays: 30, evaluations: [] }))
    })

    render(<ConsoleView onError={() => {}} />)
    // 控制台与看板/列表同一视觉：中文徽标，不再输出 archived 原文。
    expect(await screen.findByText('已归档')).toBeTruthy()
    expect(screen.queryByText('archived')).toBeNull()
  })

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

    expect(await screen.findByText('活跃提案')).toBeTruthy()
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

    expect(await screen.findByText('活跃提案')).toBeTruthy()
  })

  it('still shows the metrics when only the bands endpoint fails, and says so', async () => {
    const onError = vi.fn()
    fetchMock.mockImplementation((input: unknown) => {
      const url = String(input)
      if (url.includes('/api/metrics')) {
        return Promise.resolve(ok({ metrics: { proposals: 2, perProposal: [], gateFailureRanking: [], actorShare: { agent: 0, human: 0, system: 0 }, reworkRate: 0, firstPassRate: 0, archived7d: 0, archived30d: 0, events: 0, skippedLines: 0 } }))
      }
      return Promise.reject(new Error('bands.json is corrupt'))
    })

    render(<ConsoleView onError={onError} />)

    expect(await screen.findByText('活跃提案')).toBeTruthy()
    // bands 失败不再伪造「窗口 0 天」的空表：如实报错，且不再声称「数据不足」。
    expect(await screen.findByText(/控制带加载失败：bands\.json is corrupt/)).toBeTruthy()
    expect(screen.queryByText(/窗口 0 天/)).toBeNull()
    // metrics 端点正常，不能被 bands 的失败连坐。
    expect(screen.queryByText(/过程度量加载失败/)).toBeNull()
    expect(onError).toHaveBeenCalledWith('bands.json is corrupt')
  })

  it('keeps the last successful bands table when a later refresh fails', async () => {
    let bandsShouldFail = false
    fetchMock.mockImplementation((input: unknown) => {
      const url = String(input)
      if (url.includes('/api/metrics')) {
        return Promise.resolve(ok({ metrics: { proposals: 1, perProposal: [], gateFailureRanking: [], actorShare: { agent: 0, human: 0, system: 0 }, reworkRate: 0, firstPassRate: 0, archived7d: 0, archived30d: 0, events: 0, skippedLines: 0 } }))
      }
      if (bandsShouldFail) return Promise.reject(new Error('bands.json is corrupt'))
      return Promise.resolve(ok({ windowDays: 30, evaluations: [] }))
    })

    render(<ConsoleView onError={() => {}} />)
    expect(await screen.findByText(/窗口 30 天/)).toBeTruthy()

    bandsShouldFail = true
    fireEvent.click(screen.getByRole('button', { name: '刷新数据' }))

    // 失败提示出现，但表仍在——不能清空成「窗口 0 天」的假数据。
    expect(await screen.findByText(/控制带加载失败：bands\.json is corrupt（下方为上一次成功的数据）/)).toBeTruthy()
    expect(screen.getByText(/窗口 30 天/)).toBeTruthy()
  })
})

describe('context toolbar scope (#4)', () => {
  const panelRoutes = (): void => {
    routeMock((url, method) => {
      if (url === '/workmate/api/proposals' && method === 'GET') {
        return { proposals: [proposal({ id: 'p1', title: '进行中提案', status: 'reviewing' })] }
      }
      if (url === '/workmate/api/projects') return { projects: [] }
      if (url === '/workmate/api/isolation') return { occupancy: [], conflicts: [] }
      return {}
    })
  }

  it('renders the status select only inside the list view', async () => {
    panelRoutes()
    render(<ProposalPanel />)
    // 默认视图是「任务」——下拉不在屏幕上（它在看板/任务/控制台/图谱里都是无效控件）。
    await screen.findByText('待办')
    expect(screen.queryByLabelText('状态')).toBeNull()

    fireEvent.click(screen.getByText('看板'))
    expect(screen.queryByLabelText('状态')).toBeNull()

    fireEvent.click(screen.getByText('列表'))
    await screen.findByText('进行中提案')
    expect(screen.getByLabelText('状态')).toBeTruthy()
  })

  it('keeps the status select on screen when the filter matches nothing', async () => {
    panelRoutes()
    render(<ProposalPanel />)
    fireEvent.click(screen.getByText('列表'))
    await screen.findByText('进行中提案')

    fireEvent.change(screen.getByLabelText('状态'), { target: { value: 'archived' } })
    // 空态出现时控件仍在——否则用户没有出路把筛选改回来。
    expect(await screen.findByText(/没有匹配的提案/)).toBeTruthy()
    expect(screen.getByLabelText('状态')).toBeTruthy()
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
  it('keeps four task lanes at 760 and stacks the header instead of clipping it', () => {
    // 断点是布局契约的一部分：760 仍要四列（验收表要求四档宽度四列可读），
    // 720 以下头部换行（否则视图切换被挤出可视区）。
    const board = cssBlock('.wm-tasks-board')
    expect(board).toMatch(/repeat\(4,/)
    expect(PANEL_STYLE).toMatch(/@media \(max-width: 640px\) \{ \.wm-tasks-board/)
    expect(PANEL_STYLE).toMatch(/@media \(max-width: 720px\) \{[^}]*\.wm-header/)
    // 320 实测：视图切换条本身比整行宽（290 > 256），横向滚动会把「知识图谱」与
    // 「＋新提案」截在视口外——改成按钮换行（真机截图确认）。
    expect(PANEL_STYLE).toMatch(/\.wm-toolbar \{[^}]*flex-wrap: wrap/)
    expect(PANEL_STYLE).toMatch(/@media \(max-width: 420px\) \{[^@]*?\.wm-seg button \{ padding: 0 8px; \}/)
    expect(cssBlock('.wm-task-title')).toMatch(/-webkit-line-clamp: 2/)
  })

  it('filters the default list by lifecycle status', async () => {
    routeMock((url, method) => {
      if (url === '/workmate/api/proposals' && method === 'GET') {
        return {
          proposals: [
            proposal({ id: 'p1', title: '进行中提案', status: 'reviewing' }),
            proposal({ id: 'p2', title: '旧提案', status: 'archived' }),
          ],
        }
      }
      if (url === '/workmate/api/projects') return { projects: [] }
      if (url === '/workmate/api/isolation') return { occupancy: [], conflicts: [] }
      return {}
    })

    render(<ProposalPanel />)
    // 主视图已是「任务」（adopt-superagent-openspec-source）：本用例针对提案列表，先切页签。
    fireEvent.click(screen.getByText('列表'))
    await screen.findByText('进行中提案')
    expect(screen.queryByText('旧提案')).toBeNull()

    fireEvent.change(screen.getByLabelText('状态'), { target: { value: 'archived' } })
    await screen.findByText('旧提案')
    expect(screen.queryByText('进行中提案')).toBeNull()
  })

  it('keeps a stale-abandonedAt proposal visible and hides only the abandoned shape (真机 2026-11-11)', async () => {
    routeMock((url, method) => {
      if (url === '/workmate/api/proposals' && method === 'GET') {
        return {
          proposals: [
            proposal({ id: 'live', title: '等合并提案', status: 'merging', abandonedAt: '2026-11-01T00:00:00.000Z' }),
            proposal({ id: 'dead', title: '真终止提案', status: 'archived', abandonedAt: '2026-11-01T00:00:00.000Z' }),
          ],
        }
      }
      if (url === '/workmate/api/projects') return { projects: [] }
      if (url === '/workmate/api/isolation') return { occupancy: [], conflicts: [] }
      return {}
    })

    render(<ProposalPanel />)
    fireEvent.click(screen.getByText('列表'))
    // 只认 abandon 落盘形态（status=archived + abandonedAt）：残留字段不把 merging 提案连坐隐藏。
    await screen.findByText('等合并提案')
    expect(screen.queryByText('真终止提案')).toBeNull()

    // 真终止的提案需「显示已归档」+ 状态=已归档 两个开关才回到列表（撤销终止的入口）。
    fireEvent.click(screen.getByText('显示已归档'))
    fireEvent.change(screen.getByLabelText('状态'), { target: { value: 'archived' } })
    await screen.findByText('真终止提案')

    // 状态选回「全部」：两者同时可见，残留提案不受开关影响。
    fireEvent.change(screen.getByLabelText('状态'), { target: { value: 'all' } })
    await screen.findByText('等合并提案')
    expect(screen.getByText('真终止提案')).toBeTruthy()
  })

  it('opens the project tree and filters by the chosen project', async () => {
    routeMock((url, method) => {
      if (url === '/workmate/api/proposals' && method === 'GET') {
        return { proposals: [proposal({ projects: ['alpha'] })] }
      }
      if (url === '/workmate/api/projects' && method === 'GET') {
        return { projects: [{ name: 'alpha', root: '/repo/alpha', defaultBranch: 'main', workspace: 'xkw' }] }
      }
      if (url === '/workmate/api/isolation') return { occupancy: [], conflicts: [] }
      if (url === '/workmate/api/projects/alpha/branches') {
        return { project: 'alpha', branches: { current: 'main', default: 'main', local: ['main'], remote: [] } }
      }
      return {}
    })

    render(<ProposalPanel />)
    fireEvent.click(await screen.findByText('项目树'))
    await screen.findByText('xkw')
    // 项目树过滤的是提案列表，先切到「列表」页签再断言计数。
    fireEvent.click(screen.getByText('列表'))
    await screen.findByText('进行中 1')
    const treeRow = screen
      .getAllByText('alpha')
      .map((element) => element.closest('.wm-tree-row'))
      .find((element) => element !== null)
    fireEvent.click(treeRow as Element)

    await waitFor(() => expect((screen.getByLabelText('项目') as HTMLSelectElement).value).toBe('alpha'))
  })

})

describe('交付打磨（polish-workbench-delivery）', () => {
  it('提案列表失败：顶栏退成「—」、横幅带前缀与重试，重试成功恢复计数', async () => {
    let failing = true
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/api/proposals') && !String(url).includes('/api/proposals/')) {
        return failing ? Promise.reject(new Error('boom')) : Promise.resolve(ok({ proposals: [proposal()] }))
      }
      if (String(url).includes('/api/config')) return Promise.resolve(ok({ taskExecutor: 'superagent', pollMs: 0 }))
      return Promise.resolve(ok({ occupancy: [], conflicts: [] }))
    })

    render(<ProposalPanel />)
    expect(await screen.findByText(/提案列表加载失败：boom/)).toBeTruthy()
    expect(screen.getByText('— 条提案')).toBeTruthy()

    failing = false
    fireEvent.click(screen.getByText('重试'))
    await waitFor(() => expect(screen.getByText('1 条提案（含已归档）')).toBeTruthy())
    expect(screen.queryByText(/提案列表加载失败/)).toBeNull()
  })

  it('隐藏计数分开报已归档与已终止（真机 2026-11-11：8 条终止曾被静默剔除）', async () => {
    const archived = Array.from({ length: 10 }, (_, index) =>
      proposal({ id: `arch-${index}`, title: `归档 ${index}`, status: 'archived' }),
    )
    const terminated = Array.from({ length: 8 }, (_, index) =>
      proposal({ id: `gone-${index}`, title: `终止 ${index}`, status: 'archived', abandonedAt: '2026-11-01T00:00:00.000Z' }),
    )
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/api/proposals')) return Promise.resolve(ok({ proposals: [...archived, ...terminated] }))
      if (String(url).includes('/api/config')) return Promise.resolve(ok({ taskExecutor: 'superagent', pollMs: 0 }))
      return Promise.resolve(ok({ occupancy: [], conflicts: [] }))
    })

    renderPanel()
    expect(await screen.findByText(/已隐藏 18 条（10 条已归档 \+ 8 条已终止）/)).toBeTruthy()
    fireEvent.click(screen.getByText('显示已归档'))
    expect(await screen.findByText('终止 0')).toBeTruthy()
    expect(screen.getByText('归档 0')).toBeTruthy()
  })

  it('列表空态区分「还没有」与「被筛掉」，后者给清空筛选出口', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/api/proposals')) {
        return Promise.resolve(ok({ proposals: [proposal({ title: '轮询改事件推送' })] }))
      }
      if (String(url).includes('/api/config')) return Promise.resolve(ok({ taskExecutor: 'superagent', pollMs: 0 }))
      return Promise.resolve(ok({ occupancy: [], conflicts: [] }))
    })

    render(<ProposalPanel />)
    fireEvent.click(screen.getByText('列表'))
    expect(await screen.findByText('轮询改事件推送')).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText('搜索提案 / 项目…'), { target: { value: '不存在的关键词' } })
    expect(await screen.findByText(/没有匹配的提案/)).toBeTruthy()
    fireEvent.click(screen.getByText('清空筛选'))
    expect(await screen.findByText('轮询改事件推送')).toBeTruthy()
  })

  it('「显示已归档」pill 暴露 aria-pressed 开关状态', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/api/proposals')) return Promise.resolve(ok({ proposals: [] }))
      if (String(url).includes('/api/config')) return Promise.resolve(ok({ taskExecutor: 'superagent', pollMs: 0 }))
      return Promise.resolve(ok({ occupancy: [], conflicts: [] }))
    })
    render(<ProposalPanel />)
    const pill = (await screen.findByText('显示已归档')).closest('button') as HTMLElement
    expect(pill.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(pill)
    expect(pill.getAttribute('aria-pressed')).toBe('true')
  })

  it('新提案第 1 步标题前置校验：空标题停在第一步并就地提示', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/api/projects')) return Promise.resolve(ok({ projects: [] }))
      if (String(url).includes('/api/config')) return Promise.resolve(ok({ taskExecutor: 'superagent', pollMs: 0 }))
      return Promise.resolve(ok({ proposals: [] , occupancy: [], conflicts: [] }))
    })

    render(<ProposalPanel />)
    fireEvent.click(await screen.findByText('＋ 新提案'))
    fireEvent.click(screen.getByText('下一步'))
    expect(await screen.findByText('先填标题')).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText('批量批改 v2.1'), { target: { value: '有标题了' } })
    fireEvent.click(screen.getByText('下一步'))
    await waitFor(() => expect(screen.queryByText('先填标题')).toBeNull())
  })

  it('抽屉「做了什么」：Why、每项目提交、HEAD；无提交时如实说还没有', async () => {
    fetchMock.mockImplementation((url: string) => {
      const path = String(url)
      if (path === '/workmate/api/proposals') {
        return Promise.resolve(ok({ proposals: [proposal({ projects: ['alpha'], status: 'implementing' })] }))
      }
      if (path === '/workmate/api/proposals/batch-grading-v2' || path.startsWith('/workmate/api/proposals/batch-grading-v2?')) {
        return Promise.resolve(ok({
          proposal: proposal({ projects: ['alpha'], status: 'implementing' }),
          why: '把任务面板的轮询改成事件推送',
          lifecycle: { status: 'implementing', hint: '实现中' },
          projects: [
            {
              project: 'alpha',
              root: '/repo/alpha',
              git: { branch: 'main', headShort: 'abc1234', dirtyCount: 2, isWorktree: false },
              commits: [{ hash: 'abc1234', short: 'abc1234', subject: 'feat: 先改一块' }],
            },
            { project: 'beta', root: '/repo/beta' },
          ],
        }))
      }
      if (path.includes('/api/config')) return Promise.resolve(ok({ taskExecutor: 'superagent', pollMs: 0 }))
      return Promise.resolve(ok({ occupancy: [], conflicts: [] }))
    })

    render(<ProposalPanel />)
    fireEvent.click(screen.getByText('列表'))
    const rows = await screen.findAllByText('批量批改 v2.1')
    fireEvent.click(rows[rows.length - 1] as HTMLElement)
    expect(await screen.findByText('做了什么')).toBeTruthy()
    expect(screen.getByText('把任务面板的轮询改成事件推送')).toBeTruthy()
    expect(screen.getByText(/feat: 先改一块/)).toBeTruthy()
    expect(screen.getAllByText(/abc1234/).length).toBeGreaterThan(0)
    expect(screen.getByText('还没有标记提交')).toBeTruthy()
  })

  it('抽屉事件行：时间开头 + kind 中文标签（含历史 team-* 行可读）', async () => {
    fetchMock.mockImplementation((url: string) => {
      const path = String(url)
      if (path === '/workmate/api/proposals') {
        return Promise.resolve(ok({ proposals: [proposal({ status: 'implementing' })] }))
      }
      if (path.startsWith('/workmate/api/proposals/batch-grading-v2/events')) {
        return Promise.resolve(ok({
          events: [
            { at: '2026-11-11T15:20:00.000Z', kind: 'transition', from: 'implementing', to: 'merging', actor: 'human' },
            { at: '2026-10-01T08:00:00.000Z', kind: 'team-run', actor: 'system' },
          ],
        }))
      }
      if (path.startsWith('/workmate/api/proposals/batch-grading-v2')) {
        return Promise.resolve(ok({ proposal: proposal(), lifecycle: { status: 'implementing', hint: '实现中' }, projects: [] }))
      }
      if (path.includes('/api/config')) return Promise.resolve(ok({ taskExecutor: 'superagent', pollMs: 0 }))
      return Promise.resolve(ok({ occupancy: [], conflicts: [] }))
    })

    render(<ProposalPanel />)
    fireEvent.click(screen.getByText('列表'))
    const eventRows = await screen.findAllByText('批量批改 v2.1')
    fireEvent.click(eventRows[eventRows.length - 1] as HTMLElement)
    expect(await screen.findByText(/· 状态迁移/)).toBeTruthy()
    expect(screen.getByText(/· 团队运行（历史）/)).toBeTruthy()
    expect(screen.getByText(/implementing→merging/)).toBeTruthy()
  })

  it('控制台样本不足行渲染门槛说明（T9）', async () => {
    const metricsBody = {
      proposals: 1,
      perProposal: [],
      gateFailureRanking: [],
      actorShare: { agent: 0, human: 0, system: 0 },
      reworkRate: 0,
      firstPassRate: 0,
      archived7d: 0,
      archived30d: 0,
      events: 0,
      skippedLines: 0,
    }
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes('/api/metrics')) return Promise.resolve(ok({ metrics: metricsBody, skippedLines: 0 }))
      if (String(url).includes('/api/bands')) {
        return Promise.resolve(ok({
          windowDays: 30,
          evaluations: [
            { metric: 'cycleTime', direction: 'high', status: 'insufficient-data', tier: 'normal', action: 'normal',
              current: 0, baseline: 0, sigma: 0, deviation: 0, samples: 12, baselineSamples: 7,
              note: '基线样本不足：至少 8 条，当前 7 条' },
          ],
        }))
      }
      return Promise.resolve(ok({}))
    })

    render(<ConsoleView onError={() => {}} />)
    expect(await screen.findByText('活跃提案')).toBeTruthy()
    expect(await screen.findByText('基线样本不足：至少 8 条，当前 7 条')).toBeTruthy()
    expect(screen.getByText('数据不足')).toBeTruthy()
  })
})
