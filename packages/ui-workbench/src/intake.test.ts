/**
 * Router tests for the task intake channel (add-task-workitem-model T5.2).
 *
 * Drives the REAL MiniRouter through `registerIntakeRoutes`, so the route path,
 * body parsing, error-status mapping and the degrade contracts are all covered:
 *   - happy path: board.create receives the conversation association + summary
 *   - board plugin absent → clear 「未安装 @helmsman/board」 error (no TypeError)
 *   - summary generation failure → the card is STILL created with a fallback
 *   - sessions facade → empty list + available:false when no seam is wired
 */
import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { MiniRouter } from './router.ts'
import {
  getRecentSessions,
  readRecentMessages,
  registerIntakeRoutes,
  type BoardCreateInput,
  type BoardServiceLike,
  type ConversationMessage,
  type IntakeDeps,
} from './intake.ts'

// ── req/res stubs (same conventions as @helmsman/ui-dashboard's api.test.ts) ──

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

/** Drives the real MiniRouter. Its contract (unlike ui-dashboard's router) is to
 * RETURN `{ status, body }`; the host writes the response — so the assertions
 * read the return value, and a fake res only satisfies the handler signature. */
async function call(deps: IntakeDeps, method: string, path: string, body?: unknown) {
  const router = new MiniRouter()
  registerIntakeRoutes(router, deps)
  const handled = await router.handle(fakeReq(method, body), fakeRes().res, path)
  if (!handled.ok) throw new Error(`no route matched ${method} ${path}`)
  return { status: handled.status, json: (handled.body ?? {}) as Record<string, any> }
}

// ── stubs ──────────────────────────────────────────────────────────────────

/** Board stub whose `create` deliberately IGNORES summary/associations — the
 * intake must fall back to associate()/setSummary() and still deliver both. */
function fakeBoard(echo: Partial<{ summary: unknown; associations: unknown[] }> = {}) {
  const calls = { create: [] as BoardCreateInput[] }
  const board: BoardServiceLike = {
    create: vi.fn(async (input: BoardCreateInput) => {
      calls.create.push(input)
      return { id: 'wi-1', title: input.title, stage: input.stage, ...echo }
    }),
    associate: vi.fn(async () => undefined),
    setSummary: vi.fn(async () => undefined),
    get: vi.fn(async () => undefined),
    list: vi.fn(async () => []),
  }
  return { board, calls, associate: board.associate as ReturnType<typeof vi.fn>, setSummary: board.setSummary as ReturnType<typeof vi.fn> }
}

/** Live DSH session stub (`ctx.get('sessions').get(id)`): seq/eventAt contract. */
function liveSession(events: unknown[], cwd?: string) {
  return {
    seq: events.length,
    ...(cwd !== undefined ? { header: { cwd } } : {}),
    eventAt: (seq: number) => events[seq],
  }
}

function userMessage(text: string, kind: 'user' | 'tool' = 'user') {
  return { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text }], source: { kind } } }
}

function assistantMessage(text: string) {
  return { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text }] } } }
}

const CONVERSATION_EVENTS = [
  userMessage('帮我给订单服务加一个修改密码接口'),
  assistantMessage('好的,我先看现有的认证模块与用户表结构'),
  userMessage('[tool-result] 不该进摘要', 'tool'),
  userMessage('记得补上单元测试与接口文档'),
]

function depsWith(overrides: Partial<IntakeDeps> = {}): IntakeDeps {
  return {
    board: () => undefined,
    now: () => 1_700_000_000_000,
    ...overrides,
  }
}

// ── 建档:happy path ────────────────────────────────────────────────────────

