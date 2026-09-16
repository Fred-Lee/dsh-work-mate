import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  createBoardApiRouter,
  nextStage,
  runRefState,
  stageIndex,
  startRunCapability,
  toCardPayload,
  type ArtifactLike,
  type BoardApiDeps,
  type BoardServiceLike,
  type OrchestratorLike,
  type TopologyLike,
  type WorkItem,
} from './api.ts'
import type { Router } from './http.ts'

// ---------------------------------------------------------------------------
// HTTP doubles (same shape as ui-dashboard/src/api.test.ts)
// ---------------------------------------------------------------------------

function fakeReq(method: string, body?: unknown): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c
    },
  } as unknown as IncomingMessage
}

function fakeRes(): { res: ServerResponse; status: () => number; body: () => string } {
  let status = 0
  let out = ''
  const res = {
    writeHead: (code: number) => {
      status = code
      return res
    },
    end: (b?: string) => {
      out = b ?? ''
    },
  } as unknown as ServerResponse
  return { res, status: () => status, body: () => out }
}

async function call(
  router: Router,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = fakeRes()
  const handled = await router.handle(fakeReq(method, body), res.res, path)
  expect(handled).toBe(true)
  return { status: res.status(), body: JSON.parse(res.body() || '{}') as Record<string, unknown> }
}

// ---------------------------------------------------------------------------
// Service doubles (structural — the board plugin is an EXTERNAL service)
// ---------------------------------------------------------------------------

function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'wi-1',
    title: '登录接口并行改造',
    stage: 'spec',
    repoScope: { baseRepo: 'order-core', projectGroup: '订单中台' },
    createdAt: 1_000,
    updatedAt: 2_000,
    summary: { text: '重构登录接口并补充单测,涉及 3 个服务。', generatedBy: 'model', source: 'dsh', at: 1_500 },
    associations: [
      { type: 'doc', refId: 'prd-login', label: 'PRD 登录', at: 10 },
      { type: 'doc', refId: 'drafts/d-1.md', label: 'draft d-1', at: 11 },
      { type: 'conversation', refId: 'sess-1', label: 'dsh 会话', at: 12 },
      { type: 'service', refId: 'user-service', label: 'user-service', at: 13 },
      { type: 'artifact', refId: 'a-known', label: 'bundle.json', at: 14 },
    ],
    runs: [{ taskId: 't-1', startedAt: 3_000, terminal: null }],
    ...overrides,
  }
}

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 't-1',
    prompt: '并行修改登录接口',
    status: 'COMPLETED',
    projectGroupId: '订单中台',
    createdAt: 2_900,
    endedAt: 6_000,
    agents: {
      claude: {
        state: 'completed',
        attempts: 2,
        conflictingFiles: ['src/login.ts'],
        diffs: [{ path: '/repos/user-service/src/login.ts', status: 'modified' }],
      },
      codex: { state: 'completed', attempts: 1, conflictingFiles: [] },
    },
    ...overrides,
  }
}

function makeBoard(overrides: Partial<BoardServiceLike> = {}): BoardServiceLike {
  const base: BoardServiceLike = {
    create: vi.fn(async (input) =>
      makeItem({
        id: 'wi-new',
        title: input.title,
        stage: input.stage ?? 'requirements',
        repoScope: input.repoScope,
        summary: input.summaryText ? { text: input.summaryText, generatedBy: 'fallback', at: 1 } : null,
        associations: input.conversation ? [{ type: 'conversation', refId: input.conversation.sessionId, at: 1 }] : [],
        runs: [],
      }),
    ),
    update: vi.fn(async (id, patch) => makeItem({ id, ...(patch.title ? { title: patch.title } : {}), ...(patch.scope ? { scope: patch.scope } : {}) })),
    get: vi.fn(async (id) => (id === 'wi-1' ? makeItem() : null)),
    list: vi.fn(async () => [
      makeItem(),
      makeItem({
        id: 'wi-2',
        title: '结算模块拆分',
        stage: 'dev',
        scope: { module: 'a' },
        repoScope: { baseRepo: 'order-core' },
        summary: null,
        runs: [],
        associations: [],
      }),
      makeItem({
        id: 'wi-3',
        title: '报表导出',
        stage: 'dev',
        scope: { module: 'b' },
        repoScope: { baseRepo: 'order-core' },
        associations: [],
        runs: [],
      }),
      makeItem({ id: 'wi-4', title: '支付对账', stage: 'done', repoScope: { baseRepo: 'pay-core' }, associations: [], runs: [] }),
    ]),
    advance: vi.fn(async ({ id, to }) => ({ ok: true, item: makeItem({ id, stage: to as WorkItem['stage'] }), gaps: [] })),
    gate: vi.fn(async () => ({ ok: true, gaps: [] })),
    associate: vi.fn(async (id) => makeItem({ id })),
    disassociate: vi.fn(async (id) => makeItem({ id })),
    setSummary: vi.fn(async (id, summary) =>
      makeItem({ id, summary: { text: summary.text, generatedBy: summary.generatedBy ?? 'manual', at: summary.at ?? 9_999 } }),
    ),
  }
  return { ...base, ...overrides }
}

const knownArtifact = { id: 'a-known', meta: { id: 'a-known', fileName: 'wi-1.bundle.json', mime: 'application/json' }, bytes: new Uint8Array([1]) }

function makeArtifacts(): ArtifactLike {
  return {
    resolve: vi.fn(async (id: string) => (id === 'a-known' ? knownArtifact : null)),
    list: vi.fn(async () => [knownArtifact.meta]),
  }
}

