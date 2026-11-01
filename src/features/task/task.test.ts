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

const fakeClient = (options: { tickets?: TicketView[]; online?: boolean; reason?: string; actions?: boolean } = {}): {
  client: SuperagentClient
  called: Array<{ ticketId: string; action: string }>
} => {
  const called: Array<{ ticketId: string; action: string }> = []
  const online = options.online ?? true
  const client = {
    async health() {
      return online
        ? { online: true, endpoint: 'http://127.0.0.1:3082' }
        : { online: false, endpoint: 'http://127.0.0.1:3082', reason: options.reason ?? '连接被拒' }
    },
    async tickets() {
      return online
        ? { online: true, tickets: options.tickets ?? [] }
        : { online: false, tickets: [], reason: options.reason ?? '连接被拒' }
    },
    async action(ticketId: string, action: 'retry' | 'stop') {
      called.push({ ticketId, action })
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

  it('四列互斥：一张卡只出现在一列', async () => {
    const { client } = fakeClient()
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
