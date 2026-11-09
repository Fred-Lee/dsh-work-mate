/**
 * Super-agent 管理 API 的服务端代理（change `adopt-superagent-openspec-source`, task 9）。
 *
 * 三条硬约束（来自审查与实测）：
 *   1. 浏览器不能直连：它的 `sameOrigin` 要求 loopback Host + `x-orchestrator-request: 1`，
 *      且 Origin 必须是自己。面板在 3080，跨源会被 403 —— 所以由宿主代理。
 *   2. 任何失败都只降级成 `offline`，不抛栈：面板要能显示"执行器离线"而不是白屏。
 *   3. 字段名以它的视图为准：目录是顶层 `directory`，不是 `execution.directory`
 *      （`src/app/views/records.ts:129`），空值会被省略。
 */
import type { TicketView } from './project.ts'

export interface SuperagentOptions {
  endpoint: string
  timeoutMs: number
  /** 测试注入；默认全局 fetch。 */
  fetch?: typeof fetch
}

/** 单个执行器端点的健康快照（多端点部署时由 `SuperagentPool` 聚合）。 */
export interface EndpointHealth {
  endpoint: string
  online: boolean
  /** 离线原因（网络、超时、非 2xx、响应不是预期形状）。 */
  reason?: string
  /** 执行器暂停时它自己的 state 会给 `paused: true`。 */
  paused?: boolean
}

export interface SuperagentHealth {
  online: boolean
  endpoint: string
  /** 离线原因（网络、超时、非 2xx、响应不是预期形状）。 */
  reason?: string
  /** 执行器暂停时它自己的 state 会给 `paused: true`。 */
  paused?: boolean
  /**
   * 逐端点健康；单端点 `SuperagentClient` 不填（它只有一个端点），
   * 由 `SuperagentPool` 聚合后给出。
   */
  endpoints?: EndpointHealth[]
}

export interface TicketsResult {
  online: boolean
  tickets: TicketView[]
  reason?: string
  /** 逐端点读取结果；单端点 `SuperagentClient` 不填。 */
  endpoints?: EndpointHealth[]
}

// 不带 state 过滤：完成列需要看到已结束的 Ticket（open 过滤会把它们藏掉）。
// 完成列需要已结束的 Ticket、执行列需要进行中的：两态各取一次后合并。
const TICKET_STATES = ['open', 'ended'] as const

const normalize = (raw: unknown): TicketView | undefined => {
  if (typeof raw !== 'object' || raw === null) return undefined
  const value = raw as Record<string, unknown>
  if (typeof value.id !== 'string' || value.id === '') return undefined
  const endedRaw = value.ended
  const ended =
    typeof endedRaw === 'object' && endedRaw !== null
      ? {
          outcome: typeof (endedRaw as { outcome?: unknown }).outcome === 'string'
            ? String((endedRaw as { outcome?: unknown }).outcome)
            : undefined,
          at: typeof (endedRaw as { at?: unknown }).at === 'string'
            ? String((endedRaw as { at?: unknown }).at)
            : undefined,
        }
      : undefined
  const attentionRaw = value.attention
  return {
    id: value.id,
    title: typeof value.title === 'string' ? value.title : value.id,
    ...(typeof value.stage === 'string' ? { stage: value.stage } : {}),
    ...(typeof value.action === 'string' ? { action: value.action } : {}),
    ...(ended !== undefined ? { ended } : {}),
    ...(typeof value.directory === 'string' && value.directory !== '' ? { directory: value.directory } : {}),
    ...(typeof value.summary === 'string' && value.summary !== '' ? { summary: value.summary } : {}),
    ...(typeof value.sessionId === 'string' && value.sessionId !== '' ? { sessionId: value.sessionId } : {}),
    ...(typeof attentionRaw === 'object' && attentionRaw !== null
      ? {
          attention: {
            question: typeof (attentionRaw as { question?: unknown }).question === 'string'
              ? String((attentionRaw as { question?: unknown }).question)
              : undefined,
          },
        }
      : {}),
  }
}

export class SuperagentClient {
  private readonly doFetch: typeof fetch

  constructor(private readonly options: SuperagentOptions) {
    this.doFetch = options.fetch ?? fetch
  }

  private url(path: string): string {
    return `${this.options.endpoint.replace(/\/$/, '')}${path}`
  }

