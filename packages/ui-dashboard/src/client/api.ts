/** Client-side API layer + shared types (mirror of server payloads). */
import { isTerminalEvent, parseExecutionEvent, type ClientExecutionEvent, type TaskStreamStatus } from './event'

export type TaskStatus = 'CREATING_WORKTREES' | 'RUNNING' | 'AGGREGATING' | 'COMPLETED' | 'PARTIAL_FAILED' | 'ALL_FAILED' | 'CANCELLED'
export type AgentRunState = 'idle' | 'running' | 'completed' | 'failed' | 'timeout' | 'rate-limited' | 'auth-failed' | 'cancelled'

export interface AgentStatePayload {
  installed: boolean
  version?: string
}

export interface AgentRunPayload {
  state: AgentRunState
  attempts: number
  startedAt: string | number | null
  endedAt: string | number | null
  exitCode: number | null
  error: string | null
  stats: { files: number; additions: number; deletions: number } | null
  conflictingFiles: string[]
  hasDiff: boolean
}

export interface TaskPayload {
  id: string
  prompt: string
  status: TaskStatus
  projectGroupId: string | null
  cascade: boolean
  timeoutSec: number
  createdAt: number
  endedAt: number | null
  /** True when the task was restored after a host restart without finishing. */
  interrupted?: boolean
  agents: Record<string, AgentRunPayload>
}

export interface UsagePayload {
  runs: number
  promptChars: number
  outputChars: number
  estimatedTokens: number
}

export interface StatePayload {
  serverTime: number
  groups: string[]
  agents: Record<string, AgentStatePayload>
  tasks: TaskPayload[]
  usage: Record<string, UsagePayload>
}

export interface ApiEndpointPayload {
  method: string
  path: string
  handler?: string
  description?: string
}

export interface TopologyPayload {
  projectGroupId: string
  name: string
  description: string
  defaultBranch: string
  projects: Record<string, { name: string; repoUrl: string; localPath: string; type: string }>
  services: Record<string, {
    name: string
    projectId: string
    techStack: string[]
    apiEndpoints: ApiEndpointPayload[]
    localPath?: string
  }>
  mavenParents: Record<string, { pomPath: string; managedDependencies: Record<string, string>; children: string[] }>
  /**
   * 服务间依赖，键为调用方服务 id。同一对服务只有一条边（服务端保存路径按
   * (from, to) 去重），`endpoints: []` + `method: '*'` 表示只声明了「A 调用 B」
   * 而未细分接口的服务级边。
   */
  restDependencies: Record<string, Array<{ toServiceId: string; endpoints: string[]; method: string; critical?: boolean }>>
}

/** 服务级边的规范 method（与 memory-topology 的 SERVICE_LEVEL_METHOD 一致）。 */
export const SERVICE_LEVEL_METHOD = '*'

/** Mirror of memory-topology's GraphHealth (只读体检结果). */
export interface GraphHealthPayload {
  cyclic: boolean
  cycles: string[][]
  dangling: Array<{ from: string; to: string }>
  isolated: string[]
}

export type TopologyHealthPayload = { group: string; health: GraphHealthPayload | null; available: boolean }

export interface ImportPreviewPayload {
  source: string
  services: Array<{ name: string; image?: string; selected: boolean; endpoints: ApiEndpointPayload[] }>
  dependencies: Array<{ from: string; to: string; method: string; endpoints: string[] }>
  warnings: string[]
}