describe('POST api/task-from-conversation', () => {
  it('creates the card with the conversation association and a model summary', async () => {
    const { board, calls, associate } = fakeBoard()
    const summarize = vi.fn(async () => ({ status: 'completed', text: '主题:修改密码接口\n进展:已定位认证模块\n下一步:补测试与文档\n第 4 行保留\n第 5 行会被裁掉' }))
    const { status, json } = await call(
      depsWith({
        board: () => board,
        sessions: () => ({ get: (id: string) => (id === 'sess-1' ? liveSession(CONVERSATION_EVENTS) : undefined) }),
        summarizer: () => ({ summarize }),
      }),
      'POST',
      '/api/task-from-conversation',
      { title: '订单服务修改密码接口', sessionId: 'sess-1', repo: '/repo/order', projectGroup: '订单中台', stage: 'spec' },
    )

    expect(status).toBe(200)
    expect(calls.create).toHaveLength(1)
    const input = calls.create[0]!
    expect(input.title).toBe('订单服务修改密码接口')
    expect(input.stage).toBe('spec')
    expect(input.repoScope).toEqual({ baseRepo: '/repo/order', projectGroup: '订单中台' })
    // 关联是引用 + label 快照(design D3),不是会话内容副本;`at` 由 board 盖章。
    expect(input.associations?.[0]).toEqual({
      type: 'conversation',
      refId: 'sess-1',
      label: '订单服务修改密码接口',
    })
    // 模型摘要按 2–4 行契约裁剪到 4 行,且带上来源与生成方式。
    expect(input.summary).toMatchObject({ generatedBy: 'model', source: 'dsh' })
    expect(input.summary?.text.split('\n')).toHaveLength(4)
    expect(input.summary?.text).not.toContain('第 5 行会被裁掉')
    // create 未落 associations → intake 用 associate() 补上(同一引用)。
    expect(associate).toHaveBeenCalledWith('wi-1', input.associations?.[0])
    // 工具结果消息不进提示词。
    const prompt = summarize.mock.calls[0]![0] as { text: string }
    expect(prompt.text).toContain('修改密码接口')
    expect(prompt.text).not.toContain('不该进摘要')
    // 返回值可直接打开卡片。
    expect(json).toMatchObject({ ok: true, id: 'wi-1', stage: 'spec' })
    expect(json.context).toEqual({ messages: 3, source: 'sessions' })
  })

  it('reads a finished session through sessionQuery when it is not live', async () => {
    const { board, calls } = fakeBoard()
    const { status } = await call(
      depsWith({
        board: () => board,
        sessionQuery: () => ({ readSession: async () => ({ events: CONVERSATION_EVENTS }) }),
      }),
      'POST',
      '/api/task-from-conversation',
      { title: '从已结束会话建档', sessionId: 'sess-done', repo: '/repo/order' },
    )
    expect(status).toBe(200)
    // 缺省阶段 = 需求分析;无 summarizer → 退化摘要来自最近消息前 ~200 字。
    expect(calls.create[0]!.stage).toBe('requirements')
    expect(calls.create[0]!.summary).toMatchObject({ generatedBy: 'fallback' })
    expect(calls.create[0]!.summary?.text).toContain('记得补上单元测试与接口文档')
  })

  it('writes the summary back when create ignores it, and skips a duplicate association', async () => {
    const conv = { type: 'conversation', refId: 'sess-1', label: '标题', at: '2026-09-12T00:00:00.000Z' }
    const { board, setSummary, associate } = fakeBoard({ associations: [conv] })
    const { status } = await call(
      depsWith({
        board: () => board,
        sessions: () => ({ get: () => liveSession(CONVERSATION_EVENTS) }),
      }),
      'POST',
      '/api/task-from-conversation',
      { title: '标题', sessionId: 'sess-1', repo: '/repo/order' },
    )
    expect(status).toBe(200)
    expect(setSummary).toHaveBeenCalledTimes(1)
    // create 已经落了同一条引用 → 不再重复 associate。
    expect(associate).not.toHaveBeenCalled()
  })

  it('keeps the caller-supplied summary as manual', async () => {
    const { board, calls } = fakeBoard()
    const summarize = vi.fn(async () => ({ status: 'completed', text: '模型摘要' }))
    await call(
      depsWith({ board: () => board, summarizer: () => ({ summarize }) }),
      'POST',
      '/api/task-from-conversation',
      { title: '手工摘要卡片', repo: '/repo/order', summary: '用户自己写的两行摘要\n第二行' },
    )
    expect(calls.create[0]!.summary).toMatchObject({ generatedBy: 'manual', text: '用户自己写的两行摘要\n第二行' })
    expect(summarize).not.toHaveBeenCalled()
  })

  it('creates a card without a conversation when no sessionId is given', async () => {
    const { board, calls } = fakeBoard()
    const { status, json } = await call(
      depsWith({ board: () => board }),
      'POST',
      '/api/task-from-conversation',
      { title: '无来源会话', repo: '/repo/order' },
    )
    expect(status).toBe(200)
    expect(calls.create[0]!.associations).toBeUndefined()
    expect(json.context).toEqual({ messages: 0, source: 'none' })
  })

  it('rejects an unknown stage with 400', async () => {
    const { board, calls } = fakeBoard()
    const { status, json } = await call(
      depsWith({ board: () => board }),
      'POST',
      '/api/task-from-conversation',
      { title: '越级', stage: 'archived' },
    )
    expect(status).toBe(400)
    expect(json.error).toContain('invalid stage')
    expect(calls.create).toHaveLength(0)
  })

  it('rejects a missing title with 400', async () => {
    const { board, calls } = fakeBoard()
    const { status, json } = await call(depsWith({ board: () => board }), 'POST', '/api/task-from-conversation', {})
    expect(status).toBe(400)
    expect(json.error).toContain('invalid title')
    expect(calls.create).toHaveLength(0)
  })

  it('derives repoScope from the source session cwd when the body omits it', async () => {
    const { board, calls } = fakeBoard()
    const { status } = await call(
      depsWith({
        board: () => board,
        sessions: () => ({ get: () => liveSession(CONVERSATION_EVENTS, '/repo/order-service') }),
      }),
      'POST',
      '/api/task-from-conversation',
      { title: '从会话 cwd 推断仓库', sessionId: 'sess-1' },
    )
    expect(status).toBe(200)
    expect(calls.create[0]!.repoScope).toEqual({ baseRepo: '/repo/order-service' })
  })

  it('rejects a request with neither repo identity nor a resolvable session cwd', async () => {
    const { board, calls } = fakeBoard()
    const { status, json } = await call(
      depsWith({ board: () => board, sessions: () => ({ get: () => liveSession(CONVERSATION_EVENTS) }) }),
      'POST',
      '/api/task-from-conversation',
      { title: '没有仓库标识', sessionId: 'sess-1' },
    )
    expect(status).toBe(400)
    expect(json.error).toContain('invalid repo')
    expect(calls.create).toHaveLength(0)
  })
})

