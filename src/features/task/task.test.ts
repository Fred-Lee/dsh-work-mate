import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TaskFileStore, TaskStoreCorruptError } from './files.ts'
import { TaskServiceImpl, defaultTaskFile } from './service.ts'
import type { SuperagentClient } from '../superagent/client.ts'
import type { TicketView } from '../superagent/project.ts'

let dir: string
let store: TaskFileStore
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wm-task-'))
  store = new TaskFileStore({ rootDir: dir })
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const fakeClient = (
  options: {
    tickets?: TicketView[]
    online?: boolean
    reason?: string
    actions?: boolean
    /** 多端点聚合后的逐端点健康（模拟 SuperagentPool 的产出）。 */
    endpoints?: Array<{ endpoint: string; online: boolean; reason?: string; paused?: boolean }>
  } = {},
): {
  client: SuperagentClient
  called: Array<{ ticketId: string; action: string; endpoint?: string }>
} => {
  const called: Array<{ ticketId: string; action: string; endpoint?: string }> = []
  const online = options.online ?? true
  const client = {
    async health() {
      return {
        ...(online
          ? { online: true, endpoint: 'http://127.0.0.1:3082' }
          : { online: false, endpoint: 'http://127.0.0.1:3082', reason: options.reason ?? '连接被拒' }),
        ...(options.endpoints !== undefined ? { endpoints: options.endpoints } : {}),
      }
    },
    async tickets() {
      return online
        ? {
            online: true,
            tickets: options.tickets ?? [],
            ...(options.endpoints !== undefined ? { endpoints: options.endpoints } : {}),
          }
        : { online: false, tickets: [], reason: options.reason ?? '连接被拒' }
    },
    async action(ticketId: string, action: 'retry' | 'stop', endpoint?: string) {
      called.push({ ticketId, action, ...(endpoint !== undefined ? { endpoint } : {}) })
      return { ok: options.actions ?? true }
    },
  } as unknown as SuperagentClient
  return { client, called }
}

const service = (client: SuperagentClient, extra: Record<string, unknown> = {}): TaskServiceImpl =>
  new TaskServiceImpl({ store, superagent: client, ...extra })

describe('TaskFileStore', () => {
  it('文件不存在视为空表', async () => {
    expect(await store.load()).toEqual({ version: 1, tasks: [] })
  })

  it('损坏的 JSON fail-closed', async () => {
    await writeFile(store.paths.tasks, '{ oops', 'utf8')
    await expect(store.load()).rejects.toBeInstanceOf(TaskStoreCorruptError)
  })

  it('结构不对时拒绝', async () => {
    await writeFile(store.paths.tasks, JSON.stringify({ tasks: [] }), 'utf8')
    await expect(store.load()).rejects.toThrowError(/version: 1/)
  })

  it('原子写后能读回', async () => {
    await store.save({
      version: 1,
      tasks: [
        {
          id: 'a', title: 'a', intent: 'a', repo: 'r', baseBranch: 'main', acceptance: '',
          priority: 'P2', mode: 'record', dependsOn: [], assigned: false, abandoned: false,
          attempt: 0, createdBy: 'workmate:panel', createdAt: 't', updatedAt: 't',
        },
      ],
    })
    expect((await store.load()).tasks).toHaveLength(1)
  })

  it('inputs seq 从已有最大行继续', async () => {
    await store.appendInput({ seq: 3, taskId: 'a', text: 'x', by: 'u', at: 't' })
    await store.appendInput({ seq: 7, taskId: 'a', text: 'y', by: 'u', at: 't' })
    expect(await store.maxInputSeq()).toBe(7)
  })

  it('默认任务文件位于 rootDir', () => {
    expect(defaultTaskFile('/x')).toBe(join('/x', 'tasks.json'))
  })
})

describe('TaskServiceImpl.create', () => {
  it('仅记录模式不指派', async () => {
    const { client } = fakeClient()
    const task = await service(client).create({ intent: '调研', repo: 'r', mode: 'record' })
    expect(task.assigned).toBe(false)
    expect(task.attempt).toBe(0)
    expect(task.mode).toBe('record')
  })

  it('指派模式直接置 assigned 与 attempt=1', async () => {
    const { client } = fakeClient()
    const task = await service(client).create({ intent: '做', repo: 'r', mode: 'superagent' })
    expect(task.assigned).toBe(true)
    expect(task.attempt).toBe(1)
  })

  it('空目标被拒', async () => {
    const { client } = fakeClient()
    await expect(service(client).create({ intent: '   ', repo: 'r' })).rejects.toThrowError(/目标不能为空/)
  })

  it('标题默认取目标首行并截断', async () => {
    const { client } = fakeClient()
    const task = await service(client).create({ intent: `${'x'.repeat(300)}\n第二行`, repo: 'r' })
    expect(task.title.length).toBe(200)
  })
})