const BASE = '/helmsman-dashboard/api'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
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
  getState: () => request<StatePayload>('/state'),
  runTask: (body: { prompt: string; agents: string[]; projectGroupId?: string; cascade?: boolean; timeoutSec?: number }) =>
    request<{ taskId: string }>('/task', { method: 'POST', body: JSON.stringify(body) }),
  cancelTask: (taskId: string, confirmationToken?: string) =>
    request<{ ok: boolean }>(`/task/${encodeURIComponent(taskId)}/cancel`, { method: 'POST', body: JSON.stringify({ confirmationToken }) }),
  retryTask: (taskId: string, agents?: string[]) =>
    request<{ taskId: string }>(`/task/${encodeURIComponent(taskId)}/retry`, { method: 'POST', body: JSON.stringify({ agents }) }),
  getLog: (taskId: string, agent: string) =>
    request<{ agent: string; log: string; state: AgentRunState | null }>(`/task/${encodeURIComponent(taskId)}/log?agent=${encodeURIComponent(agent)}`),
  merge: (taskId: string, body: { agents?: string[]; files?: string[]; discardAfterMerge?: boolean; confirmationToken?: string; resolutions?: Record<string, ClientMergeResolution> }) =>
    request<{ taskId: string; results: Array<{ agent: string; ok: boolean; committed: boolean; message: string; conflictFiles: string[] }> }>(
      `/task/${encodeURIComponent(taskId)}/merge`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  discard: (taskId: string, confirmationToken?: string) =>
    request<{ ok: boolean }>(`/task/${encodeURIComponent(taskId)}/discard`, { method: 'POST', body: JSON.stringify({ confirmationToken }) }),
  loadTopology: (group: string) => request<{ group: string; topology: TopologyPayload | null }>(`/topology?group=${encodeURIComponent(group)}`),
  saveTopology: (topology: TopologyPayload) => request<{ ok: boolean }>('/topology/save', { method: 'POST', body: JSON.stringify({ topology }) }),
  /** 只读图体检（环/悬空引用/孤立服务）；老版本服务无该能力时 available=false。 */
  topologyHealth: (group: string) => request<TopologyHealthPayload>(`/topology/health?group=${encodeURIComponent(group)}`),
  createGroup: (group: string, name?: string) => request<{ topology: TopologyPayload }>('/topology/create', { method: 'POST', body: JSON.stringify({ group, name }) }),
  deleteGroup: (group: string, confirmationToken?: string) =>
    request<{ ok: boolean }>('/topology/delete', { method: 'POST', body: JSON.stringify({ group, confirmationToken }) }),
  scanApi: (localPath: string) => request<{ total: number; endpoints: ApiEndpointPayload[] }>('/topology/scan-api', { method: 'POST', body: JSON.stringify({ localPath }) }),
  importPreview: (source: string, text: string, inferDeps: boolean) =>
    request<ImportPreviewPayload>('/topology/import-preview', { method: 'POST', body: JSON.stringify({ source, text, inferDeps }) }),
  importApply: (group: string, preview: ImportPreviewPayload) =>
    request<{ topology: TopologyPayload }>('/topology/import-apply', { method: 'POST', body: JSON.stringify({ group, preview }) }),
  exportYaml: (group: string) => request<TopologyExportResult>(`/topology/export?group=${encodeURIComponent(group)}`),
  listArtifacts: () => request<{ artifacts: ArtifactMetaPayload[]; available: boolean }>('/artifacts'),
  /** Packages a terminal task's per-agent diffs and registers the bundle. */
  buildTaskBundle: (taskId: string) =>
    request<TaskBundlePayload>(`/task/${encodeURIComponent(taskId)}/bundle`, { method: 'POST', body: JSON.stringify({}) }),
  // ---- approval gate + audit trail (client mirror of the REST surface) ----
  approvalPolicy: (op: string) =>
    request<{ op: string; mode: 'confirm-required' | 'auto-grant'; confirmRequired: boolean }>(`/approvals/policy?op=${encodeURIComponent(op)}`),
  requestApproval: (body: { op: string; taskId?: string; group?: string }) =>
    request<{ approvalId: string; op: string; scope: string; source: string; requestedAt: number; expiresAt: number }>('/approvals', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  decideApproval: (approvalId: string, approve: boolean) =>
    request<{ granted: true; token: string; expiresAt: number } | { granted: false; reason: 'denied' | 'not-found' }>(
      `/approvals/${encodeURIComponent(approvalId)}/decision`,
      { method: 'POST', body: JSON.stringify({ approve }) },
    ),
  listPendingApprovals: () =>
    request<{ approvals: Array<{ approvalId: string; op: string; scope: string; source: string; requestedAt: number; expiresAt: number }> }>('/approvals/pending'),
  audit: (query?: { op?: string; taskId?: string }) => request<{ entries: AuditEntryPayload[] }>(`/audit?${qs(query)}`),
}

export type ClientMergeResolution =
  | { kind: 'agent'; agent: string }
  | { kind: 'manual' }
  | { kind: 'skip' }

export interface AuditEntryPayload {
  v: number
  ts: number
  type: 'decision' | 'run-completion'
  operation: string
  scope: string
  source?: string
  decision?: string
  reason?: string
  taskId?: string
  outcome?: string
  detail?: Record<string, unknown>
}

// ---- delivery artifacts (mirror of ArtifactMeta) ----

export interface ArtifactMetaPayload {
  id: string
  type: string
  fileName: string
  mime: string
  size: number
  createdAt: string
  meta: Record<string, unknown>
  producers: string[]
}

/** `GET /topology/export` now registers the YAML and serves it via the artifact
 * endpoint (`.yaml` naming fix). Without the registry it streams the file
 * directly, which the client reads back as plain text (legacy path). */
export type TopologyExportResult =
  | { artifactId: string; fileName: string; group: string; mime: string; duplicate: boolean }
  | string

export interface TaskBundlePayload {
  taskId: string
  status: string
  patch: { id: string; fileName: string; duplicate: boolean }
  bundle: { id: string; fileName: string; duplicate: boolean }
}

/** Direct URL to a registered artifact (server sends attachment headers). */
export function artifactUrl(id: string): string {
  return `${BASE}/artifacts/${encodeURIComponent(id)}`
}

function qs(query: { op?: string; taskId?: string } = {}): string {
  const parts: string[] = []
  if (query.op) parts.push(`op=${encodeURIComponent(query.op)}`)
  if (query.taskId) parts.push(`taskId=${encodeURIComponent(query.taskId)}`)
  return parts.join('&')
}

export const AGENTS = ['claude', 'codex', 'pi', 'oh-my-pi'] as const
export const AGENT_LABELS: Record<string, string> = { claude: 'Claude', codex: 'Codex', pi: 'Pi', 'oh-my-pi': 'oh-my-pi' }
export const USAGE_QUOTA = 5000

// ---------------------------------------------------------------------------
// task SSE stream (cursor-based manual reconnect, D5)
// ---------------------------------------------------------------------------

export interface TaskStreamHandlers {
  /** Every durable timeline event, in seq order. */
  onEvent(event: ClientExecutionEvent): void
  /** The server reported `history-pruned` — history before the cursor is gone. */
  onPruned(): void
  onStatus?(status: TaskStreamStatus): void
  /** Return true to stop the stream after this event (default: terminal). */
  shouldStop?(event: ClientExecutionEvent): boolean
}

export interface TaskStreamHandle {
  readonly active: boolean
  close(): void
}

export function subscribeTaskStream(
  taskId: string,
  after: number,
  handlers: TaskStreamHandlers,
  opts: {
    baseUrl?: string
    eventSource?: new (url: string) => EventSource
    minReconnectMs?: number
    maxReconnectMs?: number
  } = {},
): TaskStreamHandle {
  const base = opts.baseUrl ?? `${BASE}/task/${encodeURIComponent(taskId)}/stream`
  const ES = opts.eventSource ?? EventSource
  const minReconnect = opts.minReconnectMs ?? 500
  const maxReconnect = opts.maxReconnectMs ?? 8_000
  const shouldStop = handlers.shouldStop ?? isTerminalEvent

  let stopped = false
  let current: EventSource | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastSeq = after
  let attempt = 0
  const prunedListeners = new WeakMap<EventSource, EventListener>()

  const stop = (status: TaskStreamStatus = 'closed'): void => {
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

  const open = (): void => {
    if (stopped) return
    handlers.onStatus?.(current == null ? 'connecting' : 'reconnecting')
    const url = `${base}?after=${lastSeq}`
    let es: EventSource
    try {
      es = new ES(url)
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