function makeOrchestrator(): OrchestratorLike {
  const task = makeTask()
  return {
    getTaskStatus: vi.fn((id: string) => (id === 't-1' ? task : undefined)),
    listTasks: vi.fn(() => [task]),
    history: {
      getEvents: vi.fn(async (taskId: string) =>
        taskId === 't-1'
          ? {
              events: [
                {
                  seq: 7,
                  ts: 5_000,
                  taskId: 't-1',
                  kind: 'merge-decision',
                  payload: {
                    agents: ['claude'],
                    resolutions: { 'src/login.ts': { kind: 'manual' } },
                    conflictFiles: ['src/login.ts'],
                    discardAfterMerge: false,
                    outcome: 'merged',
                    results: [],
                  },
                },
              ],
              pruned: false,
            }
          : { events: [], pruned: false },
      ),
      subscribe: vi.fn(() => () => undefined),
      getTask: vi.fn(async () => undefined),
    },
    listPendingConfirmations: vi.fn(() => [
      { approvalId: 'ap-1', op: 'merge', scope: 'merge:task:t-1', source: 'ui', requestedAt: 4_000, expiresAt: 9_000 },
    ]),
    // change `enable-card-start-run`: the two seams the 发起执行 entry uses.
    checkAgents: vi.fn(async () => ({ claude: { installed: true, version: '1.2.3' }, codex: { installed: true } })),
    runParallelTask: vi.fn(async () => ({ taskId: 't-new' })),
  }
}

function makeTopology(): TopologyLike {
  return {
    loadTopology: vi.fn(async () => ({
      services: { 'user-service': { name: 'user-service', localPath: '/repos/user-service' } },
    })),
  }
}

function makeDeps(overrides: Partial<BoardApiDeps> = {}): BoardApiDeps {
  return {
    board: makeBoard(),
    now: () => 12_345,
    ...overrides,
  }
}

function makeRouter(overrides: Partial<BoardApiDeps> = {}): Router {
  return createBoardApiRouter(makeDeps(overrides))
}

// ---------------------------------------------------------------------------

describe('stage helpers', () => {
  it('orders the four stages and stops at the end', () => {
    expect(stageIndex('requirements')).toBe(0)
    expect(nextStage('spec')).toBe('dev')
    expect(nextStage('done')).toBeNull()
  })
})

describe('GET api/config', () => {
  it('reports the mounts and which optional services are present', async () => {
    const router = makeRouter({ orchestrator: makeOrchestrator, artifacts: makeArtifacts, topology: makeTopology })
    const { body } = await call(router, 'GET', '/api/config')
    expect(body.mountPath).toBe('/helmsman-board')
    expect(body.dashboardMount).toBe('/helmsman-dashboard')
    expect(body.diffMount).toBe('/helmsman-diff')
    expect(body.streamUrlTemplate).toBe('/helmsman-dashboard/api/task/{taskId}/stream')
    expect(body.services).toEqual({ board: true, orchestrator: true, artifacts: true, topology: true })
  })

  it('honours a configured dashboard mount (SSE address is configurable)', async () => {
    const router = makeRouter({ dashboardMount: '/helmsman-telemetry' })
    const { body } = await call(router, 'GET', '/api/config')
    expect(body.streamUrlTemplate).toBe('/helmsman-telemetry/api/task/{taskId}/stream')
  })

  it('degrades when optional services are absent', async () => {
    const board = makeBoard()
    const router = makeRouter({ board })
    const { body } = await call(router, 'GET', '/api/config')
    expect(body.services).toEqual({ board: true, orchestrator: false, artifacts: false, topology: false })
  })
})

describe('GET api/items (cards + column counts + WIP counters)', () => {
  it('returns cards, per-column counts, badges and the repo list', async () => {
    const board = makeBoard()
    const router = makeRouter({ board })
    const { status, body } = await call(router, 'GET', '/api/items')
    expect(status).toBe(200)
    const items = body.items as Array<Record<string, unknown>>
    expect(items).toHaveLength(4)
    const card = items[0]!
    expect(card.title).toBe('登录接口并行改造')
    expect(card.stageLabel).toBe('规格设计')
    expect(card.summary).toMatchObject({ text: '重构登录接口并补充单测,涉及 3 个服务。', generatedBy: 'model' })
    expect(card.badges).toEqual({ docs: 2, conversations: 1, services: 1 })
    expect(card.conflictDomain).toBe('order-core:*')
    expect((body.columns as Array<Record<string, unknown>>).map((c) => `${c.stage}:${c.count}`)).toEqual([
      'requirements:0',
      'spec:1',
      'dev:2',
      'done:1',
    ])
    expect(body.repos).toEqual(['order-core', 'pay-core'])
    const wip = body.wip as { source: string; domains: Array<Record<string, unknown>> }
    expect(wip.domains.map((d) => d.key)).toEqual(['order-core:a', 'order-core:b'])
    expect(wip.domains[0]).toMatchObject({ running: 1, module: 'a' })
  })

  it('passes the repo/stage filters through to the board service', async () => {
    const list = vi.fn(async () => [])
    const router = makeRouter({ board: makeBoard({ list }) })
    await call(router, 'GET', '/api/items?repo=pay-core&stage=done')
    expect(list).toHaveBeenCalledWith({ repo: 'pay-core', stage: 'done' })
  })

  it('ignores an unknown stage filter instead of failing', async () => {
    const list = vi.fn(async () => [])
    const router = makeRouter({ board: makeBoard({ list }) })
    await call(router, 'GET', '/api/items?stage=nope')
    expect(list).toHaveBeenCalledWith({})
  })

  it('uses the board WIP report when the service exposes one', async () => {
    const wip = vi.fn(async () => ({
      policy: { moduleLimit: 1, repoFallbackLimit: 2 },
      domains: [{ key: 'order-core:a', repo: 'order-core', module: 'a', running: 1, limit: 1, itemIds: ['wi-2'] }],
    }))
    const router = makeRouter({ board: makeBoard({ wip }) })
    const { body } = await call(router, 'GET', '/api/items')
    const payload = body.wip as { source: string; policy: Record<string, number>; domains: Array<Record<string, unknown>> }
    expect(payload.source).toBe('service')
    expect(payload.policy).toEqual({ moduleLimit: 1, repoFallbackLimit: 2 })
    expect(payload.domains[0]).toMatchObject({ key: 'order-core:a', running: 1, limit: 1, module: 'a' })
  })

  it('marks the derived WIP fallback when the board has no wip() (limits unknown)', async () => {
    const board = makeBoard()
    delete (board as { wip?: unknown }).wip
    const router = makeRouter({ board })
    const { body } = await call(router, 'GET', '/api/board/wip')
    const payload = body as { source: string; policy: null; domains: Array<Record<string, unknown>> }
    expect(payload.source).toBe('derived')
    expect(payload.policy).toBeNull()
    expect(payload.domains.map((d) => d.key)).toEqual(['order-core:a', 'order-core:b'])
    expect(payload.domains[0]!.limit).toBeNull()
  })

  it('shows two conflict domains for the same repo (different modules run in parallel)', async () => {
    const router = makeRouter()
    const { body } = await call(router, 'GET', '/api/board/wip')
    const domains = (body as { domains: Array<Record<string, unknown>> }).domains
    expect(domains.map((d) => d.key)).toEqual(['order-core:a', 'order-core:b'])
    expect(domains.map((d) => d.running)).toEqual([1, 1])
  })
})