// ── 降级:board 插件缺失 ────────────────────────────────────────────────────

describe('task intake degradation: board plugin absent', () => {
  it('returns a clear 「未安装 @helmsman/board」 error instead of a TypeError', async () => {
    const { status, json } = await call(
      depsWith(),
      'POST',
      '/api/task-from-conversation',
      { title: '没有看板插件', sessionId: 'sess-1', repo: '/repo/order' },
    )
    expect(status).toBe(500)
    expect(json.error).toContain('未安装 @helmsman/board')
    expect(json.error).not.toMatch(/TypeError|undefined is not a function/)
  })
})

// ── 摘要失败:卡片仍建成 ────────────────────────────────────────────────────

describe('task intake degradation: summary generation fails', () => {
  it('still creates the card with a fallback summary when the generator reports failure', async () => {
    const { board, calls } = fakeBoard()
    const { status, json } = await call(
      depsWith({
        board: () => board,
        sessions: () => ({ get: () => liveSession(CONVERSATION_EVENTS) }),
        summarizer: () => ({ summarize: async () => ({ status: 'failed', error: 'model down' }) }),
      }),
      'POST',
      '/api/task-from-conversation',
      { title: '摘要失败也要建卡', sessionId: 'sess-1', repo: '/repo/order' },
    )
    expect(status).toBe(200)
    expect(calls.create).toHaveLength(1)
    expect(json.summary).toMatchObject({ generatedBy: 'fallback', source: 'dsh' })
    // 退化摘要 = 最近消息前 ~200 字(最多 4 行,含工具结果过滤)。
    expect(json.summary.text).toContain('记得补上单元测试与接口文档')
    expect(json.summary.text.length).toBeLessThanOrEqual(201)
    expect(json.summary.text).not.toContain('不该进摘要')
  })

  it('still creates the card when the summarizer throws', async () => {
    const { board, calls } = fakeBoard()
    const { status, json } = await call(
      depsWith({
        board: () => board,
        sessions: () => ({ get: () => liveSession(CONVERSATION_EVENTS) }),
        summarizer: () => ({ summarize: async () => { throw new Error('boom') } }),
      }),
      'POST',
      '/api/task-from-conversation',
      { title: '抛错也要建卡', sessionId: 'sess-1', repo: '/repo/order' },
    )
    expect(status).toBe(200)
    expect(calls.create).toHaveLength(1)
    expect(json.summary.generatedBy).toBe('fallback')
  })

  it('falls back to a placeholder when the transcript cannot be read at all', async () => {
    const { board, calls } = fakeBoard()
    const { status, json } = await call(
      depsWith({ board: () => board, sessionQuery: () => ({ readSession: async () => { throw new Error('no store') } }) }),
      'POST',
      '/api/task-from-conversation',
      { title: '读不到会话', sessionId: 'sess-missing', repo: '/repo/order' },
    )
    expect(status).toBe(200)
    expect(calls.create[0]!.summary).toMatchObject({ generatedBy: 'fallback' })
    expect(json.summary.text).toContain('摘要待补充')
  })
})

