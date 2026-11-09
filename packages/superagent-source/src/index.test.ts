import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

interface TicketStub {
  id: string
  channels: Array<{ address: Record<string, string> }>
  ended?: { outcome: string }
}

interface InstanceSpec {
  /** profile 里这条 entry 的插件层配置，决定实例 id；不传 = 默认实例 `workmate`。 */
  pluginConfig?: { kind?: string }
  /** Super-agent 设置页里按 kind 存的实例配置（`source.config(id)` 的返回值）。 */
  config: Record<string, unknown>
}

interface FakeHost {
  registered: SourceKind<Record<string, unknown>>[]
  received: Trigger[]
  reports: Array<{ entry: string; state: string; detail: string }>
  /** 两个实例共用的 KV：宿主把 state 绑给同一张表，所以键里必须带实例 id（design D2）。 */
  state: Map<string, unknown>
  tickets: TicketStub[]
  /** 构造一个插件实例的 ctx（不调用 apply；旧用例保留 `apply(fake.ctx)` 的写法）。 */
  ctxFor(spec: InstanceSpec, options?: { withOrchestrator?: boolean }): Parameters<typeof apply>[0]
  /** 构造并立即 apply，等价于 profile 里装载一条 entry。 */
  start(spec: InstanceSpec, options?: { withOrchestrator?: boolean }): void
}

/**
 * 实例 id 的期望值：**只**看插件层 `kind`（注册先于设置，设置里的 kind 不驱动注册，
 * 只做一致性校验）。不传 = 默认实例 `workmate`。
 */
const instanceIdOf = (spec: InstanceSpec): string => spec.pluginConfig?.kind ?? 'workmate'