  private async getJson(path: string): Promise<{ ok: true; value: unknown } | { ok: false; reason: string }> {
    try {
      const response = await this.doFetch(this.url(path), {
        method: 'GET',
        headers: { 'x-orchestrator-request': '1', accept: 'application/json' },
        signal: AbortSignal.timeout(this.options.timeoutMs),
      })
      if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` }
      const text = await response.text()
      try {
        return { ok: true, value: JSON.parse(text) }
      } catch {
        return { ok: false, reason: '响应不是合法 JSON' }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return { ok: false, reason: reason.includes('aborted') || reason.includes('timeout') ? '请求超时' : reason }
    }
  }

  /** 探活：`GET /orchestrator/api/state`。任何失败都返回 `online: false` + 原因。 */
  async health(): Promise<SuperagentHealth> {
    const result = await this.getJson('/orchestrator/api/state')
    if (!result.ok) return { online: false, endpoint: this.options.endpoint, reason: result.reason }
    const value = result.value
    const paused = typeof value === 'object' && value !== null && (value as { paused?: unknown }).paused === true
    return { online: true, endpoint: this.options.endpoint, ...(paused ? { paused: true } : {}) }
  }

  /** 读 Ticket 列表；先试 `state=open`，不支持时退回全量。 */
  async tickets(): Promise<TicketsResult> {
    let lastReason = ''
    const merged = new Map<string, TicketView>()
    for (const state of TICKET_STATES) {
      const result = await this.getJson(`/orchestrator/api/tickets?state=${state}`)
      if (!result.ok) {
        lastReason = result.reason
        continue
      }
      const value = result.value
      const items = Array.isArray(value)
        ? value
        : typeof value === 'object' && value !== null && Array.isArray((value as { items?: unknown }).items)
          ? ((value as { items: unknown[] }).items)
          : undefined
      if (items === undefined) {
        lastReason = '响应里没有 items 数组'
        continue
      }
      for (const ticket of items.map(normalize).filter((ticket): ticket is TicketView => ticket !== undefined)) {
        merged.set(ticket.id, ticket)
      }
    }
    if (merged.size > 0 || lastReason === '') return { online: true, tickets: [...merged.values()] }
    return { online: false, tickets: [], reason: lastReason || '无法读取 Ticket 列表' }
  }

  /** 代理一个写动作（retry / stop）；返回是否成功与原因，不抛栈。 */
  async action(ticketId: string, action: 'retry' | 'stop'): Promise<{ ok: boolean; reason?: string }> {
    try {
      const response = await this.doFetch(this.url(`/orchestrator/api/tickets/${encodeURIComponent(ticketId)}/${action}`), {
        method: 'POST',
        headers: { 'x-orchestrator-request': '1' },
        signal: AbortSignal.timeout(this.options.timeoutMs),
      })
      if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` }
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }
}

/* ── 多端点聚合（change `support-multi-repo-executors`, design D5） ───────── */

export interface SuperagentPoolOptions {
  /** 端点列表（构造时去重、去空、去尾斜杠）。 */
  endpoints: string[]
  timeoutMs: number
  /** 测试注入；默认全局 fetch。 */
  fetch?: typeof fetch
}

export type SuperagentPoolHealth = SuperagentHealth & { endpoints: EndpointHealth[] }
export type SuperagentPoolTickets = TicketsResult & { endpoints: EndpointHealth[] }

/** 全离线时的人话原因：面板直接显示它，不必让使用者去猜是哪台掉线。 */
const unreachableReason = (offline: ReadonlyArray<EndpointHealth>): string =>
  `所有执行器均不可达：${offline.map((entry) => `${entry.endpoint}（${entry.reason ?? '未知原因'}）`).join('、')}`

/**
 * 多执行器端点的聚合器：每个端点一个 `SuperagentClient`，**逐个独立**探活与取 Ticket。
 *
 * 失败隔离是这里的全部意义（design D5）：一个端点不可达只把它自己标成 offline，
 * 不影响其它端点的健康与 Ticket 投影，更不会让整块任务视图变成离线。
 * 单端点行为与 `SuperagentClient` 等价，所以装配处可以一律用它。
 */
export class SuperagentPool {
  private readonly endpointList: readonly string[]
  private readonly clients: readonly SuperagentClient[]