describe('GET api/item/:id (detail + gate + association jump-offs)', () => {
  it('returns the item, next stage, gate gaps and resolved associations', async () => {
    const gate = vi.fn(async () => ({ ok: false, gaps: [{ key: 'spec-finalized', label: '缺少已定稿 spec', action: '/helmsman-workbench/?draft=d-1' }] }))
    const router = makeRouter({ board: makeBoard({ gate }), artifacts: makeArtifacts })
    const { status, body } = await call(router, 'GET', '/api/item/wi-1')
    expect(status).toBe(200)
    expect(body.nextStage).toBe('dev')
    expect(body.nextStageLabel).toBe('开发实施')
    expect(body.gate).toMatchObject({ ok: false, gaps: [{ key: 'spec-finalized', label: '缺少已定稿 spec' }] })
    const associations = body.associations as Array<Record<string, unknown>>
    const byRef = Object.fromEntries(associations.map((a) => [a.refId, a]))
    // docs jump to the workbench (draft by id, note by path), runs to the diff view
    expect(byRef['drafts/d-1.md']).toMatchObject({ kind: 'workbench-doc', href: '/helmsman-workbench/?draft=drafts%2Fd-1.md' })
    expect(byRef['prd-login']).toMatchObject({ kind: 'workbench-doc' })
    // a Tolaria note (path-like refId) opens the note, not a draft
    expect(byRef['sess-1']).toMatchObject({ kind: 'none', href: null })
    expect(byRef['user-service']).toMatchObject({
      kind: 'dashboard',
      href: '/helmsman-dashboard/?panel=config&group=%E8%AE%A2%E5%8D%95%E4%B8%AD%E5%8F%B0&service=user-service',
    })
    // artifact link points at the registry download endpoint, dangling resolved
    expect(byRef['a-known']).toMatchObject({ kind: 'artifact', href: '/helmsman-dashboard/api/artifacts/a-known', dangling: false })
  })

  it('marks a missing artifact target as dangling instead of failing the item', async () => {
    const board = makeBoard({
      get: vi.fn(async () =>
        makeItem({ associations: [{ type: 'artifact', refId: 'a-gone', label: 'bundle', at: 1 }] }),
      ),
    })
    const router = makeRouter({ board, artifacts: makeArtifacts })
    const { status, body } = await call(router, 'GET', '/api/item/wi-1')
    expect(status).toBe(200)
    expect((body.associations as Array<Record<string, unknown>>)[0]).toMatchObject({ refId: 'a-gone', dangling: true })
  })

  it('resolves a run association against the change-A service (dangling when unknown)', async () => {
    const board = makeBoard({
      get: vi.fn(async () =>
        makeItem({
          associations: [
            { type: 'run', refId: 't-1', label: 'run t-1', at: 1 },
            { type: 'run', refId: 't-gone', label: 'run t-gone', at: 1 },
          ],
        }),
      ),
    })
    const router = makeRouter({ board, orchestrator: makeOrchestrator })
    const { body } = await call(router, 'GET', '/api/item/wi-1')
    const associations = body.associations as Array<Record<string, unknown>>
    expect(associations[0]).toMatchObject({ refId: 't-1', kind: 'diff', href: '/helmsman-diff/?task=t-1', dangling: false })
    expect(associations[1]).toMatchObject({ refId: 't-gone', dangling: true })
  })

  it('404s an unknown item id', async () => {
    const router = makeRouter()
    const { status, body } = await call(router, 'GET', '/api/item/nope')
    expect(status).toBe(404)
    expect(String(body.error)).toContain('item not found')
  })
})

describe('POST api/item (create)', () => {
  it('creates a card in the default initial stage', async () => {
    const create = vi.fn(makeBoard().create as BoardServiceLike['create'])
    const router = makeRouter({ board: makeBoard({ create }) })
    const { status, body } = await call(router, 'POST', '/api/item', { title: '新需求', repoScope: { baseRepo: 'order-core' } })
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect((body.item as Record<string, unknown>).stage).toBe('requirements')
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ title: '新需求', repoScope: { baseRepo: 'order-core' }, stage: 'requirements' }))
  })

  it('rejects a missing title or repo scope with 400', async () => {
    const router = makeRouter()
    expect((await call(router, 'POST', '/api/item', { repoScope: { baseRepo: 'r' } })).status).toBe(400)
    expect((await call(router, 'POST', '/api/item', { title: 'x' })).status).toBe(400)
  })

  it('links the source conversation of the chat-entry flow', async () => {
    const create = vi.fn(async () => makeItem({ id: 'wi-chat', associations: [], runs: [] }))
    const associate = vi.fn(async (id: string) => makeItem({ id, associations: [{ type: 'conversation', refId: 'sess-9', at: 1 }] }))
    const router = makeRouter({ board: makeBoard({ create, associate }) })
    const { body } = await call(router, 'POST', '/api/item', {
      title: '来自会话',
      repoScope: { projectGroup: '订单中台' },
      conversation: { type: 'dsh', sessionId: 'sess-9' },
      docPreset: true,
    })
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ conversation: { type: 'dsh', sessionId: 'sess-9' }, docPreset: true }),
    )
    expect(associate).toHaveBeenCalledWith('wi-chat', expect.objectContaining({ type: 'conversation', refId: 'sess-9' }))
    expect((body.item as Record<string, unknown>).badges).toMatchObject({ conversations: 1 })
  })
})