function fakeHost(specs: InstanceSpec[] = []): FakeHost {
  const configs = new Map<string, Record<string, unknown>>()
  for (const spec of specs) configs.set(instanceIdOf(spec), spec.config)

  const registered: SourceKind<Record<string, unknown>>[] = []
  const received: Trigger[] = []
  const reports: Array<{ entry: string; state: string; detail: string }> = []
  const state = new Map<string, unknown>()
  const tickets: TicketStub[] = []
  // 复刻宿主的语义（`sourceContextOf`）：`context()` 在构造时把 kind.health 解析成句柄表，
  // 注册前解析出来是空表 → report 变成静默 no-op。真机上的 bug 正是这样被单测放过的。
  const claimed = new Set<string>()
  const kinds = new Map<string, SourceKind<Record<string, unknown>>>()
  const contexts = new Map<string, SourceContext>()

  const sourceFor = (kind: string): SourceContext =>
    ({
      deployment: { repository: 'x/y' },
      ready: Promise.resolve(),
      configured: () => true,
      // 宿主按 kind 名取该实例的设置：传错实例 id 会拿到 undefined（配置不可用），
      // 所以"两个实例各读各的配置"能被测试真实覆盖。
      config: (requestedKind: string) => configs.get(requestedKind),
      receive: (trigger: Trigger) => {
        received.push(trigger)
        return { stored: true }
      },
      atomic: <T,>(work: () => T): T => work(),
      // 宿主把 key 直接绑给 SQLite TEXT 列：非字符串在真机会抛，这里也必须拒。
      state: {
        get: <T,>(key: string) => {
          if (typeof key !== 'string') throw new Error('Provided value cannot be bound to SQLite parameter 1.')
          return state.get(key) as T | undefined
        },
        set: <T,>(key: string, value: T | undefined) => {
          if (typeof key !== 'string') throw new Error('Provided value cannot be bound to SQLite parameter 1.')
          if (value === undefined) state.delete(key)
          else state.set(key, value)
        },
        keys: (prefix: string) => [...state.keys()].filter((key) => key.startsWith(prefix)),
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
      report: (entry: string, health: { state: string; detail: string }) => {
        if (!claimed.has(entry)) return
        reports.push({ entry, state: health.state, detail: health.detail })
      },
    }) as unknown as SourceContext

  const orchestrator = {
    sources: {
      // 复刻宿主 registry.ts：重复 kind 直接抛——参数化没有绕过这条约束。
      register: (kind: SourceKind<Record<string, unknown>>) => {
        if (kinds.has(kind.kind)) throw new Error(`Source kind already registered: ${kind.kind}`)
        kinds.set(kind.kind, kind)
        for (const entry of kind.health) claimed.add(entry)
        registered.push(kind)
        return () => {
          for (const entry of kind.health) claimed.delete(entry)
          kinds.delete(kind.kind)
          const index = registered.indexOf(kind)
          if (index !== -1) registered.splice(index, 1)
        }
      },
    },
    context: ({ kind, health }: { kind: string; health: readonly string[] }) => {
      // 健康句柄表来自注册时声明的条目；这里按 `kind` 返回该实例的 SourceContext。
      for (const entry of health) claimed.add(entry)
      const context = sourceFor(kind)
      contexts.set(kind, context)
      return context
    },
  }

  // 参数里的 spec 只为调用处可读（ctx 本身不知道自己是哪个实例，id 由 apply 的第二参数给）。
  const ctxFor = (_spec: InstanceSpec, options: { withOrchestrator?: boolean } = {}): Parameters<typeof apply>[0] =>
    ({
      ...(options.withOrchestrator === false ? {} : { orchestrator }),
      effect: (fn: () => unknown) => fn(),
    }) as unknown as Parameters<typeof apply>[0]

  return {
    registered,
    received,
    reports,
    state,
    tickets,
    ctxFor,
    start: (spec, options) => apply(ctxFor(spec, options), spec.pluginConfig),
  }
}

interface Fake {
  ctx: Parameters<typeof apply>[0]
  registered: SourceKind<Record<string, unknown>>[]
  received: Trigger[]
  reports: Array<{ entry: string; state: string; detail: string }>
  state: Map<string, unknown>
  config: Record<string, unknown>
  tickets: TicketStub[]
}

function fakeContext(config: Record<string, unknown>, options: { withOrchestrator?: boolean } = {}): Fake {
  const spec: InstanceSpec = { config }
  const host = fakeHost([spec])
  return {
    ctx: host.ctxFor(spec, options),
    registered: host.registered,
    received: host.received,
    reports: host.reports,
    state: host.state,
    config,
    tickets: host.tickets,
  }
}

const flush = (ms = 50): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 等某个条件成立（扫描是定时器 + 真实读盘，固定 sleep 在全量并行跑测试时会抖）。
 * 超时抛错，避免把"还没发生"误判成"不会发生"。
 */
async function waitFor(predicate: () => boolean, label = 'condition', timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await flush(10)
  }
  throw new Error(`等待超时：${label}`)
}

const taskJson = (tasks: unknown[]): string => JSON.stringify({ version: 1, tasks }, null, 2)

const inputJsonl = (rows: Array<{ seq: number; taskId: string; text?: string; by?: string; at?: string }>): string =>
  rows.map((row) => JSON.stringify({ by: 'workmate:fred', at: '2026-11-02T00:00:00.000Z', ...row })).join('\n') + '\n'

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

/** 在一个独立目录写一套三文件（只写 tasks 与 inputs），返回 taskFile 路径。 */
async function writeInstance(root: string, tasks: unknown[], inputs: Array<{ seq: number; taskId: string }> = []): Promise<string> {
  await mkdir(root, { recursive: true })
  const file = join(root, 'tasks.json')
  await writeFile(file, taskJson(tasks), 'utf8')
  await writeFile(join(root, 'inputs.jsonl'), inputJsonl(inputs), 'utf8')
  return file
}

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
    // 规格要求实现 policy：只声明"谁能发起工作"，不声明接受规则。
    expect(kind?.policy?.schema).toBeDefined()
    expect(kind?.policy?.fields.map((field) => field.key)).toEqual(['allowed'])
    expect(kind?.policy?.rows?.({})).toHaveLength(1)
    expect(kind?.policy?.explicit.en.length).toBeGreaterThan(0)
  })
})