describe('TaskServiceImpl.assign / stop / reopen', () => {
  it('assign 置 assigned 并递增 attempt', async () => {
    const { client } = fakeClient()
    const svc = service(client)
    const created = await svc.create({ intent: '做', repo: 'r', mode: 'record' })
    const assigned = await svc.assign(created.id)
    expect(assigned.assigned).toBe(true)
    expect(assigned.attempt).toBe(1)
    const retried = await svc.assign(created.id, { retry: true })
    expect(retried.attempt).toBe(2)
  })

  it('仓库未接入时拒绝指派', async () => {
    const { client } = fakeClient()
    const svc = service(client, { executorRepo: 'dsh-Helmsman' })
    const created = await svc.create({ intent: '做', repo: 'other-repo', mode: 'record' })
    await expect(svc.assign(created.id)).rejects.toThrowError(/还没有接入执行器/)
  })

  // change `support-multi-repo-executors`：判定从单值改成集合，错误要点名仓库与集合。
  it('集合判定：不在已接入集合内时拒绝指派，错误点明仓库与集合', async () => {
    const { client } = fakeClient()
    const svc = service(client, { executorRepos: ['/repo/a'] })
    const created = await svc.create({ intent: '做', repo: '/repo/b', mode: 'record' })
    await expect(svc.assign(created.id)).rejects.toThrowError(
      /仓库 \/repo\/b 还没有接入执行器（已接入：\/repo\/a）/,
    )
  })

  it('集合判定：集合内的仓库可指派（多仓库都行）', async () => {
    const { client } = fakeClient()
    const svc = service(client, { executorRepos: ['/repo/a', '/repo/b'] })
    for (const repo of ['/repo/a', '/repo/b']) {
      const created = await svc.create({ intent: '做', repo, mode: 'record' })
      expect((await svc.assign(created.id)).assigned).toBe(true)
    }
  })

  it('executorRepo 单值仍兼容（长度 1 的特例，与集合合并去重）', async () => {
    const { client } = fakeClient()
    // 单值与集合同时给、且重复/带空串：归一后仍只包含 '/repo/a'。
    const svc = service(client, { executorRepo: '/repo/a', executorRepos: ['/repo/a', '  '] })
    const allowed = await svc.create({ intent: '做', repo: '/repo/a', mode: 'record' })
    expect((await svc.assign(allowed.id)).assigned).toBe(true)
    const denied = await svc.create({ intent: '做', repo: '/repo/b', mode: 'record' })
    await expect(svc.assign(denied.id)).rejects.toThrowError(/已接入：\/repo\/a）/)
  })

  it('空集合不限制：所有仓库都可指派（与旧行为一致）', async () => {
    const { client } = fakeClient()
    const svc = service(client, { executorRepos: [], executorRepo: '' })
    const created = await svc.create({ intent: '做', repo: 'any-repo', mode: 'record' })
    expect((await svc.assign(created.id)).assigned).toBe(true)
  })

  it('stop 标记放弃并代理执行器的 stop', async () => {
    const { client, called } = fakeClient({ tickets: [{ id: 'tkt-1', title: '做' }] })
    const svc = service(client)
    const created = await svc.create({ intent: '做', repo: 'r', mode: 'superagent' })
    const result = await svc.stop(created.id)
    expect(result.task.abandoned).toBe(true)
    expect(result.stopped).toBe('tkt-1')
    expect(called).toEqual([{ ticketId: 'tkt-1', action: 'stop' }])
  })

  it('reopen 清放弃但不递增 attempt', async () => {
    const { client } = fakeClient()
    const svc = service(client)
    const created = await svc.create({ intent: '做', repo: 'r', mode: 'superagent' })
    await svc.stop(created.id)
    const reopened = await svc.reopen(created.id)
    expect(reopened.abandoned).toBe(false)
    expect(reopened.attempt).toBe(created.attempt)
  })

  it('不存在的任务报可读错误', async () => {
    const { client } = fakeClient()
    await expect(service(client).assign('ghost')).rejects.toThrowError(/任务不存在/)
  })
})