describe('PATCH api/item/:id (summary + scope)', () => {
  it('saves a user-edited summary through setSummary as manual', async () => {
    const setSummary = vi.fn(async (_id: string, s: { text: string }) => makeItem({ summary: { text: s.text, generatedBy: 'manual', at: 12_345 } }))
    const router = makeRouter({ board: makeBoard({ setSummary }) })
    const { body } = await call(router, 'PATCH', '/api/item/wi-1', { summary: { text: '用户改写的摘要' } })
    expect(setSummary).toHaveBeenCalledWith('wi-1', { text: '用户改写的摘要', generatedBy: 'manual', at: 12_345 })
    expect((body.item as Record<string, unknown>).summary).toMatchObject({ text: '用户改写的摘要', generatedBy: 'manual' })
  })

  it('updates the conflict-domain module scope', async () => {
    const update = vi.fn(async (id: string, patch: { scope?: { module?: string } }) => makeItem({ id, scope: patch.scope }))
    const router = makeRouter({ board: makeBoard({ update }) })
    const { body } = await call(router, 'PATCH', '/api/item/wi-1', { module: 'payment' })
    expect(update).toHaveBeenCalledWith('wi-1', { scope: { module: 'payment' } })
    expect((body.item as Record<string, unknown>).conflictDomain).toBe('order-core:payment')
  })

  it('404s an unknown item', async () => {
    const router = makeRouter()
    expect((await call(router, 'PATCH', '/api/item/nope', { summary: { text: 'x' } })).status).toBe(404)
  })
})

describe('GET api/item/:id/gate', () => {
  it('reports the gaps for a target stage', async () => {
    const gate = vi.fn(async () => ({ ok: false, gaps: [{ key: 'merged-run', label: '至少一个 run 需已 merge' }] }))
    const router = makeRouter({ board: makeBoard({ gate }) })
    const { body } = await call(router, 'GET', '/api/item/wi-1/gate?to=done')
    expect(gate).toHaveBeenCalledWith('wi-1', 'done')
    expect(body).toMatchObject({ ok: false, to: 'done', gaps: [{ key: 'merged-run' }] })
  })

  it('treats a bare gap array as the refusal contract', async () => {
    const gate = vi.fn(async () => [{ key: 'spec', label: '缺少已定稿 spec' }])
    const router = makeRouter({ board: makeBoard({ gate: gate as unknown as BoardServiceLike['gate'] }) })
    const { body } = await call(router, 'GET', '/api/item/wi-1/gate?to=dev')
    expect(body.ok).toBe(false)
    expect((body.gaps as unknown[]).length).toBe(1)
  })

  it('reports the terminal stage instead of failing', async () => {
    const router = makeRouter({ board: makeBoard({ get: vi.fn(async () => makeItem({ stage: 'done' })) }) })
    const { body } = await call(router, 'GET', '/api/item/wi-1/gate')
    expect(body).toMatchObject({ to: null, terminal: true, gaps: [] })
  })
})

describe('POST api/item/:id/advance (the ONLY stage-write path)', () => {
  it('advances one step through the board service', async () => {
    const advance = vi.fn(async () => ({ ok: true, item: makeItem({ stage: 'dev' }), gaps: [] }))
    const router = makeRouter({ board: makeBoard({ advance }) })
    const { status, body } = await call(router, 'POST', '/api/item/wi-1/advance', { to: 'dev' })
    expect(status).toBe(200)
    expect(advance).toHaveBeenCalledWith({ id: 'wi-1', to: 'dev', allowSkip: false })
    expect(body).toMatchObject({ ok: true, moved: true, from: 'spec', to: 'dev' })
    expect((body.item as Record<string, unknown>).stage).toBe('dev')
  })

  it('defaults to a single step when no target is given', async () => {
    const advance = vi.fn(async () => ({ ok: true, item: makeItem({ stage: 'dev' }), gaps: [] }))
    const router = makeRouter({ board: makeBoard({ advance }) })
    await call(router, 'POST', '/api/item/wi-1/advance', {})
    expect(advance).toHaveBeenCalledWith({ id: 'wi-1', to: 'dev', allowSkip: false })
  })

  it('propagates a gate refusal as gaps and does NOT move the card', async () => {
    const refusal = Object.assign(new Error('gate refused'), {
      gaps: [{ key: 'merged-run', label: '需 ≥1 run 已 merge', action: '/helmsman-diff/?task=t-1' }],
    })
    const advance = vi.fn(async () => {
      throw refusal
    })
    const update = vi.fn()
    const router = makeRouter({ board: makeBoard({ advance, update: update as unknown as BoardServiceLike['update'] }) })
    const { status, body } = await call(router, 'POST', '/api/item/wi-1/advance', { to: 'dev' })
    // a refusal is a normal, displayable outcome — not a 500
    expect(status).toBe(200)
    expect(body).toMatchObject({ ok: false, moved: false, from: 'spec', to: 'dev' })
    expect((body.gaps as Array<Record<string, unknown>>)[0]).toMatchObject({ key: 'merged-run', action: '/helmsman-diff/?task=t-1' })
    // the card stays put and nothing wrote the stage outside advance()
    expect((body.item as Record<string, unknown>).stage).toBe('spec')
    expect(update).not.toHaveBeenCalled()
  })

  it('propagates a WIP refusal as a queueing reason with the card left in place', async () => {
    const advance = vi.fn(async () => {
      throw Object.assign(new Error('wip refused'), { queueingReason: '冲突域 order-core:a 已达上限' })
    })
    const router = makeRouter({ board: makeBoard({ advance }) })
    const { body } = await call(router, 'POST', '/api/item/wi-1/advance', { to: 'dev' })
    expect(body.ok).toBe(false)
    expect(body.queueingReason).toBe('冲突域 order-core:a 已达上限')
    expect((body.item as Record<string, unknown>).stage).toBe('spec')
  })

  it('handles a service that returns ok:false instead of throwing, and refuses skips by default', async () => {
    const advance = vi.fn(async ({ allowSkip }: { allowSkip?: boolean }) => ({
      ok: false,
      item: makeItem(),
      gaps: [{ key: 'stage-order', label: allowSkip ? '' : '缺失中间阶段' }],
    }))
    const router = makeRouter({ board: makeBoard({ advance: advance as unknown as BoardServiceLike['advance'] }) })
    const { body } = await call(router, 'POST', '/api/item/wi-1/advance', { to: 'done' })
    expect(advance).toHaveBeenCalledWith({ id: 'wi-1', to: 'done', allowSkip: false })
    expect(body).toMatchObject({ ok: false, moved: false })
    expect((body.gaps as unknown[]).length).toBe(1)
  })

  it('404s an unknown item', async () => {
    const router = makeRouter()
    expect((await call(router, 'POST', '/api/item/nope/advance', {})).status).toBe(404)
  })
})

