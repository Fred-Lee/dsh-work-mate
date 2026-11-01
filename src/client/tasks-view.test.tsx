// @vitest-environment jsdom
/**
 * 任务视图的交互契约（change `adopt-superagent-openspec-source`, task 10）。
 * 只断言本变更新增的行为：四列渲染、主按钮按子状态切换、离线如实显示、
 * 新建表单校验、回答写回 inputs 而不是重走评估。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TasksView, primaryActionOf } from './TasksView'
import type { TaskCardView } from './api'

const fetchMock = vi.fn()

beforeEach(() => vi.stubGlobal('fetch', fetchMock))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  fetchMock.mockReset()
  vi.restoreAllMocks()
})

const ok = (body: unknown): { ok: boolean; status: number; json: () => Promise<unknown> } => ({
  ok: true,
  status: 200,
  json: async () => body,
})

const task = (overrides: Partial<TaskCardView['task']> = {}): TaskCardView['task'] => ({
  id: 'task-1',
  title: '异步化 Run',
  intent: '把同步调用改成 start/stop',
  repo: 'dsh-Helmsman',
  baseBranch: 'main',
  acceptance: '立即返回',
  priority: 'P1',
  mode: 'superagent',
  dependsOn: [],
  assigned: true,
  abandoned: false,
  attempt: 1,
  createdBy: 'workmate:fred',
  createdAt: '2026-11-02T00:00:00.000Z',
  updatedAt: '2026-11-02T00:00:00.000Z',
  ...overrides,
})

const card = (overrides: Partial<TaskCardView> = {}): TaskCardView => ({
  lane: 'working',
  substate: 'working',
  task: task(),
  connectable: true,
  ...overrides,
})

const board = (cards: TaskCardView[], overrides: Record<string, unknown> = {}): unknown => ({
  cards,
  lanes: {
    todo: cards.filter((entry) => entry.lane === 'todo'),
    working: cards.filter((entry) => entry.lane === 'working'),
    attention: cards.filter((entry) => entry.lane === 'attention'),
    done: cards.filter((entry) => entry.lane === 'done'),
  },
  health: { online: true, endpoint: 'http://127.0.0.1:3082' },
  attention: cards.filter((entry) => entry.lane === 'attention').length,
  notes: [],
  ...overrides,
})

const route = (body: unknown, extra: (url: string, method: string, init?: RequestInit) => unknown = () => ({})): void => {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    if (url === '/workmate/api/tasks' && method === 'GET') return ok(body)
    if (url === '/workmate/api/worktrees/leftover') return ok({ entries: [] })
    return ok(extra(url, method, init))
  })
}

describe('四列与状态', () => {
  it('四列都渲染，且各列只放自己的卡', async () => {
    route(
      board([
        card({ lane: 'todo', substate: 'unassigned', task: task({ id: 't-todo', title: '待办项' }) }),
        card({ lane: 'working', substate: 'submitted', task: task({ id: 't-work', title: '执行项' }) }),
        card({ lane: 'attention', substate: 'answer', note: '允许升级？', task: task({ id: 't-attn', title: '需要你' }) }),
        card({ lane: 'done', substate: 'merged', task: task({ id: 't-done', title: '完成项' }) }),
      ]),
    )
    render(<TasksView onError={() => undefined} />)
    await screen.findByText('待办项')
    for (const label of ['待办', '执行中', '需要我', '已完成']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    }
    const todoColumn = screen.getByLabelText('待办')
    expect(todoColumn.textContent).toContain('待办项')
    expect(todoColumn.textContent).not.toContain('执行项')
  })

  it('离线如实显示，且不出现"已完成"', async () => {
    route(
      board([card({ lane: 'working', substate: 'unknown', task: task({ title: '离线任务' }) })], {
        health: { online: false, endpoint: 'http://127.0.0.1:3082', reason: '连接被拒' },
      }),
    )
    render(<TasksView onError={() => undefined} />)
    await screen.findAllByText(/执行器离线/)
    expect(screen.getAllByText(/连接被拒/).length).toBeGreaterThan(0)
    expect(screen.queryByText('已合并')).toBeNull()
  })

  it('需要我的卡显示问题原文', async () => {
    route(board([card({ lane: 'attention', substate: 'answer', note: '测试依赖是否允许升级？', task: task({ title: '提问任务' }) })]))
    render(<TasksView onError={() => undefined} />)
    expect(await screen.findByText('测试依赖是否允许升级？')).toBeTruthy()
  })

  it('显示遗留目录并可回收', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (url === '/workmate/api/tasks' && method === 'GET') return ok(board([]))
      if (url === '/workmate/api/worktrees/leftover') {
        return ok({ entries: [{ taskId: 'task-1', repo: 'repo', directory: 'workmate/workmate-x' }] })
      }
      return ok({})
    })
    render(<TasksView onError={() => undefined} />)
    expect(await screen.findByText('workmate/workmate-x')).toBeTruthy()
    fireEvent.click(screen.getByText('回收'))
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => url === '/workmate/api/worktrees/reclaim')).toBe(true),
    )
  })
})

describe('primaryActionOf：每张卡只有一个主按钮', () => {
  it('待办给"指派"；未接入时给不可用文案', () => {
    expect(primaryActionOf(card({ lane: 'todo', substate: 'unassigned' })).kind).toBe('assign')
    expect(primaryActionOf(card({ lane: 'todo', substate: 'unassigned', connectable: false })).label).toBe('仓库未接入')
  })

  it('已放弃的待办给"重新打开"', () => {
    expect(primaryActionOf(card({ lane: 'todo', substate: 'unassigned', task: task({ abandoned: true }) })).kind).toBe('reopen')
  })

  it('需要我：待回答给回答、待验收给验收、受阻给���试', () => {
    expect(primaryActionOf(card({ lane: 'attention', substate: 'answer' })).kind).toBe('reply')
    expect(primaryActionOf(card({ lane: 'attention', substate: 'review' })).kind).toBe('review')
    expect(primaryActionOf(card({ lane: 'attention', substate: 'blocked' })).kind).toBe('retry')
    expect(primaryActionOf(card({ lane: 'attention', substate: 'failed' })).kind).toBe('retry')
  })

  it('执行中与已完成没有主按钮（只能看详情）', () => {
    expect(primaryActionOf(card({ lane: 'working', substate: 'working' })).kind).toBe('none')
    expect(primaryActionOf(card({ lane: 'done', substate: 'merged' })).kind).toBe('none')
  })
})

describe('新建与回答', () => {
  it('空目标不提交并给错误', async () => {
    route(board([]))
    render(<TasksView onError={() => undefined} />)
    fireEvent.click(await screen.findByText('＋ 新建待办'))
    fireEvent.click(screen.getByText('创建'))
    expect(await screen.findByText('先写一句目标')).toBeTruthy()
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toBe(false)
  })

  it('填好后 POST /api/tasks', async () => {
    route(board([]))
    render(<TasksView onError={() => undefined} />)
    fireEvent.click(await screen.findByText('＋ 新建待办'))
    fireEvent.change(screen.getByPlaceholderText(/把任务面板的轮询/), { target: { value: '改成事件推送' } })
    fireEvent.click(screen.getByText('创建'))
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) => url === '/workmate/api/tasks' && (init as RequestInit | undefined)?.method === 'POST',
        ),
      ).toBe(true),
    )
  })

  it('回答 POST 到 reply 端点并带上文本', async () => {
    route(board([card({ lane: 'attention', substate: 'answer', note: '允许吗？', task: task({ id: 'task-9', title: '提问' }) })]))
    render(<TasksView onError={() => undefined} />)
    await screen.findByText('提问')
    fireEvent.click(screen.getByText('回答'))
    fireEvent.change(await screen.findByPlaceholderText(/给出决定/), { target: { value: '允许，但要单独 commit' } })
    fireEvent.click(screen.getByText('提交回答'))
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/tasks/task-9/reply'))
      expect(call).toBeDefined()
      expect(String((call?.[1] as RequestInit).body)).toContain('允许')
    })
  })
})
