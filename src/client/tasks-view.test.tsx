// @vitest-environment jsdom
/**
 * 任务视图的交互契约（change `adopt-superagent-openspec-source`, task 10）。
 * 只断言本变更新增的行为：四列渲染、主按钮按子状态切换、离线如实显示、
 * 新建表单校验、回答写回 inputs 而不是重走评估。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

  it('显示遗留目录并回收：首次回收不带 force（走服务端 isMergedInto 保护）', async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (url === '/workmate/api/tasks' && method === 'GET') return ok(board([]))
      if (url === '/workmate/api/worktrees/leftover') {
        return ok({ entries: [{ taskId: 'task-1', repo: 'repo', directory: 'workmate/workmate-x' }] })
      }
      if (url === '/workmate/api/worktrees/reclaim' && method === 'POST') {
        return ok({ taskId: 'task-1', repo: 'repo', directory: 'workmate/workmate-x', removed: true, portsReleased: false })
      }
      return ok({})
    })
    render(<TasksView onError={() => undefined} />)
    expect(await screen.findByText('workmate/workmate-x')).toBeTruthy()
    fireEvent.click(screen.getByText('回收'))
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => url === '/workmate/api/worktrees/reclaim')
      expect(call).toBeDefined()
      expect(String((call?.[1] as RequestInit).body)).toBe('{"taskId":"task-1"}')
    })
    // 回收成功：不出现「强制回收」。
    expect(screen.queryByText('强制回收')).toBeNull()
  })

  it('未合并被拒：条目行展示服务端 reason 并出现「强制回收」', async () => {
    const reason = '分支 workmate/workmate-x 尚未合并进 main — 确认后再回收'
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (url === '/workmate/api/tasks' && method === 'GET') return ok(board([]))
      if (url === '/workmate/api/worktrees/leftover') {
        return ok({ entries: [{ taskId: 'task-1', repo: 'repo', directory: 'workmate/workmate-x' }] })
      }
      if (url === '/workmate/api/worktrees/reclaim' && method === 'POST') {
        // 未合并：服务端拒绝并给原因（reclaim.ts 的 isMergedInto 保护）。
        return ok({ taskId: 'task-1', repo: 'repo', directory: 'workmate/workmate-x', removed: false, reason })
      }
      return ok({})
    })
    render(<TasksView onError={() => undefined} />)
    expect(await screen.findByText('workmate/workmate-x')).toBeTruthy()
    fireEvent.click(screen.getByText('回收'))
    const note = await screen.findByRole('note')
    expect(note.textContent).toContain('尚未合并进 main')
    expect(screen.getByText('强制回收')).toBeTruthy()
    // 底部文案与实际行为一致。
    expect(screen.getByText('回收删除 worktree 与分支；未合并的分支会被拒绝，确认放弃后可强制回收。')).toBeTruthy()
  })

  it('强制回收必须先 window.confirm：取消不发请求，确认才带 force', async () => {
    const reason = '分支 workmate/workmate-x 尚未合并进 main — 确认后再回收'
    const reclaimBodies: string[] = []
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (url === '/workmate/api/tasks' && method === 'GET') return ok(board([]))
      if (url === '/workmate/api/worktrees/leftover') {
        return ok({ entries: [{ taskId: 'task-1', repo: 'repo', directory: 'workmate/workmate-x' }] })
      }
      if (url === '/workmate/api/worktrees/reclaim' && method === 'POST') {
        reclaimBodies.push(String((init as RequestInit).body))
        return ok({ taskId: 'task-1', repo: 'repo', directory: 'workmate/workmate-x', removed: false, reason })
      }
      return ok({})
    })
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<TasksView onError={() => undefined} />)
    expect(await screen.findByText('workmate/workmate-x')).toBeTruthy()
    fireEvent.click(screen.getByText('回收'))
    const forceBtn = (await screen.findByText('强制回收')) as HTMLButtonElement
    // 等第一次回收的 busy 结束再点，避免 disabled 吞掉事件。
    await waitFor(() => expect(forceBtn.disabled).toBe(false))
    fireEvent.click(forceBtn)
    // confirm 取消：只有首次那次不带 force 的请求。
    expect(reclaimBodies).toHaveLength(1)
    expect(reclaimBodies[0]).toBe('{"taskId":"task-1"}')
    expect(confirm).toHaveBeenCalledWith('未合并的分支与未提交修改将一并删除。确定强制回收？')

    confirm.mockReturnValue(true)
    fireEvent.click(forceBtn)
    await waitFor(() => expect(reclaimBodies).toHaveLength(2))
    expect(JSON.parse(reclaimBodies[1] ?? '')).toEqual({ taskId: 'task-1', force: true })
  })
})

describe('primaryActionOf：每张卡只有一个主按钮', () => {
  it('待办给"指派"；未接入时给不可用文案', () => {
    expect(primaryActionOf(card({ lane: 'todo', substate: 'unassigned' })).kind).toBe('assign')
    expect(primaryActionOf(card({ lane: 'todo', substate: 'unassigned', connectable: false })).label).toBe('仓库未接入')
  })

  it('已停止的待办（投影 substate=stopped）给"重新打开"', () => {
    // 判据取投影给的 substate，不看 task.abandoned：阶段归属只来自服务端。
    expect(primaryActionOf(card({ lane: 'todo', substate: 'stopped', task: task({ abandoned: true }) })).kind).toBe('reopen')
    // 只有 task.abandoned、没有 stopped 子状态（旧服务端投影）时不重复推断：按普通待办处理。
    expect(primaryActionOf(card({ lane: 'todo', substate: 'unassigned', task: task({ abandoned: true }) })).kind).toBe('assign')
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

describe('卡片与抽屉的显示一致性（#5 #7）', () => {
  const renderBoard = async (cards: TaskCardView[]): Promise<void> => {
    fetchMock.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/api/worktrees/leftover')) return ok({ entries: [] })
      return ok(board(cards))
    })
    render(<TasksView onError={() => undefined} />)
    await screen.findByText(cards[0]?.task.title ?? '')
  }

  it('已停止的待办徽标写「已停止」，不写「未指派」', async () => {
    await renderBoard([
      card({ lane: 'todo', substate: 'stopped', task: task({ id: 't-stopped', title: '被停掉的待办', abandoned: true, assigned: false }) }),
    ])
    expect(screen.getAllByText('已停止').length).toBeGreaterThan(0)
    expect(screen.queryByText('未指派')).toBeNull()
  })

  it('卡片与抽屉用同一种紧凑时间，抽屉不再直出完整 ISO', async () => {
    const iso = '2026-11-09T08:57:45.336Z'
    await renderBoard([card({ lane: 'todo', substate: 'unassigned', task: task({ id: 't-time', title: '有时间戳的待办', updatedAt: iso }) })])
    // 卡片：11-09 08:57（精确值留在 title 里）
    expect(screen.getByText('11-09 08:57')).toBeTruthy()
    expect(screen.queryByText(iso)).toBeNull()

    fireEvent.click(screen.getByText('有时间戳的待办'))
    const dialog = await screen.findByRole('dialog')
    // 抽屉：同一格式，且不出现完整 ISO 串
    expect(within(dialog).getByText('11-09 08:57')).toBeTruthy()
    expect(within(dialog).queryByText(iso)).toBeNull()
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

describe('多执行器健康摘要（change support-multi-repo-executors）', () => {
  it('两个端点一个离线：顶部显示 2 个执行器，1 个离线，且不把整块任务视图判成离线', async () => {
    route(
      board([card({ lane: 'working', substate: 'working', task: task({ id: 't-on', title: '可达端点任务' }) })], {
        // 兼容投影：单值 health 取首个端点（review 疑问项 1），这里恰好是离线的那个；
        // 多端点时面板必须改以 endpoints 为准，否则会误判整块离线。
        health: { online: false, endpoint: 'http://127.0.0.1:3082', reason: '连接被拒' },
        endpoints: [
          { endpoint: 'http://127.0.0.1:3082', online: false, reason: '连接被拒' },
          { endpoint: 'http://127.0.0.1:3083', online: true },
        ],
        notes: ['执行器离线：http://127.0.0.1:3082 连接被拒'],
      }),
    )
    render(<TasksView onError={() => undefined} />)
    expect(await screen.findByText('2 个执行器，1 个离线')).toBeTruthy()
    // 可达端点服务的待办仍正常投影。
    expect(screen.getByText('可达端点任务')).toBeTruthy()
    // 单个端点不可达 ≠ 整块离线：不应出现整块离线的红色横幅，离线细节以 note 展示。
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('执行器离线：http://127.0.0.1:3082 连接被拒')).toBeTruthy()
  })

  it('多端点全在线：仍显示执行器数量，离线数为 0', async () => {
    route(
      board([], {
        endpoints: [
          { endpoint: 'http://127.0.0.1:3082', online: true },
          { endpoint: 'http://127.0.0.1:3083', online: true },
        ],
      }),
    )
    render(<TasksView onError={() => undefined} />)
    expect(await screen.findByText('2 个执行器，0 个离线')).toBeTruthy()
  })

  it('所有端点都离线时才给出整块离线横幅', async () => {
    route(
      board([], {
        health: { online: false, endpoint: 'http://127.0.0.1:3082', reason: '两个端点都不可达' },
        endpoints: [
          { endpoint: 'http://127.0.0.1:3082', online: false, reason: '连接被拒' },
          { endpoint: 'http://127.0.0.1:3083', online: false, reason: '超时' },
        ],
      }),
    )
    render(<TasksView onError={() => undefined} />)
    expect(await screen.findByText('2 个执行器，2 个离线')).toBeTruthy()
    expect(await screen.findByText(/两个端点都不可达/)).toBeTruthy()
  })
})

describe('未接入执行器的卡片', () => {
  it('显示「未接入执行器（仓库 X）」且指派按钮保持禁用', async () => {
    route(
      board([
        card({
          lane: 'todo',
          substate: 'unassigned',
          connectable: false,
          unservedRepo: '/Users/fred/workspace/repo-b',
          task: task({ id: 't-unserved', title: '跨仓待办', repo: '/Users/fred/workspace/repo-b' }),
        }),
      ]),
    )
    render(<TasksView onError={() => undefined} />)
    await screen.findByText('跨仓待办')
    // 原因写在卡片正文里，而不是只放在 title / hover。
    expect(screen.getByText('未接入执行器（仓库 /Users/fred/workspace/repo-b）')).toBeTruthy()
    const assign = screen.getByRole('button', { name: '仓库未接入' }) as HTMLButtonElement
    expect(assign.disabled).toBe(true)
  })

  it('服务端未提供 unservedRepo 时回退到 task.repo', async () => {
    route(
      board([
        card({
          lane: 'todo',
          substate: 'unassigned',
          connectable: false,
          task: task({ id: 't-unserved-2', title: '回退仓库待办', repo: 'repo-b' }),
        }),
      ]),
    )
    render(<TasksView onError={() => undefined} />)
    await screen.findByText('回退仓库待办')
    expect(screen.getByText('未接入执行器（仓库 repo-b）')).toBeTruthy()
  })

  it('已接入的待办不显示未接入提示，指派按钮可用', async () => {
    route(
      board([
        card({ lane: 'todo', substate: 'unassigned', connectable: true, task: task({ id: 't-served', title: '同仓待办', repo: 'dsh-Helmsman' }) }),
      ]),
    )
    render(<TasksView onError={() => undefined} />)
    await screen.findByText('同仓待办')
    expect(screen.queryByText(/未接入执行器/)).toBeNull()
    expect((screen.getByRole('button', { name: '指派' }) as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('单端点旧文案不回归', () => {
  it('未提供 endpoints 时保留「执行器在线 · endpoint」与状态点', async () => {
    route(board([]))
    const { container } = render(<TasksView onError={() => undefined} />)
    expect(await screen.findByText('执行器在线 · http://127.0.0.1:3082')).toBeTruthy()
    expect(container.querySelector('.wm-conn-dot')?.className).toContain('ok')
  })

  it('只给一个端点时仍按单值 health 显示旧文案，不出现多执行器摘要', async () => {
    route(board([], { endpoints: [{ endpoint: 'http://127.0.0.1:3082', online: true }] }))
    render(<TasksView onError={() => undefined} />)
    expect(await screen.findByText('执行器在线 · http://127.0.0.1:3082')).toBeTruthy()
    expect(screen.queryByText(/个执行器，/)).toBeNull()
  })

  it('单端点离线时红色横幅与 notes 抑制行为保持不变', async () => {
    route(
      board([], {
        health: { online: false, endpoint: 'http://127.0.0.1:3082', reason: '连接被拒' },
        endpoints: [{ endpoint: 'http://127.0.0.1:3082', online: false, reason: '连接被拒' }],
        notes: ['执行器离线：连接被拒'],
      }),
    )
    render(<TasksView onError={() => undefined} />)
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('执行器离线：连接被拒')
    // 旧行为：整块离线时离线条目由红色横幅统一说明，note 不再重复展示。
    expect(screen.queryByText('执行器离线：连接被拒')).toBeNull()
  })
})