describe('association routes', () => {
  it('associates a reference', async () => {
    const associate = vi.fn(async (id: string) => makeItem({ id }))
    const router = makeRouter({ board: makeBoard({ associate }) })
    const { body } = await call(router, 'POST', '/api/item/wi-1/associate', { type: 'doc', refId: 'drafts/d-2.md', label: 'PRD v2' })
    expect(associate).toHaveBeenCalledWith('wi-1', { type: 'doc', refId: 'drafts/d-2.md', label: 'PRD v2', at: 12_345 })
    expect(body.ok).toBe(true)
  })

  it('rejects an unknown association type', async () => {
    const router = makeRouter()
    expect((await call(router, 'POST', '/api/item/wi-1/associate', { type: 'nope', refId: 'x' })).status).toBe(400)
  })

  it('disassociates through the query form (refIds are paths)', async () => {
    const disassociate = vi.fn(async (id: string) => makeItem({ id }))
    const router = makeRouter({ board: makeBoard({ disassociate }) })
    const { body } = await call(router, 'DELETE', '/api/item/wi-1/associate?type=doc&refId=drafts%2Fd-1.md')
    expect(disassociate).toHaveBeenCalledWith('wi-1', { type: 'doc', refId: 'drafts/d-1.md' })
    expect(body.ok).toBe(true)
  })

  it('requires a refId', async () => {
    const router = makeRouter()
    expect((await call(router, 'DELETE', '/api/item/wi-1/associate?type=doc')).status).toBe(400)
  })
})

describe('GET api/item/:id/runs', () => {
  it('enriches run refs with live state, conflicts as jump-offs, and pending approvals', async () => {
    const router = makeRouter({ orchestrator: makeOrchestrator, topology: makeTopology })
    const { status, body } = await call(router, 'GET', '/api/item/wi-1/runs')
    expect(status).toBe(200)
    const runs = body.runs as Array<Record<string, unknown>>
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ taskId: 't-1', state: 'merged', stateLabel: '已合并', statusText: 'COMPLETED', merged: true })
    const conflicts = runs[0]!.conflicts as Array<Record<string, unknown>>
    expect(conflicts[0]).toMatchObject({ agent: 'claude', path: 'src/login.ts', href: '/helmsman-diff/?task=t-1' })
    // merged run → impacted-service candidates from diff × topology
    expect(runs[0]!.serviceCandidates).toEqual([
      { refId: 'user-service', label: 'user-service', reason: '改动文件命中 /repos/user-service/src/login.ts' },
    ])
    expect(body.approvals).toEqual([{ approvalId: 'ap-1', op: 'merge', scope: 'merge:task:t-1', source: 'ui', requestedAt: 4_000, expiresAt: 9_000 }])
    expect(body.historyAvailable).toBe(true)
    // the conflict jump-off mount travels with the payload (configurable)
    expect(body.diffMount).toBe('/helmsman-diff')
  })

  it('degrades the run panel without an orchestrator (no conflicts, no candidates)', async () => {
    const router = makeRouter()
    const { body } = await call(router, 'GET', '/api/item/wi-1/runs')
    expect(body.historyAvailable).toBe(false)
    expect(body.approvals).toEqual([])
    const runs = body.runs as Array<Record<string, unknown>>
    expect(runs[0]).toMatchObject({ taskId: 't-1', state: 'idle', merged: false })
    expect(runs[0]!.serviceCandidates).toEqual([])
  })

  it('marks a running run as 在跑 and a board-recorded merge as 已合并', async () => {
    const board = makeBoard({
      get: vi.fn(async () =>
        makeItem({
          runs: [
            { taskId: 't-run', startedAt: 1 },
            { taskId: 't-merged', startedAt: 2, terminal: 'merged' },
          ],
        }),
      ),
    })
    const orchestrator = makeOrchestrator()
    const router = makeRouter({
      board,
      orchestrator: () => ({ ...orchestrator, getTaskStatus: (id: string) => (id === 't-run' ? { id, status: 'RUNNING' } : undefined) }),
    })
    const { body } = await call(router, 'GET', '/api/item/wi-1/runs')
    const runs = body.runs as Array<Record<string, unknown>>
    expect(runs.map((r) => r.state)).toEqual(['running', 'merged'])
  })

  it('404s an unknown item', async () => {
    const router = makeRouter()
    expect((await call(router, 'GET', '/api/item/nope/runs')).status).toBe(404)
  })
})

