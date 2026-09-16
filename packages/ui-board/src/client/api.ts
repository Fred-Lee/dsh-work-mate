/**
 * Client-side API layer + shared payload types (mirror of the host router in
 * ../api.ts) and the run-timeline SSE subscription helper.
 *
 * The API base is derived from the page location so a non-default `mountPath`
 * keeps working: the SPA is always served from `<mount>/`, hence its API lives
 * at `<mount>/api`. It falls back to the default under jsdom/SSR.
 */
import {
  isTerminalEvent,
  parseExecutionEvent,
  type ClientExecutionEvent,
  type RunStreamStatus,
} from './events'

// ---------------------------------------------------------------------------
// Stage model (mirror of src/api.ts)
// ---------------------------------------------------------------------------

export const STAGES = ['requirements', 'spec', 'dev', 'done'] as const
export type Stage = (typeof STAGES)[number]

export const STAGE_LABELS: Record<Stage, string> = {
  requirements: '需求分析',
  spec: '规格设计',
  dev: '开发实施',
  done: '验收归档',
}

export function isStage(value: unknown): value is Stage {
  return typeof value === 'string' && (STAGES as readonly string[]).includes(value)
}

export function stageIndex(stage: Stage): number {
  return STAGES.indexOf(stage)
}

export function nextStage(stage: Stage): Stage | null {
  const i = stageIndex(stage)
  return i >= 0 && i < STAGES.length - 1 ? STAGES[i + 1]! : null
}

export type AssociationType = 'doc' | 'conversation' | 'service' | 'worktree' | 'run' | 'artifact'

export const ASSOCIATION_LABELS: Record<AssociationType, string> = {
  doc: '文档',
  conversation: '对话',
  service: '服务',
  worktree: '工作树',
  run: '执行',
  artifact: '产物',
}

export const ASSOCIATION_ICONS: Record<AssociationType, string> = {
  doc: '📄',
  conversation: '💬',
  service: '🧩',
  worktree: '🌿',
  run: '▶',
  artifact: '📦',
}

export type SummarySource = 'model' | 'manual' | 'fallback'

export interface SummaryPayload {
  text: string
  generatedBy: SummarySource
  source?: string
  at: number
}

export interface GateGap {
  key: string
  label: string
  action?: string
}

export type RunDotState = 'idle' | 'running' | 'queued' | 'merged' | 'done'

export interface BadgeCounts {
  docs: number
  conversations: number
  services: number
}

/**
 * The 第 ③ 列 「▶ 发起执行」 capability of one card (design D1). `available` is
 * the only gate the card renders on; `reason` is the Chinese hint shown when it
 * is false. `installed` is the `checkAgents()` install list the dialog's
 * 按场景自适应 rule resolves against — it never leaves the page.
 */
export interface CardStartRunPayload {
  available: boolean
  reason: string | null
  projectGroup: string | null
  installed: string[]
}

export interface BoardCardPayload {
  id: string
  title: string
  stage: Stage
  stageLabel: string
  repo: string
  projectGroup: string | null
  repoScope: { baseRepo?: string; projectGroup?: string; repoPath?: string }
  module: string | null
  conflictDomain: string
  summary: SummaryPayload | null
  badges: BadgeCounts
  runState: RunDotState
  runStateLabel: string
  runCount: number
  queueingReason: string | null
  startRun: CardStartRunPayload
  createdAt: number
  updatedAt: number
}

export interface ColumnPayload {
  stage: Stage
  label: string
  count: number
}

export interface WipDomainPayload {
  key: string
  repo: string
  module: string | null
  running: number
  limit: number | null
  itemIds: string[]
}

export interface WipPayload {
  source: 'service' | 'derived'
  policy: { moduleLimit?: number; repoFallbackLimit?: number } | null
  domains: WipDomainPayload[]
}

export interface ConfigPayload {
  mountPath: string
  dashboardMount: string
  diffMount: string
  workbenchMount: string
  pollMs: number
  streamUrlTemplate: string
  services: { board: boolean; orchestrator: boolean; artifacts: boolean; topology: boolean }
}

