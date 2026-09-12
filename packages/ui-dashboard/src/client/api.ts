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
   * 而未细分接口的服务级边。`source` 是边的来源标记：`'declared'`（仓库声明/
   * 手工录入，缺省值）或 `'derived'`（推导后人工确认）——重新抓取只调和声明边。
   */
  restDependencies: Record<string, Array<{ toServiceId: string; endpoints: string[]; method: string; critical?: boolean; source?: 'declared' | 'derived' }>>
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

/** 候选证据（推导候选区块展示用）。 */
export interface DeriveEvidencePayload {
  /** config / feign / call / endpoint */
  kind: string
  file: string
  line?: number
  detail: string
  /** 降级标注：「值未解析」「前缀未解析」「按路径后缀匹配」等。 */
  note?: string
}

/** 一条推导候选（memory-topology 的 DependencyCandidate 镜像）。 */
export interface DeriveCandidatePayload {
  from: string
  to: string
  confidence: 'high' | 'medium'
  evidence: DeriveEvidencePayload[]
  endpoints: string[]
  method?: string
  /** false = 目标未登记（可「登记并确认」）。 */
  targetDeclared: boolean
  /** true = 该对服务已有依赖边（确认只并入明细）。 */
  alreadyDeclared?: boolean
  /** true = 确认会与既有图成环（默认不勾选）。 */
  wouldCreateCycle: boolean
}

export interface DeriveOutcomePayload {
  candidates: DeriveCandidatePayload[]
  scannedAt: number
  scanned?: string[]
  skipped?: Array<{ serviceId: string; reason: string }>
}

export type TopologyDerivePayload = {
  group: string
  result: DeriveOutcomePayload | null
  /** 老版本拓扑服务无该能力时为 false。 */
  available: boolean
}

export interface ApplyCandidatesPayload {
  group: string
  applied: number
  registered: string[]
  topology: TopologyPayload | null
  available: boolean
}

/** 确认载荷（只送拓扑服务需要的最小字段）。 */
export interface ApplyCandidateInputPayload {
  from: string
  to: string
  endpoints?: string[]
  method?: string
  register?: boolean
}

export interface ImportPreviewPayload {
  source: string
  services: Array<{ name: string; image?: string; selected: boolean; endpoints: ApiEndpointPayload[] }>
  dependencies: Array<{ from: string; to: string; method: string; endpoints: string[]; critical?: boolean }>
  warnings: string[]
  /** 仅声明文件导入（`helmsman-declaration`）：文件声明的是哪个服务。 */
  declaration?: { service: string; file?: string }
  /** 仅声明文件导入：文件引用但项目群尚未登记的目标（预览中标为「目标未登记」）。 */
  undeclaredTargets?: string[]
}

/** 声明文件抓取结果（`GET api/topology/declaration`）。 */
export interface DeclarationPayload {
  group: string
  service: string
  /** 声明文件绝对路径；服务未配置 localPath 时为 null。 */
  file: string | null
  /**
   * `ok` 已读取并解析；`missing` 仓库无该文件（「未声明依赖」，非错误）；
   * `invalid` 文件存在但解析失败（`errors` 列出问题，未应用任何边）；
   * `no-repo-path` 服务未配置本地路径；`unavailable` 拓扑服务版本过旧。
   */
  status: 'ok' | 'missing' | 'invalid' | 'no-repo-path' | 'unavailable'
  /** 既有 ImportPreview 形状；仅 `status === 'ok'` 时非空。 */
  preview: ImportPreviewPayload | null
  errors: string[]
  warnings: string[]
  undeclaredTargets: string[]
  available: boolean
}

/** 声明文件回写内容（`GET api/topology/declaration/render`）。 */
export interface DeclarationRenderPayload {
  group: string
  service: string
  file: string | null
  content: string
  /** 写入的 `declared` 边数。 */
  declared: number
  /** 刻意不写入的 `derived` 边数。 */
  derived: number
  hint: string
  available: boolean
}

/** 一条漂移条目（memory-topology 的 drift 条目镜像）。 */
export interface DriftEntryPayload {
  from: string
  to: string
  /** 代码侧证据；`staleDeclared` 条目按定义为空（正是「未找到证据」）。 */
  evidence: DeriveEvidencePayload[]
  endpoints: string[]
  method?: string
  /** 代码侧置信度；`staleDeclared` 无代码证据时缺省。 */
  confidence?: 'high' | 'medium'
  /** false = 目标未登记（与既有候选呈现一致）。 */
  targetDeclared: boolean
  /** 声明侧的形状（「是否已声明」以声明文件为准）；未声明时为 null。 */
  declared: { method: string; endpoints: string[] } | null
  /** 仅 staleDeclared：措辞为「未在代码中找到证据」，不是「不存在」。 */
  reason?: string
  /** 仅 staleDeclared：静态扫描的局限说明（原样展示，不软化）。 */
  caveat?: string
  /** 仅 staleDeclared：人工处置建议（工具不代改声明文件）。 */
  action?: string
  /** 仅 mediumConfidence：为何路径档不计入判定。 */
  tierNote?: string
}

