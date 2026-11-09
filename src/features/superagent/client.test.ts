/**
 * 多端点聚合（change `support-multi-repo-executors`, design D5）。
 *
 * 只测 `SuperagentPool`：单端点 `SuperagentClient` 的行为没有改动，由既有面板用例覆盖。
 * 用注入的 fetch 而不是真网络，才能稳定构造"一端可达一端不可达"这种关键场景。
 */
import { describe, expect, it } from 'vitest'
import { SuperagentPool } from './client.ts'

interface FakeCall {
  url: string
  method: string
}

type Reply = { status?: number; body?: unknown } | 'network'

const START = 'http://127.0.0.1:3082'
const SECOND = 'http://127.0.0.1:3083'

/** 按调用路由返回假响应；`network` 模拟连接被拒。 */
const poolWith = (
  endpoints: string[],
  route: (call: FakeCall) => Reply,
): { pool: SuperagentPool; calls: FakeCall[] } => {
  const calls: FakeCall[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call: FakeCall = { url: String(input), method: init?.method ?? 'GET' }
    calls.push(call)
    const reply = route(call)
    if (reply === 'network') throw new TypeError('fetch failed: ECONNREFUSED')
    return {
      ok: (reply.status ?? 200) < 400,
      status: reply.status ?? 200,
      text: async () => JSON.stringify(reply.body ?? {}),
    } as unknown as Response
  }) as unknown as typeof fetch
  return { pool: new SuperagentPool({ endpoints, timeoutMs: 200, fetch: fetchImpl }), calls }
}

/** 只按端点主机分发；`on` 决定该端点回什么。 */
const byHost = (handlers: Record<string, Reply>): ((call: FakeCall) => Reply) => (call) => {
  for (const [host, reply] of Object.entries(handlers)) {
    if (call.url.startsWith(host)) return reply
  }
  return 'network'
}

describe('SuperagentPool.health', () => {
  it('一个端点可达一个不可达：整池仍在线，逐端点各自标记', async () => {
    const { pool } = poolWith([START, SECOND], byHost({
      [START]: { body: {} },
      [SECOND]: { status: 500 },
    }))
    const health = await pool.health()
    expect(health.online).toBe(true)
    // 旧客户端只认单值：endpoint 取首端点。
    expect(health.endpoint).toBe(START)
    expect(health.reason).toBeUndefined()
    expect(health.endpoints).toEqual([
      { endpoint: START, online: true },
      { endpoint: SECOND, online: false, reason: 'HTTP 500' },
    ])
  })

  it('全离线时 online=false，reason 给出可读的逐端点原因', async () => {
    const { pool } = poolWith([START, SECOND], () => 'network')
    const health = await pool.health()
    expect(health.online).toBe(false)
    expect(health.reason).toContain('所有执行器均不可达')
    expect(health.reason).toContain(START)
    expect(health.reason).toContain(SECOND)
    expect(health.endpoints?.every((entry) => entry.online === false)).toBe(true)
  })

  it('在线端点全部暂停才算整池暂停（个别暂停不冒充）', async () => {
    const { pool } = poolWith([START, SECOND], (call) =>
      call.url.startsWith(START) ? { body: { paused: true } } : { status: 500 },
    )
    const health = await pool.health()
    // 只有一个在线端点且它暂停了 → 整池标暂停。
    expect(health.paused).toBe(true)
    expect(health.endpoints?.[1]?.reason).toBe('HTTP 500')
  })

  it('端点去重、去空、去尾斜杠：同一端点只探测一次', async () => {
    const { pool, calls } = poolWith([`${START}/`, '', '  ', START], () => ({ body: {} }))
    const health = await pool.health()
    expect(health.endpoints).toEqual([{ endpoint: START, online: true }])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`${START}/orchestrator/api/state`)
  })

  it('没有配置端点时返回显式离线，而不是空成功', async () => {
    const { pool } = poolWith([], () => ({ body: {} }))
    const health = await pool.health()
    expect(health.online).toBe(false)
    expect(health.reason).toBe('没有配置执行器端点')
    expect(health.endpoints).toEqual([])
  })
})