describe('GET api/run/:taskId/events (SSE polling fallback)', () => {
  it('reads the durable timeline with the cursor and reports pruning', async () => {
    const orchestrator = makeOrchestrator()
    const router = makeRouter({ orchestrator: () => orchestrator })
    const { body } = await call(router, 'GET', '/api/run/t-1/events?after=3')
    expect(orchestrator.history.getEvents).toHaveBeenCalledWith('t-1', 3)
    expect(body).toMatchObject({ after: 3, nextCursor: 7, pruned: false })
    expect((body.events as unknown[]).length).toBe(1)
    expect(body.task).toMatchObject({ id: 't-1', status: 'COMPLETED' })
  })

  it('503s without the orchestrator so the panel can show a degraded state', async () => {
    const router = makeRouter()
    const { status, body } = await call(router, 'GET', '/api/run/t-1/events')
    expect(status).toBe(503)
    expect(String(body.error)).toContain('orchestrator unavailable')
  })
})

describe('GET api/board/events (migration trail)', () => {
  it('passes queryEvents through when the board supports it', async () => {
    const queryEvents = vi.fn(async () => [{ seq: 1, ts: 111, itemId: 'wi-1', from: 'requirements', to: 'spec', actor: 'ui' }])
    const router = makeRouter({ board: makeBoard({ queryEvents }) })
    const { body } = await call(router, 'GET', '/api/board/events?itemId=wi-1&limit=5')
    expect(queryEvents).toHaveBeenCalledWith({ itemId: 'wi-1', limit: 5 })
    expect(body.available).toBe(true)
    expect((body.events as unknown[]).length).toBe(1)
  })

  it('reports unavailability instead of failing', async () => {
    const board = makeBoard()
    delete (board as { queryEvents?: unknown }).queryEvents
    const { body } = await call(makeRouter({ board }), 'GET', '/api/board/events')
    expect(body).toEqual({ events: [], available: false })
  })
})

describe('发起执行入口 gating(projectGroup × 已装 agent,design D1)', () => {
  async function startRunOf(router: Router, itemId = 'wi-1'): Promise<Record<string, unknown>> {
    const { body } = await call(router, 'GET', '/api/items')
    const card = (body.items as Array<Record<string, unknown>>).find((c) => c.id === itemId)
    expect(card, `card ${itemId}`).toBeDefined()
    return card!.startRun as Record<string, unknown>
  }

  it('可用:卡片有 projectGroup 且该群至少一个 agent 已装(未装的其它 agent 不进 installed)', async () => {
    const checkAgents = vi.fn(async () => ({ claude: { installed: true }, codex: { installed: false } }))
    const router = makeRouter({ orchestrator: () => ({ ...makeOrchestrator(), checkAgents }), agentsTtlMs: 0 })
    expect(await startRunOf(router)).toEqual({ available: true, reason: null, projectGroup: '订单中台', installed: ['claude'] })
  })

  it('缺少 projectGroup → 不可用并给中文原因(渲染「请先在执行看板发起」引导)', async () => {
    // wi-3 在 dev 列,repoScope 只有 baseRepo
    const startRun = await startRunOf(makeRouter({ orchestrator: makeOrchestrator, agentsTtlMs: 0 }), 'wi-3')
    expect(startRun).toMatchObject({ available: false, projectGroup: null })
    expect(String(startRun.reason)).toContain('projectGroup')
  })

  it('该群一个 agent 都没装 → 不可用', async () => {
    const checkAgents = vi.fn(async () => ({ claude: { installed: false }, codex: { installed: false } }))
    const router = makeRouter({ orchestrator: () => ({ ...makeOrchestrator(), checkAgents }), agentsTtlMs: 0 })
    const startRun = await startRunOf(router)
    expect(startRun).toMatchObject({ available: false, installed: [] })
    expect(String(startRun.reason)).toContain('暂无已安装的 agent')
  })

  it('orchestrator 缺失 / 方法缺失(旧版安装) → 降级为引导而不是必失败的按钮', async () => {
    expect((await startRunOf(makeRouter({}))).available).toBe(false)
    const orch = makeOrchestrator()
    delete (orch as { checkAgents?: unknown }).checkAgents
    const startRun = await startRunOf(makeRouter({ orchestrator: () => orch, agentsTtlMs: 0 }))
    expect(startRun.available).toBe(false)
    expect(String(startRun.reason)).toContain('编排服务')
  })

  it('探测失败(抛错)也降级', async () => {
    const checkAgents = vi.fn(async () => {
      throw new Error('agent CLI not on PATH')
    })
    const router = makeRouter({ orchestrator: () => ({ ...makeOrchestrator(), checkAgents }), agentsTtlMs: 0 })
    expect((await startRunOf(router)).available).toBe(false)
  })

  it('一次探测按 TTL 复用(轮询不反复 spawn CLI),但不可用结果不被缓存', async () => {
    const checkAgents = vi.fn(async () => ({ claude: { installed: true } }))
    const router = makeRouter({ orchestrator: () => ({ ...makeOrchestrator(), checkAgents }) })
    await call(router, 'GET', '/api/items')
    await call(router, 'GET', '/api/items')
    expect(checkAgents).toHaveBeenCalledTimes(1) // 默认 TTL 内复用

    // 懒解析:先没有 orchestrator(不缓存),再接上时必须立即可用
    let orch: OrchestratorLike | undefined
    const late = makeRouter({ orchestrator: () => orch })
    expect((await startRunOf(late)).available).toBe(false)
    orch = makeOrchestrator()
    expect((await startRunOf(late)).available).toBe(true)
  })
})

