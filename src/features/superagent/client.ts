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

export interface SuperagentHealth {
  online: boolean
  endpoint: string
  /** 离线原因（网络、超时、非 2xx、响应不是预期形状）。 */
  reason?: string
  /** 执行器暂停时它自己的 state 会给 `paused: true`。 */
  paused?: boolean
}

export interface TicketsResult {
  online: boolean
  tickets: TicketView[]
  reason?: string
}

const TICKETS_PATHS = ['/orchestrator/api/tickets?state=open', '/orchestrator/api/tickets']

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
    for (const path of TICKETS_PATHS) {
      const result = await this.getJson(path)
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
      const tickets = items.map(normalize).filter((ticket): ticket is TicketView => ticket !== undefined)
      return { online: true, tickets }
    }
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