describe('TaskServiceImpl.reply', () => {
  it('追加到 inputs.jsonl，seq 递增', async () => {
    const { client } = fakeClient()
    const svc = service(client)
    const created = await svc.create({ intent: '做', repo: 'r', mode: 'superagent' })
    expect((await svc.reply(created.id, '第一条')).seq).toBe(1)
    expect((await svc.reply(created.id, '第二条')).seq).toBe(2)
  })

  it('空回答被拒', async () => {
    const { client } = fakeClient()
    const svc = service(client)
    const created = await svc.create({ intent: '做', repo: 'r', mode: 'superagent' })
    await expect(svc.reply(created.id, '  ')).rejects.toThrowError(/回答不能为空/)
  })
})

describe('TaskServiceImpl.board', () => {
  it('未指派进待办', async () => {
    const { client } = fakeClient()
    const svc = service(client)
    await svc.create({ intent: '做', repo: 'r', mode: 'record' })
    const board = await svc.board()
    expect(board.lanes.todo).toHaveLength(1)
    expect(board.lanes.todo[0]?.substate).toBe('unassigned')
  })

  it('已指派但无 Ticket 显示待接受', async () => {
    const { client } = fakeClient()
    const svc = service(client)
    await svc.create({ intent: '做', repo: 'r', mode: 'superagent' })
    const board = await svc.board()
    expect(board.lanes.working[0]?.substate).toBe('submitted')
  })

  it('person/answer 进需要我并带问题', async () => {
    const { client } = fakeClient({
      tickets: [{ id: 't1', title: '做', stage: 'person', action: 'answer', attention: { question: '允许升级？' } }],
    })
    const svc = service(client)
    await svc.create({ intent: '做', repo: 'r', mode: 'superagent' })
    const board = await svc.board()
    expect(board.lanes.attention).toHaveLength(1)
    expect(board.lanes.attention[0]?.note).toBe('允许升级？')
    expect(board.attention).toBe(1)
  })

  it('ended/merged 进已完成', async () => {
    const { client } = fakeClient({ tickets: [{ id: 't1', title: '做', ended: { outcome: 'merged' } }] })
    const svc = service(client)
    await svc.create({ intent: '做', repo: 'r', mode: 'superagent' })
    const board = await svc.board()
    expect(board.lanes.done[0]?.substate).toBe('merged')
  })

  it('离线时给提示且不假装完成', async () => {
    const { client } = fakeClient({ online: false, reason: '连接被拒' })
    const svc = service(client)
    await svc.create({ intent: '做', repo: 'r', mode: 'superagent' })
    const board = await svc.board()
    expect(board.health.online).toBe(false)
    expect(board.notes.some((note) => note.includes('离线'))).toBe(true)
    expect(board.lanes.done).toHaveLength(0)
    expect(board.lanes.working[0]?.substate).toBe('unknown')
  })

  it('观察到 Ticket 时把 id 与目录缓存进任务记录（回滚的第一级定位）', async () => {
    const { client } = fakeClient({
      tickets: [{ id: 't1', title: '做', stage: 'working', directory: '/repo/.workmates/workmate-x-abcdef123456' }],
    })
    const svc = service(client)
    const created = await svc.create({ intent: '做', repo: 'r', mode: 'superagent' })
    await svc.board()
    const saved = (await svc.list()).find((task) => task.id === created.id)
    expect(saved?.ticketId).toBe('t1')
    expect(saved?.directory).toBe('/repo/.workmates/workmate-x-abcdef123456')

    // 未变化的第二轮不重写；再观察到一个新目录才更新。
    await svc.board()
    expect((await svc.list()).find((task) => task.id === created.id)?.directory).toBe('/repo/.workmates/workmate-x-abcdef123456')
  })

  it('执行器离线时保留已缓存的 Ticket 与目录（不被清空）', async () => {
    const { client } = fakeClient({
      tickets: [{ id: 't1', title: '做', stage: 'working', directory: '/repo/.workmates/workmate-x-abcdef123456' }],
    })
    const svc = service(client)
    await svc.create({ intent: '做', repo: 'r', mode: 'superagent' })
    await svc.board()

    const offline = fakeClient({ online: false, reason: '连接被拒' })
    const offlineSvc = service(offline.client)
    await offlineSvc.board()
    expect((await offlineSvc.list())[0]?.directory).toBe('/repo/.workmates/workmate-x-abcdef123456')
  })

  it('缓存回写用重读合并，不会覆盖同时在面板新建的待办', async () => {
    const { client } = fakeClient({ tickets: [{ id: 't1', title: '做', stage: 'working', directory: '/d' }] })
    // create 一次、board 读一次、缓存回写前重读一次：第三次 load 才是"合并前的最新快照"。
    let loads = 0
    const racing = {
      paths: store.paths,
      async load() {
        loads += 1
        const file = await store.load()
        if (loads === 3) {
          file.tasks.push({
            ...file.tasks[0]!,
            id: 'task-concurrent',
            title: '同时新建的',
            intent: '同时新建的',
            attempt: 0,
            assigned: false,
            mode: 'record' as const,
          })
        }
        return file
      },
      save: (file: { version: 1; tasks: unknown[] }) => store.save(file as never),
      appendInput: (row: never) => store.appendInput(row),
      maxInputSeq: () => store.maxInputSeq(),
    }
    const svc = new TaskServiceImpl({ store: racing as unknown as TaskFileStore, superagent: client })
    await svc.create({ intent: '做', repo: 'r', mode: 'superagent' })
    await svc.board()
    const ids = (await svc.list()).map((task) => task.id)
    expect(ids).toContain('task-concurrent')
  })

  // change `support-multi-repo-executors`：集合判定 + 多端点聚合。
  it('未接入仓库的卡片带 unservedRepo，已接入的不带', async () => {
    const { client } = fakeClient()
    const svc = service(client, { executorRepos: ['/repo/a'] })
    await svc.create({ intent: 'a', repo: '/repo/a', mode: 'record' })
    await svc.create({ intent: 'b', repo: '/repo/b', mode: 'record' })
    const board = await svc.board()
    const served = board.cards.find((card) => card.task.repo === '/repo/a')!
    const unserved = board.cards.find((card) => card.task.repo === '/repo/b')!
    expect(served.connectable).toBe(true)
    expect(served.unservedRepo).toBeUndefined()
    expect(unserved.connectable).toBe(false)
    expect(unserved.unservedRepo).toBe('/repo/b')
  })

  it('单端点客户端：endpoints 合成为长度 1 的数组，旧 health 形状不变', async () => {
    const { client } = fakeClient()
    const svc = service(client)
    await svc.create({ intent: '做', repo: 'r', mode: 'superagent' })
    const board = await svc.board()
    expect(board.health).toEqual({ online: true, endpoint: 'http://127.0.0.1:3082' })
    expect(board.endpoints).toEqual([{ endpoint: 'http://127.0.0.1:3082', online: true }])
  })

  it('多端点：单个离线端点不抹掉在线端点的 Ticket 投影，notes 给出离线原因', async () => {
    const endpoints = [
      { endpoint: 'http://127.0.0.1:3082', online: true },
      { endpoint: 'http://127.0.0.1:3083', online: false, reason: '请求超时' },
    ]
    const { client } = fakeClient({
      endpoints,
      tickets: [{ id: 'tkt-1', title: '做', stage: 'working', endpoint: 'http://127.0.0.1:3082' }],
    })
    const svc = service(client)
    await svc.create({ intent: '做', repo: 'r', mode: 'superagent' })
    const board = await svc.board()
    // 旧面板读单值 health：取首端点；完整集合在 endpoints。
    expect(board.health).toEqual({ online: true, endpoint: 'http://127.0.0.1:3082' })
    expect(board.endpoints).toEqual(endpoints)
    expect(board.notes).toContain('执行器离线（http://127.0.0.1:3083）：请求超时')
    const card = board.cards[0]!
    expect(card.ticket?.id).toBe('tkt-1')
    expect(card.ticket?.endpoint).toBe('http://127.0.0.1:3082')
    expect(card.lane).toBe('working')
  })

  it('多端点全离线：health 用聚合原因，逐端点原因进 notes', async () => {
    const endpoints = [
      { endpoint: 'http://127.0.0.1:3082', online: false, reason: '连接被拒' },
      { endpoint: 'http://127.0.0.1:3083', online: false, reason: '请求超时' },
    ]
    const aggregate = '所有执行器均不可达：http://127.0.0.1:3082（连接被拒）、http://127.0.0.1:3083（请求超时）'
    const { client } = fakeClient({ online: false, reason: aggregate, endpoints })
    const svc = service(client)
    await svc.create({ intent: '做', repo: 'r', mode: 'superagent' })
    const board = await svc.board()
    expect(board.health.online).toBe(false)
    expect(board.health.endpoint).toBe('http://127.0.0.1:3082')
    expect(board.health.reason).toBe(aggregate)
    expect(board.endpoints).toEqual(endpoints)
    expect(board.notes).toContain(`执行器离线：${aggregate}`)
    expect(board.notes).toContain('执行器离线（http://127.0.0.1:3083）：请求超时')
  })

  it('stop 把 Ticket 所属端点交给 action 路由（多端点）', async () => {
    const { client, called } = fakeClient({
      tickets: [{ id: 'tkt-1', title: '做', endpoint: 'http://127.0.0.1:3083' }],
    })
    const svc = service(client)
    const created = await svc.create({ intent: '做', repo: 'r', mode: 'superagent' })
    expect((await svc.stop(created.id)).stopped).toBe('tkt-1')
    expect(called).toEqual([
      { ticketId: 'tkt-1', action: 'stop', endpoint: 'http://127.0.0.1:3083' },
    ])
  })

  it('四列互斥：一张卡只出现在一列', async () => {    const { client } = fakeClient()
    const svc = service(client)
    await svc.create({ intent: 'a', repo: 'r', mode: 'record' })
    await svc.create({ intent: 'b', repo: 'r', mode: 'superagent' })
    const board = await svc.board()
    const total = board.lanes.todo.length + board.lanes.working.length + board.lanes.attention.length + board.lanes.done.length
    expect(total).toBe(2)
  })
})

