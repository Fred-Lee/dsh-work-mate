import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, inject, name } from './index.ts'
import type { SourceKind, SourceContext, Trigger } from './contract.ts'

let dir: string
let taskFile: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wm-index-'))
  taskFile = join(dir, 'tasks.json')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

interface Fake {
  ctx: Parameters<typeof apply>[0]
  registered: SourceKind<Record<string, unknown>>[]
  received: Trigger[]
  reports: Array<{ state: string; detail: string }>
  config: Record<string, unknown>
  tickets: Array<{ id: string; channels: Array<{ address: Record<string, string> }>; ended?: { outcome: string } }>
}

function fakeContext(config: Record<string, unknown>, options: { withOrchestrator?: boolean } = {}): Fake {
  const registered: SourceKind<Record<string, unknown>>[] = []
  const received: Trigger[] = []
  const reports: Array<{ state: string; detail: string }> = []
  const tickets: Fake['tickets'] = []
  const state = new Map<unknown, unknown>()

  const source = {
    deployment: { repository: 'x/y' },
    ready: Promise.resolve(),
    configured: () => true,
    config: () => config,
    receive: (trigger: Trigger) => {
      received.push(trigger)
      return { stored: true }
    },
    atomic: <T,>(work: () => T): T => work(),
    state: {
      get: <T,>(key: unknown) => state.get(key) as T | undefined,
      set: <T,>(key: unknown, value: T | undefined) => {
        if (value === undefined) state.delete(key)
        else state.set(key, value)
      },
    },
    threads: {
      get: () => undefined,
      subscribed: () => [],
      describe: () => undefined,
      patch: () => undefined,
    },
    tickets: {
      get: (id: string) => tickets.find((ticket) => ticket.id === id),
      open: () => tickets,
      bindThread: () => undefined,
      threadClosed: () => undefined,
    },
    triggers: { get: () => undefined, latest: () => undefined },
    notify: () => undefined,
    report: (_entry: string, health: { state: string; detail: string }) => reports.push(health),
  } as unknown as SourceContext

  const orchestrator = {
    sources: { register: (kind: SourceKind<Record<string, unknown>>) => registered.push(kind) },
    context: () => source,
  }

  const effects: Array<() => void> = []
  const ctx = {
    ...(options.withOrchestrator === false ? {} : { orchestrator }),
    effect: (fn: () => unknown) => {
      const disposer = fn()
      if (typeof disposer === 'function') effects.push(disposer as () => void)
      return disposer
    },
  } as unknown as Parameters<typeof apply>[0]

  return { ctx, registered, received, reports, config, tickets }
}

const flush = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const taskJson = (tasks: unknown[]): string => JSON.stringify({ version: 1, tasks }, null, 2)

const baseTask = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  title: id,
  intent: `做 ${id}`,
  repo: 'dsh-Helmsman',
  baseBranch: 'main',
  acceptance: 'ok',
  priority: 'P2',
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

describe('插件入口形状', () => {
  it('导出 name 与 inject', () => {
    expect(name).toBe('workmate-superagent-source')
    expect(inject).toEqual(['orchestrator'])
  })

  it('缺少 orchestrator 时不抛错、不注册', () => {
    const fake = fakeContext({}, { withOrchestrator: false })
    expect(() => apply(fake.ctx)).not.toThrow()
    expect(fake.registered).toHaveLength(0)
  })

  it('注册一次且 kind 六必填字段齐全', () => {
    const fake = fakeContext({ taskFile })
    apply(fake.ctx)
    expect(fake.registered).toHaveLength(1)
    const kind = fake.registered[0]
    expect(kind?.kind).toBe('workmate')
    expect(kind?.title.zh).not.toBe('')
    expect(kind?.description.en).not.toBe('')
    expect(kind?.fields.length).toBeGreaterThan(0)
    expect(kind?.health).toEqual(['workmate'])
    expect(typeof kind?.schema.parse).toBe('function')
  })

  it('声明了与非声明能力都在', () => {
    const fake = fakeContext({ taskFile })
    apply(fake.ctx)
    const kind = fake.registered[0]
    expect(kind?.scope).toBeTypeOf('function')
    expect(kind?.channel?.send).toBeTypeOf('function')
    expect(kind?.threadContext?.read).toBeTypeOf('function')
    expect(kind?.find).toBeTypeOf('function')
    expect(kind?.repliesTo).toBeTypeOf('function')
    expect(kind?.environment?.values).toBeTypeOf('function')
    expect(kind?.facts).toBeTypeOf('function')
  })
})