/** 漂移核对结果（`GET api/topology/drift`）。 */
export interface DeclarationDriftPayload {
  group: string
  service: string
  /**
   * `ok` 已比对；`no-declaration` 该服务尚无声明文件（引导态，**非错误**，全部代码证据
   * 均未经声明）；`invalid-declaration` 声明文件解析失败（未做比对，`errors` 列出问题）；
   * `no-repo-path` 服务未配置本地路径；`unavailable` 拓扑服务版本过旧。
   */
  status: 'ok' | 'no-declaration' | 'invalid-declaration' | 'no-repo-path' | 'unavailable'
  file: string | null
  consistent: DriftEntryPayload[]
  staleDeclared: DriftEntryPayload[]
  undeclared: DriftEntryPayload[]
  /** 中置信（路径档）单列：只作参考，**不计入** `undeclared` 判定。 */
  mediumConfidence: DriftEntryPayload[]
  counts: {
    /** 声明文件列出的服务对数。 */
    declared: number
    /** 代码侧扫到证据的服务对数（不限档位）。 */
    codeEvidence: number
    consistent: number
    staleDeclared: number
    undeclared: number
    mediumConfidence: number
    /** `staleDeclared + undeclared`：两侧不一致的服务对数。 */
    drift: number
  }
  /** true = 已产出判定且发现漂移（告警条的显示条件）。 */
  hasDrift: boolean
  message: string
  errors: string[]
  scanned: string[]
  skipped: Array<{ serviceId: string; reason: string }>
  scannedAt: number
  available: boolean
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
  /** 只读推导候选（出站调用 + 配置线索）；不写库，老版本服务返回 available=false。 */
  topologyDerive: (group: string) => request<TopologyDerivePayload>(`/topology/derive?group=${encodeURIComponent(group)}`),
  /**
   * 确认候选落库：服务端复用 `mergeDependencyEdge` 的按服务对合并语义，
   * 所以确认同一对服务不会造出重复行。返回落库后的整份拓扑以便即时刷新依赖行。
   * 拓扑服务版本过旧（无该能力）时抛出明确错误，而不是静默不写。
   */
  applyCandidates: async (group: string, candidates: ApplyCandidateInputPayload[]): Promise<ApplyCandidatesPayload> => {
    const res = await request<ApplyCandidatesPayload>('/topology/apply-candidates', {
      method: 'POST',
      body: JSON.stringify({ group, candidates }),
    })
    if (res.available === false) throw new Error('当前拓扑服务版本不支持候选推导，请在「目标未登记」类候选上手工录入依赖')
    return res
  },
  createGroup: (group: string, name?: string) => request<{ topology: TopologyPayload }>('/topology/create', { method: 'POST', body: JSON.stringify({ group, name }) }),
  deleteGroup: (group: string, confirmationToken?: string) =>
    request<{ ok: boolean }>('/topology/delete', { method: 'POST', body: JSON.stringify({ group, confirmationToken }) }),
  scanApi: (localPath: string) => request<{ total: number; endpoints: ApiEndpointPayload[] }>('/topology/scan-api', { method: 'POST', body: JSON.stringify({ localPath }) }),
  importPreview: (source: string, text: string, inferDeps: boolean) =>
    request<ImportPreviewPayload>('/topology/import-preview', { method: 'POST', body: JSON.stringify({ source, text, inferDeps }) }),
  importApply: (group: string, preview: ImportPreviewPayload) =>
    request<{ topology: TopologyPayload }>('/topology/import-apply', { method: 'POST', body: JSON.stringify({ group, preview }) }),
  /**
   * 抓取仓库自身声明的依赖（`<repo>/.helmsman/dependencies.yml`）。只读：
   * 返回既有 ImportPreview 形状交给现有预览对话框核对，确认后才走 importApply。
   * 文件缺失是明确的「未声明依赖」结果（status 'missing'），不是错误。
   */
  topologyDeclaration: (group: string, service?: string) =>
    request<DeclarationPayload>(
      `/topology/declaration?group=${encodeURIComponent(group)}${service ? `&service=${encodeURIComponent(service)}` : ''}`,
    ),
  /** 回写草稿：只含 `declared` 边 + 目标路径 + 「建议提交到仓库」提示；不执行任何 git 操作。 */
  topologyDeclarationRender: (group: string, service: string) =>
    request<DeclarationRenderPayload>(`/topology/declaration/render?group=${encodeURIComponent(group)}&service=${encodeURIComponent(service)}`),
  /**
   * 只读漂移核对：把该服务仓库里的声明文件与代码扫描出的候选做双向比对
   * （一致 / 陈旧声明 / 未声明 + 中置信单列）。**不写声明文件、不改依赖图**；
   * 「未声明的处理」进入既有「🔍 推导候选」确认流程。老版本服务返回 `available: false`。
   */
  topologyDrift: (group: string, service?: string) =>
    request<DeclarationDriftPayload>(
      `/topology/drift?group=${encodeURIComponent(group)}${service ? `&service=${encodeURIComponent(service)}` : ''}`,
    ),
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