export type JumpKind = 'workbench-doc' | 'tolaria-note' | 'diff' | 'artifact' | 'dashboard' | 'none'

export interface ResolvedAssociationPayload {
  type: AssociationType
  refId: string
  label: string
  at: number
  kind: JumpKind
  href: string | null
  dangling: boolean
}

export interface CardRunPayload {
  taskId: string
  startedAt: number
  terminal: string | null
  state: RunDotState
  stateLabel: string
  statusText: string | null
  prompt: string | null
  projectGroup: string | null
  agents: Record<string, { state: string; attempts: number; conflictingFiles: string[] }>
  conflicts: Array<{ agent: string; path: string; href: string }>
  merged: boolean
  mergedAt: number | null
  mergedFiles: string[]
  serviceCandidates: Array<{ refId: string; label: string; reason: string }>
}

export interface ApprovalPayload {
  approvalId: string
  op: string
  scope: string
  source?: string
  requestedAt?: number
  expiresAt?: number
}

export interface ItemsPayload {
  serverTime: number
  items: BoardCardPayload[]
  itemCount: number
  columns: ColumnPayload[]
  repos: string[]
  wip: WipPayload
  config: ConfigPayload
}

export interface ItemDetailPayload {
  ok: boolean
  item: BoardCardPayload
  nextStage: Stage | null
  nextStageLabel: string | null
  gate: { to: Stage | null; ok: boolean; gaps: GateGap[]; queueingReason?: string }
  associations: ResolvedAssociationPayload[]
  services: ConfigPayload['services']
}

export interface RunsPayload {
  ok: boolean
  itemId: string
  runs: CardRunPayload[]
  approvals: ApprovalPayload[]
  historyAvailable: boolean
  streamUrlTemplate: string
  pollMs: number
  /** Where conflict jump-offs point (configurable dashboard-side mount). */
  diffMount: string
}

export interface AdvancePayload {
  ok: boolean
  from: Stage
  to: Stage | null
  moved: boolean
  item?: BoardCardPayload
  gaps: GateGap[]
  queueingReason?: string
}

/**
 * Answer of `POST api/item/:id/run` (change `enable-card-start-run`). It starts
 * an existing `runParallelTask` and NOTHING else: no stage/association write,
 * no lifecycle operation — hence a refusal is a displayable `ok:false + reason`
 * (HTTP 200), exactly like a gate/WIP refusal.
 */
export interface StartRunPayload {
  ok: boolean
  taskId?: string
  reason?: string
  prompt?: string
  agents?: string[]
  projectGroupId?: string
  cascade?: boolean
  /** 是否已把该 run 关联回卡片(runs[] 会显示它)。 */
  linked?: boolean
  /** 关联失败原因:run 已起跑,不回滚,如实告知以便稍后重关联。 */
  linkError?: string
}

export interface BoardEventPayload {
  seq?: number
  ts?: number
  itemId?: string
  from?: string
  to?: string
  actor?: string
  kind?: string
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// fetch layer
// ---------------------------------------------------------------------------

/**
 * Derives the mount prefix from the current location. `/helmsman-board/` and
 * `/helmsman-board/index.html` both yield `/helmsman-board`; anything
 * unexpected falls back to the documented default.
 */
export function apiBase(pathname: string = typeof window === 'undefined' ? '' : window.location.pathname): string {
  const trimmed = pathname.replace(/\/(index\.html)?$/, '')
  return trimmed === '' || trimmed === '/' ? '/helmsman-board' : trimmed
}

function base(): string {
  return `${apiBase()}/api`
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base()}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  const ct = res.headers.get('content-type') ?? ''
  if (!ct.includes('application/json')) {
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.text()) as unknown as T
  }
  const data = (await res.json()) as T & { error?: string }
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data
}