describe('扫描循环', () => {
  it('interactive=true 时投递待办', async () => {
    await writeFile(taskFile, taskJson([baseTask('task-1')]), 'utf8')
    const fake = fakeContext({ taskFile, interactive: true, pollSeconds: 1 })
    apply(fake.ctx)
    await flush()
    expect(fake.received.map((trigger) => trigger.id)).toContain('workmate:task-1:1')
  })

  it('interactive=false 时不投递', async () => {
    await writeFile(taskFile, taskJson([baseTask('task-1')]), 'utf8')
    const fake = fakeContext({ taskFile, interactive: false, pollSeconds: 1 })
    apply(fake.ctx)
    await flush()
    expect(fake.received).toHaveLength(0)
  })

  it('配置不可用时上报错误且不崩', async () => {
    const fake = fakeContext({ taskFile: 'relative/path' })
    apply(fake.ctx)
    await flush()
    expect(fake.reports.some((report) => report.state === 'error')).toBe(true)
    expect(fake.received).toHaveLength(0)
  })

  it('任务文件损坏时上报错误但不抛', async () => {
    await writeFile(taskFile, '{ broken', 'utf8')
    const fake = fakeContext({ taskFile, interactive: true })
    apply(fake.ctx)
    await flush()
    expect(fake.reports.some((report) => report.detail.includes('扫描失败') || report.state === 'error')).toBe(true)
    expect(fake.received).toHaveLength(0)
  })

  it('dispose 后不再扫描', async () => {
    await writeFile(taskFile, taskJson([baseTask('task-1')]), 'utf8')
    const fake = fakeContext({ taskFile, interactive: true, pollSeconds: 1 })
    const disposers: Array<() => void> = []
    const ctx = {
      ...(fake.ctx as unknown as Record<string, unknown>),
      effect: (fn: () => unknown) => {
        const disposer = fn()
        if (typeof disposer === 'function') disposers.push(disposer as () => void)
        return disposer
      },
    } as unknown as Parameters<typeof apply>[0]
    apply(ctx)
    await flush()
    const count = fake.received.length
    disposers.forEach((dispose) => dispose())
    await flush()
    expect(fake.received.length).toBe(count)
  })
})

describe('Ticket 关联与终态', () => {
  it('把开放 Ticket 记入映射，终态用于依赖门控', async () => {
    await writeFile(taskFile, taskJson([baseTask('a'), baseTask('b', { dependsOn: ['a'] })]), 'utf8')
    const fake = fakeContext({ taskFile, interactive: true })
    fake.tickets.push({ id: 'tkt-a', channels: [{ address: { taskId: 'a' } }], ended: { outcome: 'merged' } })
    apply(fake.ctx)
    await flush()
    // 映射在扫描之前刷新，所以同一轮里 a 的 merged 终态立即可用于门控。
    expect(fake.received.map((trigger) => trigger.meta['taskId'])).toEqual(['a', 'b'])
  })
})

describe('kind 的上下文与环境', () => {
  it('repliesTo 从 meta.replyTo 取', () => {
    const fake = fakeContext({ taskFile })
    apply(fake.ctx)
    const kind = fake.registered[0]
    const trigger = {
      id: 'workmate:a:in:1',
      source: 'workmate',
      threads: [{ source: 'workmate', id: 'a' }],
      actor: { source: 'workmate', id: 'u' },
      human: true,
      at: 't',
      text: 'x',
      meta: { replyTo: 'in:1' },
    } as Trigger
    expect(kind?.repliesTo?.(trigger)).toBe('in:1')
    expect(kind?.repliesTo?.({ ...trigger, meta: {} })).toBeUndefined()
  })

  it('find 命中标题或 id', async () => {
    await writeFile(taskFile, taskJson([baseTask('task-1', { title: '异步化 Run' })]), 'utf8')
    const fake = fakeContext({ taskFile, interactive: false })
    apply(fake.ctx)
    await flush()
    expect(fake.registered[0]?.find?.('异步化').threads).toEqual(['workmate:task-1'])
    expect(fake.registered[0]?.find?.('nope').threads).toEqual([])
  })

  it('environment.values 只从 meta 与配置取值，不读盘', () => {
    const fake = fakeContext({ taskFile, copyFiles: ['.env'] })
    apply(fake.ctx)
    const values = fake.registered[0]?.environment?.values({
      deployment: {},
      config: { taskFile, copyFiles: ['.env'], openspecRoot: 'openspec' } as never,
      trigger: {
        id: 'x',
        source: 'workmate',
        threads: [{ source: 'workmate', id: 'a' }],
        actor: { source: 'workmate', id: 'u' },
        human: true,
        at: 't',
        text: 'x',
        meta: { taskId: 'a', acceptance: '通过', priority: 'P0', baseBranch: 'main', ports: [3000, 3001], proposalId: 'p' },
      },
    })
    expect(values?.['DSH_SUPERAGENT_WORKMATE_TASK']).toBe('a')
    expect(values?.['DSH_SUPERAGENT_WORKMATE_PORTS']).toBe('3000,3001')
    expect(values?.['DSH_SUPERAGENT_WORKMATE_COPY']).toBe('.env')
    expect(values?.['DSH_SUPERAGENT_WORKMATE_PROPOSAL']).toBe('p')
  })
})