describe('REST 路由（与既有 api.test 同一套 Router）', () => {
  it('装配任务服务后能列任务并建任务', async () => {
    const { Router } = await import('../../http.ts')
    const { registerApiRoutes } = await import('../../api.ts')
    const { client } = fakeClient()
    const router = new Router()
    const svc = service(client)
    registerApiRoutes(router, {
      proposals: {
        list: async () => [],
        get: async () => undefined,
      } as never,
      archive: {} as never,
      registry: {} as never,
      openspecRoot: 'openspec',
      projectRoot: '',
      qualitySyncEnabled: false,
      claudeAssetsEnabled: false,
      tasks: svc,
      taskExecutor: 'superagent',
    })
    const created = await svc.create({ intent: '做', repo: 'r', mode: 'record' })
    const board = await svc.board()
    expect(board.cards[0]?.task.id).toBe(created.id)
  })
})

describe('端口规划（任务维度）', () => {
  it('键包含提案、项目与任务；无提案时用项目维度', async () => {
    const { portKeyOf } = await import('./plan.ts')
    expect(portKeyOf({ proposalId: 'p1', project: 'repo', taskId: 't1' })).toBe('p1--repo--t1')
    expect(portKeyOf({ project: 'repo', taskId: 't1' })).toBe('repo--t1')
  })

  it('同一任务重复分配拿到同一段；不同任务互不相同', async () => {
    const { PortAllocator } = await import('../worktree/port-allocator.ts')
    const { planTaskPorts } = await import('./plan.ts')
    const allocator = new PortAllocator({ rootDir: dir, subdir: 'workmate' } as never, 3000, 10)
    const first = await planTaskPorts(allocator, { proposalId: 'p1', project: 'repo', taskId: 't1' })
    const again = await planTaskPorts(allocator, { proposalId: 'p1', project: 'repo', taskId: 't1' })
    const other = await planTaskPorts(allocator, { proposalId: 'p1', project: 'repo', taskId: 't2' })
    expect(again).toEqual(first)
    expect(other).not.toEqual(first)
  })

  it('释放后再次分配不复用旧段（避免与仍在运行的服务撞端口）', async () => {
    const { PortAllocator } = await import('../worktree/port-allocator.ts')
    const { planTaskPorts, releaseTaskPorts } = await import('./plan.ts')
    const allocator = new PortAllocator({ rootDir: dir, subdir: 'workmate' } as never, 3000, 10)
    const first = await planTaskPorts(allocator, { project: 'repo', taskId: 't1' })
    expect(await releaseTaskPorts(allocator, { project: 'repo', taskId: 't1' })).toBe(true)
    const second = await planTaskPorts(allocator, { project: 'repo', taskId: 't2' })
    expect(second).not.toEqual(first)
  })

  it('旧提案级键可单独释放', async () => {
    const { PortAllocator } = await import('../worktree/port-allocator.ts')
    const { releaseLegacyPorts } = await import('./plan.ts')
    const allocator = new PortAllocator({ rootDir: dir, subdir: 'workmate' } as never, 3000, 10)
    await allocator.allocate('p1--repo')
    expect(await releaseLegacyPorts(allocator, { proposalId: 'p1', project: 'repo' })).toBe(true)
  })
})