export const api = {
  config: () => request<ConfigPayload>('/config'),
  listItems: (query: { repo?: string; stage?: string } = {}) => request<ItemsPayload>(`/items${qs(query)}`),
  getItem: (id: string) => request<ItemDetailPayload>(`/item/${encodeURIComponent(id)}`),
  createItem: (body: {
    title: string
    repoScope: { baseRepo?: string; projectGroup?: string }
    stage?: Stage
    module?: string
    conversation?: { type: 'dsh' | 'claude' | 'codex'; sessionId: string; transcriptPath?: string }
    docPreset?: boolean
    summaryText?: string
  }) => request<{ ok: boolean; item: BoardCardPayload }>('/item', { method: 'POST', body: JSON.stringify(body) }),
  updateItem: (id: string, patch: { title?: string; summary?: { text: string }; module?: string; specFinalized?: boolean }) =>
    request<{ ok: boolean; item: BoardCardPayload }>(`/item/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  advance: (id: string, body: { to?: Stage; allowSkip?: boolean }) =>
    request<AdvancePayload>(`/item/${encodeURIComponent(id)}/advance`, { method: 'POST', body: JSON.stringify(body) }),
  /**
   * 第 ③ 列「▶ 发起执行」→ the existing `runParallelTask` (via the board router).
   * Only these three fields travel; the project group comes from the card.
   */
  startRun: (id: string, body: { prompt: string; agents: string[]; cascade: boolean }) =>
    request<StartRunPayload>(`/item/${encodeURIComponent(id)}/run`, { method: 'POST', body: JSON.stringify(body) }),
  gate: (id: string, to?: Stage) =>
    request<{ ok: boolean; from: Stage; to: Stage | null; gaps: GateGap[]; queueingReason?: string; terminal?: boolean }>(
      `/item/${encodeURIComponent(id)}/gate${to ? `?to=${encodeURIComponent(to)}` : ''}`,
    ),
  associate: (id: string, body: { type: AssociationType; refId: string; label?: string }) =>
    request<{ ok: boolean; item: BoardCardPayload }>(`/item/${encodeURIComponent(id)}/associate`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  disassociate: (id: string, type: AssociationType, refId: string) =>
    request<{ ok: boolean; item: BoardCardPayload }>(
      `/item/${encodeURIComponent(id)}/associate?type=${encodeURIComponent(type)}&refId=${encodeURIComponent(refId)}`,
      { method: 'DELETE' },
    ),
  wip: () => request<WipPayload>('/board/wip'),
  boardEvents: (query: { itemId?: string; kind?: string; limit?: number } = {}) =>
    request<{ events: BoardEventPayload[]; available: boolean }>(`/board/events${qs(query)}`),
  getRuns: (id: string) => request<RunsPayload>(`/item/${encodeURIComponent(id)}/runs`),
  // Polling fallback for the run timeline (used when SSE is unavailable).
  getRunEvents: (taskId: string, after: number) =>
    request<{ task: { id: string; status: string; prompt: string | null } | null; events: ClientExecutionEvent[]; pruned: boolean; after: number; nextCursor: number }>(
      `/run/${encodeURIComponent(taskId)}/events?after=${after}`,
    ),
}

function qs(query: Record<string, string | number | undefined> = {}): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === '') continue
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
  }
  return parts.length > 0 ? `?${parts.join('&')}` : ''
}

/**
 * Resolves the change-A SSE address from the configured template
 * (`${dashboardMount}/api/task/{taskId}/stream`, design 决策 D6). The mount is
 * reportable/configurable, so a moved dashboard degrades to polling rather
 * than silently breaking.
 */
export function runStreamUrl(template: string, taskId: string): string {
  const resolved = template.includes('{taskId}')
    ? template.replace('{taskId}', encodeURIComponent(taskId))
    : `${template.replace(/\/+$/, '')}/${encodeURIComponent(taskId)}/stream`
  return resolved.startsWith('/') ? resolved : `/${resolved}`
}

// ---------------------------------------------------------------------------
// run timeline SSE (cursor-based manual reconnect)
//
// Copied ~60 lines from `ui-dashboard/src/client/api.ts#subscribeTaskStream`
// (design D6: the source of truth). Duplicated on purpose — a shared runtime
// package would introduce a cross-plugin runtime dependency, which the repo's
// "type-import only" convention forbids. Keep the two copies in sync.
// ---------------------------------------------------------------------------

export interface RunStreamHandlers {
  /** Every durable timeline event, in seq order. */
  onEvent(event: ClientExecutionEvent): void
  /** The server reported `history-pruned` — history before the cursor is gone. */
  onPruned(): void
  onStatus?(status: RunStreamStatus): void
  /** Return true to stop the stream after this event (default: terminal). */
  shouldStop?(event: ClientExecutionEvent): boolean
}

export interface RunStreamHandle {
  readonly active: boolean
  close(): void
}

/** Injectable transport/timings (tests drive deterministic reconnects). */
export interface RunStreamOptions {
  eventSource?: new (url: string) => EventSource
  minReconnectMs?: number
  maxReconnectMs?: number
}

export function subscribeRunStream(
  url: string,
  after: number,
  handlers: RunStreamHandlers,
  opts: RunStreamOptions = {},
): RunStreamHandle {
  const ES = opts.eventSource ?? (typeof EventSource !== 'undefined' ? EventSource : undefined)
  const minReconnect = opts.minReconnectMs ?? 500
  const maxReconnect = opts.maxReconnectMs ?? 8_000
  const shouldStop = handlers.shouldStop ?? isTerminalEvent

  let stopped = false
  let current: EventSource | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastSeq = after
  let attempt = 0
  const prunedListeners = new WeakMap<EventSource, EventListener>()

  if (!ES) {
    handlers.onStatus?.('closed')
    return { get active() { return false }, close: () => undefined }
  }

  function stop(status: RunStreamStatus = 'closed'): void {
    if (stopped) return
    stopped = true
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (current) {
      detach(current)
      try {
        current.close()
      } catch {
        // already closed
      }
      current = null
    }
    handlers.onStatus?.(status)
  }

  function detach(es: EventSource): void {
    es.onopen = null
    es.onerror = null
    es.onmessage = null
    const onPruned = prunedListeners.get(es)
    if (onPruned) {
      es.removeEventListener('history-pruned', onPruned)
      prunedListeners.delete(es)
    }
  }

  const scheduleReconnect = (): void => {
    if (stopped) return
    attempt += 1
    const delay = Math.min(maxReconnect, minReconnect * 2 ** (attempt - 1))
    handlers.onStatus?.('reconnecting')
    timer = setTimeout(() => {
      timer = null
      open()
    }, delay)
  }

  function open(): void {
    if (stopped) return
    handlers.onStatus?.(current == null ? 'connecting' : 'reconnecting')
    const target = `${url}${url.includes('?') ? '&' : '?'}after=${lastSeq}`
    let es: EventSource
    try {
      es = new ES!(target)
    } catch {
      scheduleReconnect()
      return
    }
    current = es
    es.onopen = () => {
      if (stopped) return
      attempt = 0
      handlers.onStatus?.('open')
    }
    es.onerror = () => {
      if (stopped || current !== es) return
      try {
        es.close()
      } catch {
        // already closed
      }
      current = null
      scheduleReconnect()
    }
    es.onmessage = (msg: MessageEvent) => {
      if (stopped) return
      const event = parseExecutionEvent(String(msg.data ?? ''))
      if (!event) return
      if (event.seq > lastSeq) lastSeq = event.seq
      handlers.onEvent(event)
      if (shouldStop(event)) stop()
    }
    const onPruned: EventListener = () => handlers.onPruned()
    prunedListeners.set(es, onPruned)
    es.addEventListener('history-pruned', onPruned)
  }

  open()
  return {
    get active() {
      return !stopped
    },
    close: () => stop(),
  }
}