describe('SuperagentPool.tickets', () => {
  it('合并在线端点的 Ticket 并打上来源 endpoint，离线端点不抹掉在线结果', async () => {
    const { pool } = poolWith([START, SECOND], byHost({
      [START]: { body: { items: [{ id: 'tkt-1', title: '做', stage: 'working' }] } },
      [SECOND]: { status: 502 },
    }))
    const result = await pool.tickets()
    expect(result.online).toBe(true)
    expect(result.tickets).toHaveLength(1)
    expect(result.tickets[0]?.id).toBe('tkt-1')
    expect(result.tickets[0]?.endpoint).toBe(START)
    expect(result.endpoints).toEqual([
      { endpoint: START, online: true },
      { endpoint: SECOND, online: false, reason: 'HTTP 502' },
    ])
  })

  it('两个在线端点的 Ticket 合并且各自带来源 endpoint', async () => {
    const { pool } = poolWith([START, SECOND], (call) =>
      call.url.startsWith(START)
        ? { body: { items: [{ id: 'tkt-a', title: 'A' }] } }
        : { body: { items: [{ id: 'tkt-b', title: 'B' }] } },
    )
    const result = await pool.tickets()
    const byId = new Map(result.tickets.map((ticket) => [ticket.id, ticket]))
    expect(byId.get('tkt-a')?.endpoint).toBe(START)
    expect(byId.get('tkt-b')?.endpoint).toBe(SECOND)
  })

  it('全离线时 online=false 且原因可读', async () => {
    const { pool } = poolWith([START, SECOND], () => 'network')
    const result = await pool.tickets()
    expect(result.online).toBe(false)
    expect(result.tickets).toEqual([])
    expect(result.reason).toContain('所有执行器均不可达')
  })
})

describe('SuperagentPool.action', () => {
  it('给了 Ticket 所属 endpoint 时优先路由到它', async () => {
    const { pool, calls } = poolWith([START, SECOND], (call) => {
      if (call.method === 'GET') return { body: {} }
      // 首端点拒绝，第二端点成功；调用方说 Ticket 在第二端点。
      return call.url.startsWith(START) ? { status: 500 } : { status: 200 }
    })
    const result = await pool.action('tkt-1', 'retry', SECOND)
    expect(result.ok).toBe(true)
    const posts = calls.filter((call) => call.method === 'POST')
    expect(posts.map((call) => call.url)).toEqual([
      `${SECOND}/orchestrator/api/tickets/tkt-1/retry`,
    ])
  })

  it('未给 endpoint 时对在线端点依次尝试，首个失败再试下一个', async () => {
    const { pool, calls } = poolWith([START, SECOND], (call) => {
      if (call.method === 'GET') return { body: {} }
      return call.url.startsWith(START) ? { status: 500 } : { status: 200 }
    })
    const result = await pool.action('tkt-1', 'stop')
    expect(result.ok).toBe(true)
    const posts = calls.filter((call) => call.method === 'POST').map((call) => call.url)
    expect(posts).toEqual([
      `${START}/orchestrator/api/tickets/tkt-1/stop`,
      `${SECOND}/orchestrator/api/tickets/tkt-1/stop`,
    ])
  })

  it('全离线时直接失败，不发写请求', async () => {
    const { pool, calls } = poolWith([START, SECOND], () => 'network')
    const result = await pool.action('tkt-1', 'stop')
    expect(result).toEqual({ ok: false, reason: '没有在线的执行器端点' })
    expect(calls.every((call) => call.method === 'GET')).toBe(true)
  })

  it('给了未知 endpoint 时退回在线端点', async () => {
    const { pool } = poolWith([START], () => ({ body: {} }))
    const result = await pool.action('tkt-1', 'retry', 'http://127.0.0.1:9999')
    expect(result.ok).toBe(true)
  })
})