// ── 会话门面 ────────────────────────────────────────────────────────────────

describe('GET api/sessions (getRecentSessions facade)', () => {
  it('degrades to an empty list when no session seam is available', async () => {
    const { status, json } = await call(depsWith(), 'GET', '/api/sessions')
    expect(status).toBe(200)
    expect(json).toEqual({ sessions: [], available: false })
  })

  it('degrades to an empty list when listing throws', async () => {
    const { json } = await call(
      depsWith({ sessionQuery: () => ({ listSessions: async () => { throw new Error('corpus unavailable') } }) }),
      'GET',
      '/api/sessions',
    )
    expect(json).toEqual({ sessions: [], available: false })
  })

  it('lists recent sessions newest-first with a best-effort title', async () => {
    const { status, json } = await call(
      depsWith({
        sessionQuery: () => ({
          listSessions: async () => [
            { header: { id: 's-old', createdAt: 1000 }, live: false },
            { header: { id: 's-new', createdAt: 2000, cwd: '/repo/order' }, live: true },
          ],
        }),
        sessions: () => ({ get: (id: string) => (id === 's-new' ? liveSession(CONVERSATION_EVENTS) : undefined) }),
        sessionTitle: () => ({ get: () => ({ title: '修改密码接口' }) }),
      }),
      'GET',
      '/api/sessions',
    )
    expect(status).toBe(200)
    expect(json.available).toBe(true)
    expect(json.sessions.map((s: { id: string }) => s.id)).toEqual(['s-new', 's-old'])
    expect(json.sessions[0]).toMatchObject({ id: 's-new', title: '修改密码接口', createdAt: 2000, live: true })
  })

  it('derives a title from the first user message when sessionTitle is absent', async () => {
    const { json } = await call(
      depsWith({
        sessionQuery: () => ({ listSessions: async () => [{ header: { id: 's-1', createdAt: 1 }, live: true }] }),
        sessions: () => ({ get: () => liveSession(CONVERSATION_EVENTS) }),
      }),
      'GET',
      '/api/sessions',
    )
    expect(json.sessions[0].title).toBe('帮我给订单服务加一个修改密码接口')
  })
})

// ── 会话读取 ────────────────────────────────────────────────────────────────

describe('readRecentMessages / getRecentSessions seams', () => {
  it('prefers the live session and filters tool-result messages', async () => {
    const result = await readRecentMessages(
      depsWith({ sessions: () => ({ get: () => liveSession(CONVERSATION_EVENTS) }) }),
      'sess-1',
    )
    expect(result.source).toBe('sessions')
    expect(result.messages).toEqual<ConversationMessage[]>([
      { role: 'user', text: '帮我给订单服务加一个修改密码接口' },
      { role: 'assistant', text: '好的,我先看现有的认证模块与用户表结构' },
      { role: 'user', text: '记得补上单元测试与接口文档' },
    ])
  })

  it('returns an empty context (not an error) when every seam is unavailable', async () => {
    const result = await readRecentMessages(depsWith(), 'sess-1')
    expect(result).toEqual({ messages: [], source: 'none' })
    const listed = await getRecentSessions(depsWith())
    expect(listed).toEqual({ sessions: [], available: false })
  })
})