  constructor(options: SuperagentPoolOptions) {
    // 去重去空：同一端点写两遍只会让面板把"N 个执行器"数错。
    this.endpointList = [
      ...new Set(
        options.endpoints
          .map((endpoint) => endpoint.trim().replace(/\/+$/, ''))
          .filter((endpoint) => endpoint !== ''),
      ),
    ]
    this.clients = this.endpointList.map(
      (endpoint) =>
        new SuperagentClient({
          endpoint,
          timeoutMs: options.timeoutMs,
          ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
        }),
    )
  }

  /** 全部端点任一在线即 `online: true`；`endpoint` 取首端点（旧客户端兼容）。 */
  async health(): Promise<SuperagentPoolHealth> {
    if (this.endpointList.length === 0) {
      return { online: false, endpoint: '', reason: '没有配置执行器端点', endpoints: [] }
    }
    const endpoints = await Promise.all(
      this.clients.map(async (client, index): Promise<EndpointHealth> => {
        const health = await client.health()
        return {
          endpoint: this.endpointList[index]!,
          online: health.online,
          ...(health.reason !== undefined ? { reason: health.reason } : {}),
          ...(health.paused === true ? { paused: true } : {}),
        }
      }),
    )
    const online = endpoints.filter((entry) => entry.online)
    const offline = endpoints.filter((entry) => !entry.online)
    return {
      online: online.length > 0,
      // 首端点：旧面板只认单值，保留它才能让未升级的客户端继续显示「主执行器」。
      endpoint: this.endpointList[0]!,
      ...(online.length === 0 ? { reason: unreachableReason(offline) } : {}),
      // 只有在线端点全部暂停时才把整池标成暂停：个别暂停不该让旧面板显示「已暂停」。
      ...(online.length > 0 && online.every((entry) => entry.paused === true) ? { paused: true } : {}),
      endpoints,
    }
  }

  /** 合并各在线端点的 Ticket；每条打上来源端点，离线端点不产生 Ticket 但原因可见。 */
  async tickets(): Promise<SuperagentPoolTickets> {
    if (this.endpointList.length === 0) {
      return { online: false, tickets: [], reason: '没有配置执行器端点', endpoints: [] }
    }
    const results = await Promise.all(this.clients.map((client) => client.tickets()))
    const endpoints: EndpointHealth[] = []
    const merged = new Map<string, TicketView>()
    for (const [index, result] of results.entries()) {
      const endpoint = this.endpointList[index]!
      endpoints.push({
        endpoint,
        online: result.online,
        ...(result.reason !== undefined ? { reason: result.reason } : {}),
      })
      if (!result.online) continue
      for (const ticket of result.tickets) {
        // 保留先到的那份：同一 Ticket 被两个端点报出来说明端点配置有问题，
        // 此时丢数据比显示两份更糟，路由仍按第一个来源端点走。
        if (!merged.has(ticket.id)) merged.set(ticket.id, { ...ticket, endpoint })
      }
    }
    const online = endpoints.filter((entry) => entry.online)
    const offline = endpoints.filter((entry) => !entry.online)
    return {
      online: online.length > 0,
      tickets: [...merged.values()],
      ...(online.length === 0 ? { reason: unreachableReason(offline) } : {}),
      endpoints,
    }
  }

  /**
   * 代理写动作（retry / stop）。路由顺序：
   *   1. Ticket 所属端点（调用方从投影里把 `ticket.endpoint` 带上来）优先；
   *   2. 未给或它失败，再对在线端点依次尝试——执行器重启后 Ticket 可能换到另一个端点。
   */
  async action(
    ticketId: string,
    action: 'retry' | 'stop',
    endpoint?: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    const healths = await Promise.all(this.clients.map((client) => client.health()))
    const online = healths.flatMap((health, index) => (health.online ? [index] : []))
    const preferred =
      endpoint !== undefined ? this.endpointList.indexOf(endpoint.trim().replace(/\/+$/, '')) : -1
    const order = [...(preferred >= 0 ? [preferred] : []), ...online.filter((index) => index !== preferred)]
    if (order.length === 0) return { ok: false, reason: '没有在线的执行器端点' }
    let lastReason: string | undefined
    for (const index of order) {
      const result = await this.clients[index]!.action(ticketId, action)
      if (result.ok) return result
      lastReason = result.reason
    }
    return { ok: false, ...(lastReason !== undefined ? { reason: lastReason } : {}) }
  }
}