describe('扫描循环', () => {
  it('interactive=true 时投递待办', async () => {
    await writeFile(taskFile, taskJson([baseTask('task-1')]), 'utf8')
    const fake = fakeContext({ taskFile, interactive: true, pollSeconds: 1 })
    apply(fake.ctx)
    await waitFor(() => fake.received.length > 0, '收到 Trigger')
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
    await waitFor(() => fake.reports.some((report) => report.state === 'error'), '配置错误上报')
    expect(fake.received).toHaveLength(0)
  })

  it('任务文件损坏时上报错误但不抛', async () => {
    await writeFile(taskFile, '{ broken', 'utf8')
    const fake = fakeContext({ taskFile, interactive: true })
    apply(fake.ctx)
    await waitFor(
      () => fake.reports.some((report) => report.detail.includes('扫描失败') || report.state === 'error'),
      '扫描失败上报',
    )
    expect(fake.received).toHaveLength(0)
  })

  it('先注册 kind 再取 context，健康报告才落得到句柄上', async () => {
    // 回归：宿主的 report 只写"取 context 时解析出的句柄表"；先取后注册会让所有
    // 健康报告变成静默 no-op（健康永远停在 starting，真机上表现为来源看起来没启动）。
    await writeFile(taskFile, taskJson([baseTask('task-1')]), 'utf8')
    const fake = fakeContext({ taskFile, interactive: true })
    apply(fake.ctx)
    await waitFor(
      () => fake.reports.some((report) => report.state === 'ready' || report.state === 'paused'),
      '健康报告落盘',
    )
    expect(fake.registered).toHaveLength(1)
    expect(fake.reports.length).toBeGreaterThan(0)
  })

  it('dispose 时反注册 kind（重载不会撞 already registered）', async () => {
    await writeFile(taskFile, taskJson([]), 'utf8')
    const fake = fakeContext({ taskFile, interactive: true })
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
    await waitFor(() => fake.reports.length > 0, '首轮健康报告')
    expect(fake.registered).toHaveLength(1)
    disposers.forEach((dispose) => dispose())
    expect(fake.registered).toHaveLength(0)
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
    await waitFor(() => fake.received.length > 0, '首轮投递')
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
    await waitFor(() => fake.received.length === 2, '两条待办都投递')
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
    await waitFor(() => fake.registered[0]?.find?.('异步化').threads.length === 1, '任务表加载')
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

describe('多实例共存（change support-multi-repo-executors）', () => {
  it('同一 fake host 注册两个实例不冲突：kind.kind 与健康条目各自独立', () => {
    const host = fakeHost([
      { pluginConfig: {}, config: { taskFile, interactive: true } },
      { pluginConfig: { kind: 'workmate-b' }, config: { taskFile, interactive: true } },
    ])
    expect(() => host.start({ pluginConfig: {}, config: { taskFile, interactive: true } })).not.toThrow()
    expect(() => host.start({ pluginConfig: { kind: 'workmate-b' }, config: { taskFile, interactive: true } })).not.toThrow()
    // 宿主注册键不同 → 没有 `Source kind already registered`。
    expect(host.registered.map((kind) => kind.kind)).toEqual(['workmate', 'workmate-b'])
    expect(host.registered.map((kind) => kind.health)).toEqual([['workmate'], ['workmate-b']])
    // 设置页按 kind 查 schema：两个实例共用同一个 schema（差异只有配置值）。
    expect(host.registered.map((kind) => typeof kind.schema.parse)).toEqual(['function', 'function'])
  })

  it('重复 kind 仍会被宿主拒绝（参数化没有绕过宿主的约束）', () => {
    const host = fakeHost([{ pluginConfig: {}, config: { taskFile, interactive: true } }])
    host.start({ pluginConfig: {}, config: { taskFile, interactive: true } })
    expect(() => host.start({ pluginConfig: {}, config: { taskFile, interactive: true } })).toThrow(/already registered/)
  })

  it('两个实例的健康报告挂到各自条目上，互不覆盖', async () => {
    const dirA = join(dir, 'a')
    const dirB = join(dir, 'b')
    const fileA = await writeInstance(dirA, [baseTask('task-a')])
    const fileB = await writeInstance(dirB, [baseTask('task-b')])
    const specA: InstanceSpec = { pluginConfig: {}, config: { taskFile: fileA, interactive: true } }
    const specB: InstanceSpec = { pluginConfig: { kind: 'workmate-b' }, config: { taskFile: fileB, kind: 'workmate-b', interactive: true } }
    const host = fakeHost([specA, specB])
    host.start(specA)
    host.start(specB)
    await waitFor(() => host.received.length === 2, '两个实例各投一条')
    const entries = new Set(host.reports.map((report) => report.entry))
    expect(entries).toEqual(new Set(['workmate', 'workmate-b']))
    // 两个实例各自扫到了自己的待办：投递条目的前缀不同，说明 health/report 没有串台。
    expect(host.received.map((trigger) => trigger.id).sort()).toEqual(['workmate-b:task-b:1', 'workmate:task-a:1'])
    for (const entry of ['workmate', 'workmate-b']) {
      expect(host.reports.some((report) => report.entry === entry && report.state === 'ready')).toBe(true)
    }
  })

  it('state 键按实例 id 分段：游标与 Ticket 映射不共享键', async () => {
    const dirA = join(dir, 'a')
    const dirB = join(dir, 'b')
    const fileA = await writeInstance(dirA, [baseTask('task-a')], [{ seq: 5, taskId: 'task-a' }])
    const fileB = await writeInstance(dirB, [baseTask('task-b')], [{ seq: 2, taskId: 'task-b' }])
    const specA: InstanceSpec = { pluginConfig: {}, config: { taskFile: fileA, interactive: true } }
    const specB: InstanceSpec = { pluginConfig: { kind: 'workmate-b' }, config: { taskFile: fileB, interactive: true } }
    const host = fakeHost([specA, specB])
    host.start(specA)
    host.start(specB)
    await waitFor(
      () =>
        host.state.has('workmate-source:workmate:cursor') &&
        host.state.has('workmate-source:workmate-b:cursor') &&
        host.state.has('workmate-source:workmate:tickets') &&
        host.state.has('workmate-source:workmate-b:tickets'),
      '两个实例各写自己的 state 键',
    )

    const keys = new Set(host.state.keys())
    expect(keys.has('workmate-source:workmate:cursor')).toBe(true)
    expect(keys.has('workmate-source:workmate:tickets')).toBe(true)
    expect(keys.has('workmate-source:workmate-b:cursor')).toBe(true)
    expect(keys.has('workmate-source:workmate-b:tickets')).toBe(true)
    // 两条游标各自独立推进（5 与 2），证明没有共用一个键。
    expect(host.state.get('workmate-source:workmate:cursor')).toBe(5)
    expect(host.state.get('workmate-source:workmate-b:cursor')).toBe(2)
    // 旧的无实例段键不再被写（迁移兼容只读不写）。
    expect(keys.has('workmate-source:cursor')).toBe(false)
    expect(keys.has('workmate-source:tickets')).toBe(false)
    // 两个实例的键集合不相交。
    const familyA = [...keys].filter((key) => key.startsWith('workmate-source:workmate:'))
    const familyB = [...keys].filter((key) => key.startsWith('workmate-source:workmate-b:'))
    expect(familyA.length).toBeGreaterThan(0)
    expect(familyB.length).toBeGreaterThan(0)
    expect(familyA.filter((key) => familyB.includes(key))).toEqual([])
  })

  it('两个实例用不相交 repos 扫描同一 taskFile：各投各的、不重复', async () => {
    const shared = await writeInstance(dir, [
      baseTask('task-a', { repo: '/srv/a' }),
      baseTask('task-b', { repo: '/srv/b' }),
    ])
    const specA: InstanceSpec = { pluginConfig: {}, config: { taskFile: shared, interactive: true, repos: ['/srv/a'] } }
    const specB: InstanceSpec = {
      pluginConfig: { kind: 'workmate-b' },
      config: { taskFile: shared, interactive: true, repos: ['/srv/b'] },
    }
    const host = fakeHost([specA, specB])
    host.start(specA)
    host.start(specB)
    await waitFor(() => host.received.length === 2, '两个实例各投一条')

    const ids = host.received.map((trigger) => trigger.id).sort()
    expect(ids).toEqual(['workmate-b:task-b:1', 'workmate:task-a:1'])
    expect(new Set(ids).size).toBe(ids.length)
    // 每个实例都看到了"有一条不归我"：写进健康摘要，人能区分"没活"与"别人的活"。
    for (const entry of ['workmate', 'workmate-b']) {
      expect(host.reports.some((report) => report.entry === entry && report.detail.includes('跳过 1 条（非本实例仓库）'))).toBe(true)
    }
    // facts 也只数本实例负责的待办（否则两个实例都会说"待投递 2 条"）。
    for (const kind of host.registered) {
      expect(JSON.stringify(kind.facts?.({}))).toContain('待投递 1 条')
    }
  })

  it('插件条目的 config.kind 决定实例 id，标题与 instance fact 按实例区分', () => {
    const specA: InstanceSpec = { pluginConfig: {}, config: { taskFile, interactive: true } }
    const specB: InstanceSpec = { pluginConfig: { kind: 'workmate-b' }, config: { taskFile, interactive: true } }
    const host = fakeHost([specA, specB])
    host.start(specA)
    host.start(specB)
    const [kindA, kindB] = host.registered
    expect(kindA?.title).toEqual({ zh: 'WorkMate 待办', en: 'WorkMate tasks' })
    expect(kindB?.title.zh).toBe('WorkMate 待办（workmate-b）')
    expect(kindB?.title.en).toBe('WorkMate tasks (workmate-b)')
    // 设置页用 fact 展示真实注册 id（kind 不在设置表单里，避免"改了没效果"的误解）。
    expect(kindB?.facts?.({})['instance']).toBe('workmate-b')
    expect(kindA?.facts?.({})['instance']).toBe('workmate')
  })

  it('非法的实例 id 让装载失败；装在没有 orchestrator 的 profile 时仍保持安静', () => {
    const host = fakeHost([])
    expect(() => host.start({ pluginConfig: { kind: 'Workmate' }, config: { taskFile } })).toThrow(/实例 id 必须匹配/)
    expect(host.registered).toHaveLength(0)
    // 装载契约要求：装错 profile 时不抛错、什么都不做（verify:source 也断言这条）。
    expect(() => apply(host.ctxFor({ config: {} }, { withOrchestrator: false }), { kind: 'Bad' })).not.toThrow()
  })

  it('设置里的 kind 与装载实例 id 不一致时健康报错，不静默忽略', async () => {
    await writeFile(taskFile, taskJson([]), 'utf8')
    const spec: InstanceSpec = {
      pluginConfig: { kind: 'workmate-b' },
      config: { taskFile, kind: 'workmate', interactive: true },
    }
    const host = fakeHost([spec])
    host.start(spec)
    await waitFor(() => host.reports.some((report) => report.state === 'error'), '一致性错误')
    const error = host.reports.find((report) => report.state === 'error')
    expect(error?.entry).toBe('workmate-b')
    expect(error?.detail).toMatch(/不一致/)
    expect(host.received).toHaveLength(0)
  })

  it('默认实例回归：注册键 / 健康条目 / Trigger / Thread key / state 前缀仍是 workmate', async () => {
    await writeFile(taskFile, taskJson([baseTask('task-1')]), 'utf8')
    await writeFile(join(dir, 'inputs.jsonl'), inputJsonl([{ seq: 3, taskId: 'task-1' }]), 'utf8')
    const fake = fakeContext({ taskFile, interactive: true })
    apply(fake.ctx)
    await waitFor(() => fake.received.length === 2, '回答与待办都投递')
    const kind = fake.registered[0]
    expect(kind?.kind).toBe('workmate')
    expect(kind?.health).toEqual(['workmate'])
    expect(kind?.find?.('task-1').threads).toEqual(['workmate:task-1'])
    expect(fake.received.map((trigger) => trigger.id)).toEqual(['workmate:task-1:in:3', 'workmate:task-1:1'])
    // 派生键全部带默认实例 id（新格式）；旧的无实例段键只读不写。
    expect(fake.state.get('workmate-source:workmate:cursor')).toBe(3)
    expect(fake.state.get('workmate-source:workmate:tickets')).toEqual({})
  })
})