describe('POST api/item/:id/run(发起执行:唯一写路径)', () => {
  /** Request body builder (the SPA shape; `agents` doubles as the comma form). */
  const req = (prompt: string, agents: unknown, cascade?: boolean) => ({
    prompt,
    agents,
    ...(cascade === undefined ? {} : { cascade }),
  })
  const runRouter = (orchestrator: OrchestratorLike) => makeRouter({ orchestrator: () => orchestrator, agentsTtlMs: 0 })

  it('只调既有 runParallelTask,参数恰为 {prompt, agents, projectGroupId, cascade}', async () => {
    const orchestrator = makeOrchestrator()
    const { status, body: res } = await call(
      runRouter(orchestrator),
      'POST',
      '/api/item/wi-1/run',
      req('登录接口并行改造\n\n重构登录接口并补充单测。', ['claude'], true),
    )
    expect(status).toBe(200)
    expect(res).toMatchObject({ ok: true, taskId: 't-new', projectGroupId: '订单中台', cascade: true })
    expect(orchestrator.runParallelTask).toHaveBeenCalledTimes(1)
    // 深度相等 = 一个多余参数都不传(timeoutSec / repoPath 都不暴露)
    expect(orchestrator.runParallelTask).toHaveBeenCalledWith({
      prompt: '登录接口并行改造\n\n重构登录接口并补充单测。',
      agents: ['claude'],
      projectGroupId: '订单中台',
      cascade: true,
    })
  })

  it('接受逗号分隔的 agent 串(headless 工具入参形态),去重且忽略空串', async () => {
    const orchestrator = makeOrchestrator()
    const { body: res } = await call(runRouter(orchestrator), 'POST', '/api/item/wi-1/run', req('做点事', 'claude, codex, claude,'))
    expect(orchestrator.runParallelTask).toHaveBeenCalledWith({
      prompt: '做点事',
      agents: ['claude', 'codex'],
      projectGroupId: '订单中台',
      cascade: false, // 复选框没勾 → false,但字段照传
    })
    expect(res.cascade).toBe(false)
  })

  it('唯一写入是「把 run 关联回卡片」;不碰拓扑/声明/忽略,阶段与门不变', async () => {
    const board = makeBoard()
    const orchestrator = makeOrchestrator()
    const topology = makeTopology()
    const artifacts = makeArtifacts()
    const router = makeRouter({ board, orchestrator: () => orchestrator, topology: () => topology, artifacts: () => artifacts, agentsTtlMs: 0 })
    const { body: res } = await call(router, 'POST', '/api/item/wi-1/run', req('做点事', ['claude'], true))
    expect(res.ok).toBe(true)

    // spec「起跑后把 run 关联回卡片」:这是本能力唯一被允许的看板写入
    expect(board.associate).toHaveBeenCalledTimes(1)
    const [linkedId, association] = board.associate.mock.calls[0] as unknown as [string, { type: string; refId: string }]
    expect(linkedId).toBe('wi-1')
    expect(association.type).toBe('run')
    expect(association.refId).toBe(res.taskId)
    expect(res.linked).toBe(true)

    // 其余看板写入一律没有:阶段/门/摘要/创建/解除都不动
    for (const method of ['create', 'update', 'advance', 'disassociate', 'setSummary'] as const) {
      expect(board[method], `board.${method}`).not.toHaveBeenCalled()
    }
    // 门 / WIP 不参与 → 列内追加 run 不被 WIP 拦
    expect(board.gate).not.toHaveBeenCalled()
    // 拓扑与产物服务一次都没被问过 → 拓扑 / 声明 / 忽略清单不可能被改
    expect(topology.loadTopology).not.toHaveBeenCalled()
    expect(artifacts.resolve).not.toHaveBeenCalled()
    // 也没有第二个 orchestrator 通道(取消/合并等生命周期操作仍留在执行看板)
    expect(orchestrator.history.getEvents).not.toHaveBeenCalled()
    expect(orchestrator.listPendingConfirmations).not.toHaveBeenCalled()
  })

  it('关联失败不回滚 run:仍返回 taskId,并如实报告原因', async () => {
    const board = makeBoard()
    board.associate = vi.fn(async () => {
      throw new Error('board store unavailable')
    }) as unknown as typeof board.associate
    const orchestrator = makeOrchestrator()
    const router = makeRouter({ board, orchestrator: () => orchestrator, agentsTtlMs: 0 })
    const { body: res } = await call(router, 'POST', '/api/item/wi-1/run', req('做点事', ['claude'], true))

    // run 已经起跑 → 不回滚,只报告未挂上
    expect(res.ok).toBe(true)
    expect(res.taskId).toBe('t-new')
    expect(res.linked).toBe(false)
    expect(String(res.linkError)).toContain('board store unavailable')
  })

  it('看板服务不支持 associate(旧版)→ run 起跑但明确报告未挂上', async () => {
    const board = makeBoard()
    delete (board as { associate?: unknown }).associate
    const orchestrator = makeOrchestrator()
    const router = makeRouter({ board, orchestrator: () => orchestrator, agentsTtlMs: 0 })
    const { body: res } = await call(router, 'POST', '/api/item/wi-1/run', req('做点事', ['claude'], true))

    expect(res.ok).toBe(true)
    expect(res.linked).toBe(false)
    expect(String(res.linkError)).toContain('associate')
  })

  it('已在第 ③ 列且冲突域已满的卡片仍可发起(WIP 只拦进列)', async () => {
    const board = makeBoard({
      get: vi.fn(async () => makeItem({ stage: 'dev', scope: { module: 'a' }, queueingReason: '冲突域 order-core:a 已达上限' })),
    })
    const runParallelTask = vi.fn(async () => ({ taskId: 't-wip' }))
    const router = makeRouter({ board, orchestrator: () => ({ ...makeOrchestrator(), runParallelTask }), agentsTtlMs: 0 })
    const { status, body: res } = await call(router, 'POST', '/api/item/wi-1/run', req('继续迭代', ['codex'], false))
    expect(status).toBe(200)
    expect(res).toMatchObject({ ok: true, taskId: 't-wip' })
    expect(board.advance).not.toHaveBeenCalled()
    expect(board.gate).not.toHaveBeenCalled()
  })

  it('不可用场景一律 200 + ok:false + 中文原因(不 500),且不调用工具', async () => {
    const orchestrator = makeOrchestrator()

    // 缺 projectGroup
    const noGroup = makeBoard({ get: vi.fn(async () => makeItem({ repoScope: { baseRepo: 'order-core' } })) })
    let out = await call(makeRouter({ board: noGroup, orchestrator: () => orchestrator, agentsTtlMs: 0 }), 'POST', '/api/item/wi-1/run', req('x', ['claude']))
    expect(out.status).toBe(200)
    expect(out.body).toMatchObject({ ok: false })
    expect(String(out.body.reason)).toContain('projectGroup')

    // 没有 orchestrator / 没有 runParallelTask(旧版安装)
    out = await call(makeRouter(), 'POST', '/api/item/wi-1/run', req('x', ['claude']))
    expect(out.status).toBe(200)
    expect(String(out.body.reason)).toContain('编排服务')
    const noRun = makeOrchestrator()
    delete (noRun as { runParallelTask?: unknown }).runParallelTask
    out = await call(makeRouter({ orchestrator: () => noRun, agentsTtlMs: 0 }), 'POST', '/api/item/wi-1/run', req('x', ['claude']))
    expect(String(out.body.reason)).toContain('编排服务')

    // 该群没有已装 agent
    const noneInstalled = makeOrchestrator()
    ;(noneInstalled.checkAgents as ReturnType<typeof vi.fn>).mockResolvedValue({ claude: { installed: false } })
    out = await call(makeRouter({ orchestrator: () => noneInstalled, agentsTtlMs: 0 }), 'POST', '/api/item/wi-1/run', req('x', ['claude']))
    expect(String(out.body.reason)).toContain('暂无已安装的 agent')

    // 用户指定了一个未装的 agent:如实拒绝,不回退到别的 agent
    const onlyClaude = makeOrchestrator()
    ;(onlyClaude.checkAgents as ReturnType<typeof vi.fn>).mockResolvedValue({ claude: { installed: true }, codex: { installed: false } })
    out = await call(makeRouter({ orchestrator: () => onlyClaude, agentsTtlMs: 0 }), 'POST', '/api/item/wi-1/run', req('x', ['codex']))
    expect(out.status).toBe(200)
    expect(String(out.body.reason)).toContain('agent 未安装:codex')
    expect(onlyClaude.runParallelTask).not.toHaveBeenCalled()
    expect(orchestrator.runParallelTask).not.toHaveBeenCalled()
  })

  it('工具本身拒绝(如项目群没有 localPath)→ 可展示原因,不是 500', async () => {
    const runParallelTask = vi.fn(async () => {
      throw new Error('no repoPath: provide params.repoPath or configure services with localPath in the project group topology')
    })
    const { status, body: res } = await call(
      makeRouter({ orchestrator: () => ({ ...makeOrchestrator(), runParallelTask }), agentsTtlMs: 0 }),
      'POST',
      '/api/item/wi-1/run',
      req('x', ['claude'], true),
    )
    expect(status).toBe(200)
    expect(res).toMatchObject({ ok: false })
    expect(String(res.reason)).toContain('no repoPath')
  })

  it('400 缺 prompt / agents 非法;404 卡片不存在', async () => {
    const router = makeRouter({ orchestrator: makeOrchestrator, agentsTtlMs: 0 })
    expect((await call(router, 'POST', '/api/item/wi-1/run', { agents: ['claude'] })).status).toBe(400)
    expect((await call(router, 'POST', '/api/item/wi-1/run', req('   ', ['claude']))).status).toBe(400)
    expect((await call(router, 'POST', '/api/item/wi-1/run', req('x', []))).status).toBe(400)
    expect((await call(router, 'POST', '/api/item/wi-1/run', req('x', ' , '))).status).toBe(400)
    expect((await call(router, 'POST', '/api/item/wi-1/run', req('x', [1, 2]))).status).toBe(400)
    expect((await call(router, 'POST', '/api/item/nope/run', req('x', ['claude']))).status).toBe(404)
  })
})