describe('G2 交接：ensureImplementationTasks', () => {
  it('每个 target 一条待办，带提案 id 与基线分支', async () => {
    const { client } = fakeClient()
    const svc = service(client)
    const result = await svc.ensureImplementationTasks({
      proposalId: 'add-thing',
      title: '异步化 Run',
      targets: [
        { project: 'repo-a', baseBranch: 'main' },
        { project: 'repo-b', baseBranch: 'test' },
      ],
    })
    expect(result.created).toHaveLength(2)
    expect(result.created[0]?.proposalId).toBe('add-thing')
    expect(result.created[1]?.baseBranch).toBe('test')
    expect(result.created.every((task) => task.assigned && task.mode === 'superagent')).toBe(true)
  })

  it('幂等：重复交接不重复建单', async () => {
    const { client } = fakeClient()
    const svc = service(client)
    const first = await svc.ensureImplementationTasks({
      proposalId: 'add-thing',
      title: 'T',
      targets: [{ project: 'repo-a', baseBranch: 'main' }],
    })
    const second = await svc.ensureImplementationTasks({
      proposalId: 'add-thing',
      title: 'T',
      targets: [{ project: 'repo-a', baseBranch: 'main' }],
    })
    expect(first.created).toHaveLength(1)
    expect(second.created).toHaveLength(0)
    expect(second.existing).toHaveLength(1)
  })

  it('放弃的旧待办不阻止新建', async () => {
    const { client } = fakeClient()
    const svc = service(client)
    await svc.ensureImplementationTasks({ proposalId: 'p', title: 'T', targets: [{ project: 'r', baseBranch: 'main' }] })
    const file = await store.load()
    const first = file.tasks[0] as (typeof file.tasks)[number]
    first.abandoned = true
    await store.save(file)
    const again = await svc.ensureImplementationTasks({ proposalId: 'p', title: 'T', targets: [{ project: 'r', baseBranch: 'main' }] })
    expect(again.created).toHaveLength(1)
  })

  it('配置了端口分配器时分配任务级端口段', async () => {
    const { PortAllocator } = await import('../worktree/port-allocator.ts')
    const { client } = fakeClient()
    const allocator = new PortAllocator({ rootDir: dir, subdir: 'workmate' } as never, 3000, 10)
    const svc = service(client, { ports: allocator })
    const result = await svc.ensureImplementationTasks({
      proposalId: 'p1',
      title: 'T',
      targets: [{ project: 'repo', baseBranch: 'main' }],
    })
    expect(result.created[0]?.ports).toHaveLength(5)
  })

  it('并发 create/reply 的 id 与 seq 互不重复（harden-write-races）', async () => {
    const { client } = fakeClient()
    const svc = service(client)
    const created = await Promise.all(
      Array.from({ length: 6 }, (_, index) => svc.create({ intent: `并发任务 ${index}`, repo: 'r' })),
    )
    const ids = created.map((task) => task.id)
    expect(new Set(ids).size).toBe(ids.length)

    const task = created[0]!
    const replies = await Promise.all(Array.from({ length: 5 }, () => svc.reply(task.id, '并发回答')))
    const seqs = replies.map((reply) => reply.seq).sort((left, right) => left - right)
    expect(new Set(seqs).size).toBe(seqs.length)
    expect(seqs).toEqual([1, 2, 3, 4, 5])

    const file = await store.load()
    expect(file.tasks).toHaveLength(6)
  })

  it('投影按送达记录绑定 Ticket，标题不一致也不失配（真机 2026-11-09）', async () => {
    const { client } = fakeClient({
      tickets: [{
        id: 'ticket-abc',
        title: '在 README 顶部补一段五分钟上手说明', // 执行器派生的标题（与任务标题不同）
        stage: 'working',
        directory: '/repo/.workmates/readme-quickstart',
      }],
    })
    const svc = service(client)
    const created = await svc.create({ intent: '在 README 顶部补一段五分钟上手说明（执行链路真机验证）', repo: 'r' })
    await svc.assign(created.id)
    // Source 的 ack 行：taskId → ticketId 绑定（标题与任务标题不同）
    await writeFile(
      store.paths.results,
      JSON.stringify({ seq: 1, taskId: created.id, kind: 'ack', ticketId: 'ticket-abc', text: '收到' }) + '\n',
      'utf8',
    )

    const board = await svc.board()
    const card = board.cards.find((entry) => entry.task.id === created.id)
    expect(card?.ticket?.id).toBe('ticket-abc')
    expect(card?.lane).toBe('working')
  })
})