describe('pure helpers', () => {
  it('derives the card run state from board refs and live tasks', () => {
    expect(runRefState({ taskId: 't', startedAt: 1 }, undefined)).toBe('idle')
    expect(runRefState({ taskId: 't', startedAt: 1 }, { id: 't', status: 'RUNNING' })).toBe('running')
    expect(runRefState({ taskId: 't', startedAt: 1, terminal: 'merged' }, undefined)).toBe('merged')
    expect(runRefState({ taskId: 't', startedAt: 1, terminal: 'discarded' }, undefined)).toBe('done')
  })

  it('flags a refused card as queued', () => {
    const card = toCardPayload(makeItem({ queueingReason: '冲突域 order-core:* 已满', runs: [] }), null)
    expect(card.runState).toBe('queued')
    expect(card.queueingReason).toContain('已满')
  })

  it('derives the 发起执行 gate from projectGroup × installed agents', () => {
    const installed = { available: true, installed: ['claude'], agents: [{ name: 'claude', installed: true }] }
    expect(toCardPayload(makeItem(), null, installed).startRun).toEqual({
      available: true,
      reason: null,
      projectGroup: '订单中台',
      installed: ['claude'],
    })
    expect(toCardPayload(makeItem({ repoScope: { baseRepo: 'order-core' } }), null, installed).startRun).toMatchObject({
      available: false,
      reason: '卡片未配置项目群(projectGroup)',
    })
    expect(startRunCapability(makeItem(), { available: true, installed: [], agents: [] }).reason).toBe('该项目群暂无已安装的 agent')
    expect(startRunCapability(makeItem(), null).reason).toBe('编排服务不可用或无法探测 agent 安装状态')
  })
})
