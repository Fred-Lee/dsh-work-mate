/**
 * Board REST API — a thin JSON façade over the EXTERNAL `@helmsman/board`
 * service (change `add-task-workitem-model`) plus read-only run/artifact reads.
 *
 * The board plugin is authored by a sibling change, so this package consumes it
 * through a STRUCTURAL interface (`BoardServiceLike`) and NEVER imports a
 * sibling plugin implementation at runtime — the established convention in this
 * repo (`ArtifactRegisterLike` in ui-workbench, `TopologyServiceLike` in
 * ui-dashboard). `orchestrator` / `artifacts` / `topology` are OPTIONAL lazy
 * resolvers: the page still renders without them, minus the run panel /
 * artifact jump-offs (design D1).
 *
 * Invariant enforced here (spec task-kanban "推进门交互" + "阶段迁移留痕"): the
 * REST layer NEVER writes `stage` itself. Every stage change goes through
 * `board.advance()`, so gate and WIP refusals come back as `gaps` /
 * `queueingReason` the UI displays, and the card does not move. A refusal is
 * answered with HTTP 200 + `ok:false` (it is a normal outcome, not an error);
 * only unknown ids (404) and malformed bodies (400) are non-200.
 *
 * Change `enable-card-start-run` adds one WRITE path — `POST api/item/:id/run`
 * — and it writes nothing but an orchestrator task: it delegates to the
 * EXISTING `OrchestratorService.runParallelTask({prompt, agents,
 * projectGroupId, cascade})` and returns the `taskId`. The card does not move,
 * no topology/declaration/ignore/board file is touched (spec card-start-run
 * 「不修改任何既有数据」) and WIP is NOT consulted, because a saturated conflict
 * domain gates ENTERING the dev column, not adding another run inside it
 * (spec 「WIP 不拦列内追加 run」). Cancel / retry / approval / merge stay in the
 * execution dashboard (design D4): this route never calls them.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readJsonBody, Router, sendJson } from './http.ts'

// ---------------------------------------------------------------------------
// Stage model (spec task-workitem: 四阶段为有序枚举 + 单步推进)
// ---------------------------------------------------------------------------

export const STAGES = ['requirements', 'spec', 'dev', 'done'] as const
export type Stage = (typeof STAGES)[number]

/** Chinese display names — the product's UI copy (identifiers stay English). */
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

/** Next stage in the ordered pipeline, or null when already at the end. */
export function nextStage(stage: Stage): Stage | null {
  const i = stageIndex(stage)
  return i >= 0 && i < STAGES.length - 1 ? STAGES[i + 1]! : null
}

function parseStage(value: unknown): Stage | null {
  return isStage(value) ? value : null
}

// ---------------------------------------------------------------------------
// Structural shapes of the consumed services (no runtime sibling imports)
// ---------------------------------------------------------------------------

export type AssociationType = 'doc' | 'conversation' | 'service' | 'worktree' | 'run' | 'artifact'

export const ASSOCIATION_TYPES: readonly AssociationType[] = ['doc', 'conversation', 'service', 'worktree', 'run', 'artifact']

export function isAssociationType(value: unknown): value is AssociationType {
  return typeof value === 'string' && (ASSOCIATION_TYPES as readonly string[]).includes(value)
}

/** Reference (never a copy) to an external object (spec task-workitem D3). */
export interface Association {
  type: AssociationType
  refId: string
  label?: string
  at: number
  /** Set by the board when the referenced target is known to be missing. */
  dangling?: boolean
}

/** Reference to one orchestrator run (`taskId` semantics unchanged). */
export interface RunRef {
  taskId: string
  startedAt: number
  /** Terminal outcome label recorded by the board (e.g. `merged`/`completed`). */
  terminal?: string | null
}

export type SummarySource = 'model' | 'manual' | 'fallback'

export interface Summary {
  text: string
  generatedBy: SummarySource
  source?: string
  at: number
}

/** One unmet entry of a stage gate; `action` is the jump-off hint for it. */
export interface GateGap {
  key: string
  label: string
  action?: string
}

export interface WorkItem {
  id: string
  title: string
  summary?: Summary | null
  repoScope?: { baseRepo?: string; projectGroup?: string; repoPath?: string }
  scope?: { module?: string }
  stage: Stage
  createdAt: number
  updatedAt: number
  associations?: Association[]
  runs?: RunRef[]
  /** Gate datum for `dev` (spec task-workitem: specFinalized). */
  specFinalized?: boolean
  /** Conflict domain of the last WIP evaluation (`repo:module` / `repo:*`). */
  conflictDomain?: string
  /** Set by the board when an advance was refused; the card greys out. */
  queueingReason?: string
  stageUpdatedAt?: number
}

export interface CreateWorkItemInput {
  title: string
  repoScope: { baseRepo?: string; projectGroup?: string; repoPath?: string }
  stage?: Stage
  scope?: { module?: string }
  /** Optional conversation to associate + summarise at creation time (D7b). */
  conversation?: { type: 'dsh' | 'claude' | 'codex'; sessionId: string; transcriptPath?: string }
  /** Board/host-side "run the PRD/research preset first" switch (D7a). */
  docPreset?: boolean
  /** Fallback summary text when the host cannot generate one. */
  summaryText?: string
}

export interface UpdateWorkItemInput {
  title?: string
  scope?: { module?: string }
  specFinalized?: boolean
  stage?: Stage
}

export interface AdvanceInput {
  id: string
  to?: Stage
  allowSkip?: boolean
}

export interface AdvanceOutcome {
  ok?: boolean
  item?: WorkItem
  gaps?: GateGap[]
  queueingReason?: string
  reason?: string
}

export interface GateOutcome {
  ok?: boolean
  gaps?: GateGap[]
  queueingReason?: string
}

export interface WipDomain {
  /** Conflict-domain key: `repo:module` or `repo:*`. */
  key: string
  repo?: string
  module?: string | null
  running?: number
  limit?: number | null
  itemIds?: string[]
}

export interface WipPolicy {
  moduleLimit?: number
  repoFallbackLimit?: number
}

export interface WipReport {
  policy?: WipPolicy | null
  domains?: WipDomain[]
}

export interface WipDecision {
  allowed?: boolean
  key?: string
  limit?: number | null
  running?: number
  reason?: string
  queueingReason?: string
}

/**
 * Structural surface of `@helmsman/board` consumed by the page. The method
 * names/arguments below are the contract this package assumes (see README
 * §服务契约); the board plugin is the only writer of stages, gates and WIP.
 */
export interface BoardServiceLike {
  create(input: CreateWorkItemInput): Promise<WorkItem>
  update(id: string, patch: UpdateWorkItemInput): Promise<WorkItem>
  get(id: string): Promise<WorkItem | null | undefined>
  list(query?: { stage?: Stage; repo?: string }): Promise<WorkItem[]>
  advance(input: AdvanceInput): Promise<AdvanceOutcome | WorkItem>
  gate(id: string, to?: Stage): Promise<GateOutcome | GateGap[]>
  associate(id: string, association: Association): Promise<WorkItem>
  disassociate(id: string, ref: { type: AssociationType; refId: string }): Promise<WorkItem>
  setSummary(id: string, summary: { text: string; generatedBy?: SummarySource; source?: string; at?: number }): Promise<WorkItem>
  /** Whole-board occupancy per conflict domain (drives the ③ column header). */
  wip?(): Promise<WipReport | WipDomain[] | undefined>
  /** Single-candidate WIP evaluation (optional — `advance` already enforces it). */
  evaluateWip?(input: { repo: string; module?: string; excludeId?: string }): Promise<WipDecision | undefined>
  /** Lifecycle/migration events (spec task-kanban "阶段迁移留痕"). */
  queryEvents?(query?: { itemId?: string; kind?: string; limit?: number }): Promise<unknown[]>
  /**
   * Late wiring seam for the `dev → done` archival gate. The adjudicated facts
   * live outside board, and this host is the one that can reach them, so it
   * injects the probe after both services are up (`gate()` reads it on every
   * call, so the drawer's gap list and `advance` agree).
   */
  setGateProbe?(probe: GateProbeLike | undefined): void
}

export interface TaskRunLike {
  state?: string
  attempts?: number
  startedAt?: number
  endedAt?: number
  exitCode?: number | null
  error?: string
  stats?: { files: number; additions: number; deletions: number }
  conflictingFiles?: string[]
  diffs?: Array<{ path: string; status?: string; additions?: number; deletions?: number }>
}

export interface TaskStatusLike {
  id: string
  prompt?: string
  status: string
  projectGroupId?: string
  createdAt?: number
  endedAt?: number
  interrupted?: boolean
  agents?: Record<string, TaskRunLike>
}

export interface ExecutionEventLike {
  v?: number
  seq: number
  ts: number
  taskId: string
  kind: string
  agent?: string
  payload?: Record<string, unknown>
}

/** Approval-gate surface (change `add-approval-policy-and-audit-trail`). */
export interface PendingApproval {
  approvalId: string
  op: string
  scope: string
  source?: string
  requestedAt?: number
  expiresAt?: number
}

/**
 * One adapter's CLI install state, as reported by `checkAgents()`.
 * The orchestrator owns this probe; the board only reads it.
 */
export interface AgentStatusLike {
  installed: boolean
  version?: string
}

/**
 * Parameters of the EXISTING change A/C `runParallelTask` tool. Declared in
 * full so the call this package makes is checkable against the real service
 * signature, but the kanban only ever passes
 * `{ prompt, agents, projectGroupId, cascade }` (design D3).
 */
export interface RunParallelTaskInput {
  prompt: string
  agents: string[]
  projectGroupId?: string
  repoPath?: string
  cascade?: boolean
  timeoutSec?: number
}

/**
 * The change-A surface ui-board reads (durable timeline + live tail). The
 * optional members exist on the real service and are used when present; the
 * page degrades to a single live read when they are absent.
 */
export interface OrchestratorLike {
  getTaskStatus(taskId: string): TaskStatusLike | undefined | null
  listTasks(): TaskStatusLike[]
  history: {
    getEvents(taskId: string, after: number): Promise<{ events: ExecutionEventLike[]; pruned: boolean }>
    subscribe(taskId: string, listener: (event: ExecutionEventLike) => void): () => void
    getTask?(taskId: string): Promise<TaskStatusLike | undefined>
  }
  /** Read-only approval lookups (change C presentation surface). */
  listPendingConfirmations?(): PendingApproval[]
  /**
   * Per-adapter CLI install state (`{ claude: { installed: true }, … }`) — the
   * ONLY service-discovery seam the 「▶ 发起执行」 entry uses (design D1/D2,
   * spec 「智能 agent 选择」). It takes no project-group argument: install state
   * is a machine fact, so the reachable reading of "该群已安装 agent" is the
   * group existing plus this probe reporting ≥1 installed agent.
   */
  checkAgents?(): Promise<Record<string, AgentStatusLike>>
  /**
   * The EXISTING multi-agent fan-out tool. Starting a run from the kanban goes
   * through this method and nothing else — no new pathway, and no lifecycle
   * operations (design D4: 取消/重试/审批/合并 仍留在执行看板).
   */
  runParallelTask?(params: RunParallelTaskInput): Promise<{ taskId: string }>
  /**
   * Read-only audit-journal query (change C). The board's archival gate uses it
   * to confirm a merge left a record — see `createBoardGateProbe`.
   */
  getAudit?(query?: { taskId?: string }): Promise<AuditEntryLike[]>
}

/**
 * Minimal audit-entry face the archival gate reads. Structural on purpose: the
 * real union lives in `@helmsman/orchestrator`, and ui-board carries no
 * workspace dependency (same convention as `slot-types` in ui-workbench).
 */
export interface AuditEntryLike {
  type?: string
  operation?: string
  outcome?: string
  taskId?: string
}

/**
 * Structural mirror of `@helmsman/board`'s `GateProbe`. Both members are
 * optional by contract: omitting one makes the board report that half as
 * "unconfigured" and refuse the advance rather than silently passing.
 */
export interface GateProbeLike {
  hasMergedRun?(item: { runs?: Array<{ taskId?: string }> }): boolean | Promise<boolean>
  hasAuditOnRecord?(item: { runs?: Array<{ taskId?: string }> }): boolean | Promise<boolean>
}

export interface ArtifactMetaLike {
  id: string
  type?: string
  fileName?: string
  mime?: string
  size?: number
  createdAt?: string
  meta?: Record<string, unknown>
}

/** Structural surface of `@helmsman/artifacts` (change D) — read-only here. */
export interface ArtifactLike {
  resolve(id: string): Promise<{ id: string; meta: ArtifactMetaLike; bytes: Uint8Array } | null | undefined>
  list(): Promise<ArtifactMetaLike[]>
}

/** Structural slice of `helmsman.topology` used to propose impacted services. */
export interface TopologyLike {
  loadTopology(group: string): Promise<{
    services?: Record<string, { name?: string; localPath?: string }>
  } | null>
}

export interface BoardApiDeps {
  board: BoardServiceLike
  /** Lazy OPTIONAL resolvers — resolved per request (ARCHITECTURE §4). */
  orchestrator?: () => OrchestratorLike | undefined
  artifacts?: () => ArtifactLike | undefined
  topology?: () => TopologyLike | undefined
  /** Own mount (reported by `api/config`). @default '/helmsman-board' */
  mountPath?: string
  /**
   * Where the dashboard's durable-history SSE lives. The run timeline streams
   * from `${dashboardMount}/api/task/:id/stream` (change A); this package does
   * NOT re-implement that endpoint and does not require the dashboard plugin
   * to be loaded — `api/run/:taskId/events` is the polling fallback (design
   * 风险: "dashboard mount 路径被改导致 SSE 断").
   * @default '/helmsman-dashboard'
   */
  dashboardMount?: string
  /** Existing multi-agent diff view, used for conflict jump-offs. */
  diffMount?: string
  /** Workbench mount, used for doc/draft jump-offs. */
  workbenchMount?: string
  /** Coarse polling interval used when SSE is unavailable. @default 5000 */
  pollMs?: number
  /**
   * How long one `checkAgents()` probe is reused. The probe spawns the agent
   * CLIs, while `/api/items` is polled every few seconds, so it is cached;
   * `0` disables the cache (tests / "always fresh" deployments).
   * @default 30000
   */
  agentsTtlMs?: number
  now?: () => number
}

// ---------------------------------------------------------------------------
// Response payloads (what the SPA renders)
// ---------------------------------------------------------------------------

export type RunDotState = 'idle' | 'running' | 'queued' | 'merged' | 'done'

export const RUN_DOT_LABELS: Record<RunDotState, string> = {
  idle: '无执行',
  running: '在跑',
  queued: '排队',
  merged: '已合并',
  done: '完成',
}

export interface BadgeCounts {
  docs: number
  conversations: number
  services: number
}

/** One adapter's install state, flattened for the SPA. */
export interface AgentInstallPayload {
  name: string
  installed: boolean
  version?: string
}

/**
 * Result of one `checkAgents()` probe. Shared by every card payload of a
 * response, so an unavailable probe never makes an individual card look
 * startable (spec 「不满足时仅显示引导」).
 */
export interface AgentsProbePayload {
  /** False when the orchestrator (or its `checkAgents`) is missing/failed. */
  available: boolean
  installed: string[]
  agents: AgentInstallPayload[]
}

/**
 * The 第 ③ 列 「▶ 发起执行」 capability of ONE card (design D1). `available` is
 * the single gate the card renders on; `reason` is the Chinese hint shown
 * when it is false, so the page never offers a button that fails on submit.
 * `installed` is what the dialog's 按场景自适应 rule resolves against.
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
  /** `repo:module` or `repo:*` — the WIP counting unit (change task-workitem D7). */
  conflictDomain: string
  summary: Summary | null
  badges: BadgeCounts
  runState: RunDotState
  runStateLabel: string
  runCount: number
  queueingReason: string | null
  /** 第 ③ 列 「发起执行」 gate + the installed agents the dialog offers. */
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
  /** `service` = the board answered; `derived` = counted from the item list. */
  source: 'service' | 'derived'
  policy: WipPolicy | null
  domains: WipDomainPayload[]
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
  /** Every conflict file, as a JUMP-OFF only — never adjudicated here (D9). */
  conflicts: Array<{ agent: string; path: string; href: string }>
  merged: boolean
  mergedAt: number | null
  mergedFiles: string[]
  serviceCandidates: Array<{ refId: string; label: string; reason: string }>
}

/**
 * Answer of `POST api/item/:id/run`. `ok:false` carries a displayable Chinese
 * `reason` (same convention as a gate/WIP refusal: a normal outcome, HTTP 200).
 */
export interface StartRunPayload {
  ok: boolean
  taskId?: string
  reason?: string
  /** True when the started run was attached to the card (runs[] now shows it). */
  linked?: boolean
  /** Why the link failed — the run still started; the card can be re-linked. */
  linkError?: string
  /** Echo of what was handed to `runParallelTask` (audit of the one write). */
  prompt?: string
  agents?: string[]
  projectGroupId?: string
  cascade?: boolean
}

export interface ConfigPayload {
  mountPath: string
  dashboardMount: string
  diffMount: string
  workbenchMount: string
  pollMs: number
  /** `${dashboardMount}/api/task/{taskId}/stream` — change-A SSE address. */
  streamUrlTemplate: string
  services: { board: boolean; orchestrator: boolean; artifacts: boolean; topology: boolean }
}

// ---------------------------------------------------------------------------
// Payload builders
// ---------------------------------------------------------------------------

function repoOf(item: WorkItem): string {
  return item.repoScope?.baseRepo ?? item.repoScope?.projectGroup ?? item.repoScope?.repoPath ?? '未分组'
}

function moduleOf(item: WorkItem): string | null {
  const module = item.scope?.module
  return typeof module === 'string' && module.trim() !== '' ? module.trim() : null
}

function conflictDomainOf(item: WorkItem): string {
  const declared = item.conflictDomain
  if (typeof declared === 'string' && declared !== '') return declared
  const module = moduleOf(item)
  return module ? `${repoOf(item)}:${module}` : `${repoOf(item)}:*`
}

function badgeCounts(item: WorkItem): BadgeCounts {
  const associations = item.associations ?? []
  return {
    docs: associations.filter((a) => a.type === 'doc').length,
    conversations: associations.filter((a) => a.type === 'conversation').length,
    services: associations.filter((a) => a.type === 'service').length,
  }
}

const ACTIVE_TASK_STATES: ReadonlySet<string> = new Set(['CREATING_WORKTREES', 'RUNNING', 'AGGREGATING'])
const TERMINAL_TASK_STATES: ReadonlySet<string> = new Set(['COMPLETED', 'PARTIAL_FAILED', 'ALL_FAILED', 'CANCELLED'])

const RUN_STATE_RANK: Record<RunDotState, number> = { idle: 0, done: 1, merged: 2, queued: 3, running: 4 }

function mergeRunState(a: RunDotState, b: RunDotState): RunDotState {
  return RUN_STATE_RANK[b] > RUN_STATE_RANK[a] ? b : a
}

/** Derives one run's dot state from the board's ref + the live task record. */
export function runRefState(ref: RunRef, task: TaskStatusLike | undefined): RunDotState {
  const terminal = typeof ref.terminal === 'string' ? ref.terminal : ''
  if (/merge/i.test(terminal)) return 'merged'
  if (terminal !== '') return 'done'
  if (task) {
    if (ACTIVE_TASK_STATES.has(task.status)) return 'running'
    if (TERMINAL_TASK_STATES.has(task.status)) return 'done'
  }
  return 'idle'
}

export function cardRunState(item: WorkItem, tasks: Map<string, TaskStatusLike> | null): RunDotState {
  let state: RunDotState = 'idle'
  for (const ref of item.runs ?? []) {
    state = mergeRunState(state, runRefState(ref, tasks?.get(ref.taskId)))
  }
  // A card refused entry to the dev column queues instead of sitting idle.
  if (state === 'idle' && item.queueingReason) return 'queued'
  return state
}

export function toCardPayload(
  item: WorkItem,
  tasks: Map<string, TaskStatusLike> | null = null,
  agents: AgentsProbePayload | null = null,
): BoardCardPayload {
  const state = cardRunState(item, tasks)
  return {
    id: item.id,
    title: item.title,
    stage: item.stage,
    stageLabel: STAGE_LABELS[item.stage],
    repo: repoOf(item),
    projectGroup: item.repoScope?.projectGroup ?? null,
    repoScope: item.repoScope ?? {},
    module: moduleOf(item),
    conflictDomain: conflictDomainOf(item),
    summary: item.summary ?? null,
    badges: badgeCounts(item),
    runState: state,
    runStateLabel: RUN_DOT_LABELS[state],
    runCount: item.runs?.length ?? 0,
    queueingReason: item.queueingReason ?? null,
    startRun: startRunCapability(item, agents),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }
}

/**
 * The D1 entry gate, in one place: the card needs a `projectGroup` (the
 * topology the run is resolved through) AND that group needs at least one
 * installed agent (design D1). Anything else renders the 「请先在执行看板发起」
 * hint instead of a button that would fail on submit.
 *
 * The check does NOT consult WIP or the stage gate: WIP gates entering the
 * dev column, never adding another run inside it (spec 「WIP 不拦列内追加 run」).
 */
export function startRunCapability(item: WorkItem, agents: AgentsProbePayload | null): CardStartRunPayload {
  const projectGroup = item.repoScope?.projectGroup ?? null
  const installed = agents?.installed ?? []
  const base = { projectGroup, installed }
  if (!projectGroup) return { ...base, available: false, reason: '卡片未配置项目群(projectGroup)' }
  if (!agents?.available) return { ...base, available: false, reason: '编排服务不可用或无法探测 agent 安装状态' }
  if (installed.length === 0) return { ...base, available: false, reason: '该项目群暂无已安装的 agent' }
  return { ...base, available: true, reason: null }
}

function normalizeGap(raw: unknown): GateGap {
  const gap = (raw ?? {}) as { key?: unknown; label?: unknown; action?: unknown }
  const label = typeof gap.label === 'string' ? gap.label : String(gap.key ?? '未满足')
  return {
    key: typeof gap.key === 'string' ? gap.key : label,
    label,
    ...(typeof gap.action === 'string' && gap.action !== '' ? { action: gap.action } : {}),
  }
}

function normalizeGaps(raw: unknown): GateGap[] {
  if (!Array.isArray(raw)) return []
  return raw.map(normalizeGap)
}

/** A thrown refusal carrying gaps / a queueing reason is a displayable outcome. */
function refusalFrom(err: unknown): { gaps: GateGap[]; queueingReason?: string } | null {
  if (!err || typeof err !== 'object') return null
  const e = err as { gaps?: unknown; queueingReason?: unknown; reason?: unknown }
  const gaps = normalizeGaps(e.gaps)
  const queueingReason = typeof e.queueingReason === 'string' ? e.queueingReason : undefined
  const reason = typeof e.reason === 'string' ? e.reason : undefined
  if (gaps.length > 0 || queueingReason !== undefined) return { gaps, ...(queueingReason ? { queueingReason } : {}) }
  if (reason === 'wip' || reason === 'gate') {
    return { gaps, ...(reason === 'wip' ? { queueingReason: '冲突域已达上限' } : {}) }
  }
  return null
}

function requireService<T extends object, K extends keyof T>(svc: T, method: K, name: string): NonNullable<T[K]> {
  const fn = svc[method]
  if (typeof fn !== 'function') throw new Error(`${name} does not implement ${String(method)}()`)
  return fn as NonNullable<T[K]>
}

async function header(res: ServerResponse, status: number, body: unknown): Promise<undefined> {
  await sendJson(res, status, body)
  return undefined
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createBoardApiRouter(deps: BoardApiDeps): Router {
  const router = new Router()
  const board = deps.board
  const now = deps.now ?? (() => Date.now())
  const mountPath = (deps.mountPath ?? '/helmsman-board').replace(/\/+$/, '')
  const dashboardMount = (deps.dashboardMount ?? '/helmsman-dashboard').replace(/\/+$/, '')
  const diffMount = (deps.diffMount ?? '/helmsman-diff').replace(/\/+$/, '')
  const workbenchMount = (deps.workbenchMount ?? '/helmsman-workbench').replace(/\/+$/, '')
  const pollMs = deps.pollMs ?? 5_000
  const agentsTtlMs = deps.agentsTtlMs ?? 30_000
  let agentsCache: { at: number; payload: AgentsProbePayload } | null = null

  const orchestrator = () => deps.orchestrator?.()
  const artifacts = () => deps.artifacts?.()
  const topology = () => deps.topology?.()

  /** Live task records by id — used only to render run dots, never to write. */
  function taskIndex(): Map<string, TaskStatusLike> | null {
    const orch = orchestrator()
    if (!orch) return null
    try {
      const map = new Map<string, TaskStatusLike>()
      for (const task of orch.listTasks()) map.set(task.id, task)
      return map
    } catch {
      return null
    }
  }

  const NO_AGENTS: AgentsProbePayload = { available: false, installed: [], agents: [] }

  /**
   * One `checkAgents()` probe per TTL window. The probe spawns the agent CLIs
   * and `/api/items` is polled every few seconds, so the result is reused.
   * A missing/failed probe is NEVER cached: an orchestrator that is plugged in
   * later must not stay invisible (optional services resolve per request).
   */
  async function probeAgents(): Promise<AgentsProbePayload> {
    const orch = orchestrator()
    const check = orch?.checkAgents
    if (!orch || typeof check !== 'function') return NO_AGENTS
    if (agentsCache && agentsTtlMs > 0 && now() - agentsCache.at < agentsTtlMs) return agentsCache.payload
    try {
      const raw = await check.call(orch)
      const agents: AgentInstallPayload[] = Object.entries(raw ?? {}).map(([name, status]) => ({
        name,
        installed: status?.installed === true,
        ...(typeof status?.version === 'string' && status.version !== '' ? { version: status.version } : {}),
      }))
      const payload: AgentsProbePayload = {
        available: true,
        installed: agents.filter((agent) => agent.installed).map((agent) => agent.name),
        agents,
      }
      if (agentsTtlMs > 0) agentsCache = { at: now(), payload }
      return payload
    } catch {
      return NO_AGENTS
    }
  }

  /** Card payload with the (cached) agent probe folded in, so every response
   *  reports the 发起执行 gate truthfully rather than defaulting it off. */
  async function cardPayload(item: WorkItem): Promise<BoardCardPayload> {
    return toCardPayload(item, taskIndex(), await probeAgents())
  }

  async function loadItem(id: string): Promise<WorkItem | null> {
    const get = requireService(board, 'get', '@helmsman/board')
    return (await get.call(board, id)) ?? null
  }

  function configPayload(): ConfigPayload {
    return {
      mountPath,
      dashboardMount,
      diffMount,
      workbenchMount,
      pollMs,
      streamUrlTemplate: `${dashboardMount}/api/task/{taskId}/stream`,
      services: {
        board: true,
        orchestrator: orchestrator() !== undefined,
        artifacts: artifacts() !== undefined,
        topology: topology() !== undefined,
      },
    }
  }

  async function loadWip(cards: BoardCardPayload[]): Promise<WipPayload> {
    if (typeof board.wip === 'function') {
      try {
        const raw = await board.wip()
        const normalized = normalizeWip(raw, cards)
        if (normalized) return normalized
      } catch {
        // occupancy display degrades to the derived view (never blocks the page)
      }
    }
    return deriveWip(cards)
  }

  async function associationHrefs(item: WorkItem): Promise<ResolvedAssociationPayload[]> {
    const associations = item.associations ?? []
    const artifactSvc = artifacts()
    const orch = orchestrator()
    const group = item.repoScope?.projectGroup ?? ''
    const out: ResolvedAssociationPayload[] = []
    for (const assoc of associations) {
      const label = assoc.label ?? assoc.refId
      const base = { type: assoc.type, refId: assoc.refId, label, at: assoc.at }
      // Dangling detection is best-effort: only a reachable service may say
      // "missing"; an absent optional service must never look like a dangling
      // reference (spec task-workitem D3 / risks).
      if (assoc.type === 'artifact') {
        let dangling = assoc.dangling === true
        const href: string | null = `${dashboardMount}/api/artifacts/${encodeURIComponent(assoc.refId)}`
        if (artifactSvc) {
          try {
            dangling = (await artifactSvc.resolve(assoc.refId)) == null
          } catch {
            dangling = assoc.dangling === true
          }
        }
        out.push({ ...base, kind: 'artifact', href, dangling })
        continue
      }
      if (assoc.type === 'run') {
        let dangling = assoc.dangling === true
        if (orch) {
          try {
            dangling = (orch.getTaskStatus(assoc.refId) ?? (await orch.history.getTask?.(assoc.refId))) == null
          } catch {
            dangling = assoc.dangling === true
          }
        }
        out.push({ ...base, kind: 'diff', href: `${diffMount}/?task=${encodeURIComponent(assoc.refId)}`, dangling })
        continue
      }
      if (assoc.type === 'doc') {
        // draft (<id>.md written by the workbench generator) vs Tolaria note
        const isDraft = !assoc.refId.includes('/') || assoc.refId.startsWith('drafts/')
        const param = isDraft ? 'draft' : 'note'
        out.push({
          ...base,
          kind: isDraft ? 'workbench-doc' : 'tolaria-note',
          href: `${workbenchMount}/?${param}=${encodeURIComponent(assoc.refId)}`,
          dangling: assoc.dangling === true,
        })
        continue
      }
      if (assoc.type === 'service') {
        const query = group ? `?panel=config&group=${encodeURIComponent(group)}&service=${encodeURIComponent(assoc.refId)}` : ''
        out.push({ ...base, kind: 'dashboard', href: `${dashboardMount}/${query}`, dangling: assoc.dangling === true })
        continue
      }
      // worktree / conversation have no addressable web surface: the drawer
      // renders them as read-only chips (no content is copied into this page).
      out.push({ ...base, kind: 'none', href: null, dangling: assoc.dangling === true })
    }
    return out
  }

  /** Merged runs + conflict files, read from the durable timeline (change A). */
  async function runTimelineInfo(taskId: string): Promise<{ merged: boolean; mergedAt: number | null; files: string[] }> {
    const orch = orchestrator()
    if (!orch) return { merged: false, mergedAt: null, files: [] }
    try {
      const page = await orch.history.getEvents(taskId, 0)
      let mergedAt: number | null = null
      const files = new Set<string>()
      for (const event of page.events) {
        if (event.kind !== 'merge-decision') continue
        const payload = (event.payload ?? {}) as { outcome?: unknown; conflictFiles?: unknown }
        if (payload.outcome !== 'merged') continue
        mergedAt = event.ts
        if (Array.isArray(payload.conflictFiles)) {
          for (const f of payload.conflictFiles) if (typeof f === 'string') files.add(f)
        }
      }
      return { merged: mergedAt !== null, mergedAt, files: [...files] }
    } catch {
      return { merged: false, mergedAt: null, files: [] }
    }
  }

  /**
   * Impacted-service candidates for a merged run: changed file paths × the
   * project group's topology (spec task-kanban "合并后确认影响服务"). Purely
   * advisory — the user confirms, then it is written as an association.
   */
  async function serviceCandidates(item: WorkItem, task: TaskStatusLike | undefined): Promise<Array<{ refId: string; label: string; reason: string }>> {
    const topo = topology()
    const group = item.repoScope?.projectGroup
    if (!topo || !group) return []
    const changed = new Set<string>()
    for (const run of Object.values(task?.agents ?? {})) {
      for (const file of run.diffs ?? []) if (file.path) changed.add(file.path)
    }
    if (changed.size === 0) return []
    try {
      const loaded = await topo.loadTopology(group)
      const out: Array<{ refId: string; label: string; reason: string }> = []
      for (const [id, service] of Object.entries(loaded?.services ?? {})) {
        const localPath = service.localPath ?? ''
        if (!localPath) continue
        const prefix = `${localPath.replace(/\/+$/, '')}/`
        const hit = [...changed].find((file) => file.startsWith(prefix) || file.startsWith(localPath))
        if (!hit) continue
        out.push({ refId: id, label: service.name ?? id, reason: `改动文件命中 ${hit}` })
      }
      return out
    } catch {
      return []
    }
  }

  async function loadRuns(item: WorkItem): Promise<CardRunPayload[]> {
    const orch = orchestrator()
    const out: CardRunPayload[] = []
    for (const ref of item.runs ?? []) {
      let task: TaskStatusLike | undefined = orch?.getTaskStatus(ref.taskId) ?? undefined
      if (!task && orch?.history.getTask) {
        task = await orch.history.getTask(ref.taskId).catch(() => undefined)
      }
      const timeline = await runTimelineInfo(ref.taskId)
      const conflicts: Array<{ agent: string; path: string; href: string }> = []
      const seen = new Set<string>()
      for (const [agent, run] of Object.entries(task?.agents ?? {})) {
        for (const path of run.conflictingFiles ?? []) {
          const key = `${agent}:${path}`
          if (seen.has(key)) continue
          seen.add(key)
          // Jump-off only: the user decides in the diff view (design D9).
          conflicts.push({ agent, path, href: `${diffMount}/?task=${encodeURIComponent(ref.taskId)}` })
        }
      }
      for (const path of timeline.files) {
        const key = `merge:${path}`
        if (seen.has(key)) continue
        seen.add(key)
        conflicts.push({ agent: 'merge', path, href: `${diffMount}/?task=${encodeURIComponent(ref.taskId)}` })
      }
      let state = runRefState(ref, task)
      if (timeline.merged) state = 'merged'
      out.push({
        taskId: ref.taskId,
        startedAt: ref.startedAt,
        terminal: ref.terminal ?? null,
        state,
        stateLabel: RUN_DOT_LABELS[state],
        statusText: task?.status ?? null,
        prompt: task?.prompt ?? null,
        projectGroup: task?.projectGroupId ?? item.repoScope?.projectGroup ?? null,
        agents: Object.fromEntries(
          Object.entries(task?.agents ?? {}).map(([agent, run]) => [
            agent,
            {
              state: run.state ?? 'unknown',
              attempts: run.attempts ?? 0,
              conflictingFiles: run.conflictingFiles ?? [],
            },
          ]),
        ),
        conflicts,
        merged: timeline.merged,
        mergedAt: timeline.mergedAt,
        mergedFiles: timeline.files,
        serviceCandidates: timeline.merged ? await serviceCandidates(item, task) : [],
      })
    }
    return out
  }

  function pendingApprovalsFor(item: WorkItem): PendingApproval[] {
    const orch = orchestrator()
    if (!orch?.listPendingConfirmations) return []
    const taskIds = new Set((item.runs ?? []).map((r) => r.taskId))
    try {
      return orch.listPendingConfirmations().filter((a) => {
        const taskId = (a as { taskId?: unknown }).taskId
        if (typeof taskId === 'string') return taskIds.has(taskId)
        return [...taskIds].some((id) => a.scope?.includes(id))
      })
    } catch {
      return []
    }
  }

  // ---- config -------------------------------------------------------------

  router.get('api/config', async () => configPayload())

  // ---- board grid ---------------------------------------------------------

  router.get('api/items', async ({ query }) => {
    const repo = query.get('repo') ?? undefined
    const stage = parseStage(query.get('stage'))
    const list = requireService(board, 'list', '@helmsman/board')
    const items: WorkItem[] = await list.call(board, {
      ...(repo ? { repo } : {}),
      ...(stage ? { stage } : {}),
    })
    const tasks = taskIndex()
    // One probe per response (cached per TTL): every card carries the same
    // installed set, but its own projectGroup decides whether it is startable.
    const agents = await probeAgents()
    const cards = items.map((item) => toCardPayload(item, tasks, agents))
    return {
      serverTime: now(),
      items: cards,
      itemCount: cards.length,
      columns: columnsOf(cards),
      repos: [...new Set(cards.map((c) => c.repo))].sort(),
      wip: await loadWip(cards),
      config: configPayload(),
    }
  })

  // ---- create / read / update --------------------------------------------

  router.post('api/item', async ({ req, res }) => {
    const body = await readJsonBody(req)
    const title = typeof body.title === 'string' ? body.title.trim() : ''
    if (!title) return header(res, 400, { error: 'title is required' })
    const repoScope = parseRepoScope(body)
    if (!repoScope.baseRepo && !repoScope.projectGroup && !repoScope.repoPath) {
      return header(res, 400, { error: 'repoScope.baseRepo or repoScope.projectGroup is required' })
    }
    const stage = parseStage(body.stage) ?? 'requirements'
    const module = typeof body.module === 'string' && body.module.trim() !== '' ? body.module.trim() : undefined
    const conversation = parseConversation(body.conversation)
    const create = requireService(board, 'create', '@helmsman/board')
    const created = await create.call(board, {
      title,
      repoScope,
      stage,
      ...(module ? { scope: { module } } : {}),
      ...(conversation ? { conversation } : {}),
      ...(body.docPreset === true ? { docPreset: true } : {}),
      ...(typeof body.summaryText === 'string' && body.summaryText.trim() !== ''
        ? { summaryText: body.summaryText.trim() }
        : {}),
    })
    // Belt and braces for the chat-entry flow (spec task-kanban 建档入口): if
    // the board did not link the source conversation itself, do it explicitly
    // so the card is associated + summarised either way.
    let item = created
    if (conversation) {
      const linked = (item.associations ?? []).some(
        (a) => a.type === 'conversation' && a.refId === conversation.sessionId,
      )
      if (!linked && typeof board.associate === 'function') {
        item = await board.associate(item.id, {
          type: 'conversation',
          refId: conversation.sessionId,
          label: conversation.transcriptPath ?? `${conversation.type} 会话`,
          at: now(),
        })
      }
    }
    return { ok: true, item: await cardPayload(item) }
  })

  router.get('api/item/:id', async ({ params, res }) => {
    const item = await loadItem(params.id!)
    if (!item) return header(res, 404, { error: `item not found: ${params.id}` })
    const to = nextStage(item.stage)
    const gate = to ? await evaluateGate(item, to) : { to: null, ok: true, gaps: [] as GateGap[] }
    return {
      ok: true,
      item: await cardPayload(item),
      nextStage: to,
      nextStageLabel: to ? STAGE_LABELS[to] : null,
      gate,
      associations: await associationHrefs(item),
      services: configPayload().services,
    }
  })

  router.add('PATCH', 'api/item/:id', async ({ req, params, res }) => {
    const item = await loadItem(params.id!)
    if (!item) return header(res, 404, { error: `item not found: ${params.id}` })
    const body = await readJsonBody(req)
    let updated: WorkItem = item
    // A user-edited summary goes through the dedicated method (spec
    // task-workitem "摘要被用户改写" → generatedBy: 'manual').
    const summary = body.summary
    if (summary !== undefined) {
      const text = typeof summary === 'string' ? summary : (summary as { text?: unknown })?.text
      if (typeof text !== 'string') return header(res, 400, { error: 'summary.text must be a string' })
      const setSummary = requireService(board, 'setSummary', '@helmsman/board')
      updated = await setSummary.call(board, item.id, { text, generatedBy: 'manual', at: now() })
    }
    const patch: UpdateWorkItemInput = {}
    if (typeof body.title === 'string' && body.title.trim() !== '') patch.title = body.title.trim()
    if (typeof body.module === 'string') patch.scope = { module: body.module.trim() }
    else if (body.scope !== undefined && typeof body.scope === 'object' && body.scope !== null) {
      const module = (body.scope as { module?: unknown }).module
      if (typeof module === 'string') patch.scope = { module: module.trim() }
    }
    if (typeof body.specFinalized === 'boolean') patch.specFinalized = body.specFinalized
    if (Object.keys(patch).length > 0) {
      const update = requireService(board, 'update', '@helmsman/board')
      updated = await update.call(board, item.id, patch)
    }
    return { ok: true, item: await cardPayload(updated) }
  })

  // ---- gate + advance (the ONLY stage-write path; never local) ------------

  async function evaluateGate(item: WorkItem, to: Stage): Promise<{ to: Stage; ok: boolean; gaps: GateGap[]; queueingReason?: string }> {
    const gate = requireService(board, 'gate', '@helmsman/board')
    const raw = await gate.call(board, item.id, to)
    if (Array.isArray(raw)) {
      const gaps = normalizeGaps(raw)
      return { to, ok: gaps.length === 0, gaps }
    }
    const gaps = normalizeGaps((raw as GateOutcome)?.gaps)
    const ok = (raw as GateOutcome)?.ok ?? gaps.length === 0
    const queueingReason = (raw as GateOutcome)?.queueingReason
    return { to, ok, gaps, ...(queueingReason ? { queueingReason } : {}) }
  }

  router.get('api/item/:id/gate', async ({ params, query, res }) => {
    const item = await loadItem(params.id!)
    if (!item) return header(res, 404, { error: `item not found: ${params.id}` })
    const to = parseStage(query.get('to')) ?? nextStage(item.stage)
    if (!to) return { ok: true, from: item.stage, to: null, gaps: [], terminal: true }
    const gate = await evaluateGate(item, to)
    return { ok: gate.ok, from: item.stage, to, gaps: gate.gaps, ...(gate.queueingReason ? { queueingReason: gate.queueingReason } : {}) }
  })

  router.post('api/item/:id/advance', async ({ req, params, res }) => {
    const item = await loadItem(params.id!)
    if (!item) return header(res, 404, { error: `item not found: ${params.id}` })
    const body = await readJsonBody(req)
    const to = parseStage(body.to) ?? nextStage(item.stage)
    if (!to) {
      return { ok: false, from: item.stage, to: null, moved: false, gaps: [{ key: 'terminal', label: '已是最后阶段' }] }
    }
    // Default single step (design D4): a drag onto a non-adjacent column still
    // goes through the same call and is refused by the service with gaps.
    const allowSkip = body.allowSkip === true
    const advance = requireService(board, 'advance', '@helmsman/board')
    try {
      const raw = (await advance.call(board, { id: item.id, to, allowSkip })) as AdvanceOutcome | WorkItem
      const asOutcome = raw as AdvanceOutcome
      const gaps = normalizeGaps(asOutcome?.gaps)
      const queueingReason = asOutcome?.queueingReason ?? (asOutcome?.reason === 'wip' ? '冲突域已达上限' : undefined)
      const refused = asOutcome?.ok === false || gaps.length > 0 || (queueingReason !== undefined && queueingReason !== '')
      if (refused) {
        // Spec: the card stays put — report the pre-request item verbatim.
        return {
          ok: false,
          from: item.stage,
          to,
          moved: false,
          item: await cardPayload(item),
          gaps,
          ...(queueingReason ? { queueingReason } : {}),
        }
      }
      const updated = asOutcome?.item ?? (await loadItem(item.id)) ?? item
      return {
        ok: true,
        from: item.stage,
        to: updated.stage,
        moved: updated.stage !== item.stage,
        item: await cardPayload(updated),
        gaps: [],
      }
    } catch (err) {
      const refusal = refusalFrom(err)
      if (refusal) {
        return {
          ok: false,
          from: item.stage,
          to,
          moved: false,
          item: await cardPayload(item),
          gaps: refusal.gaps,
          ...(refusal.queueingReason ? { queueingReason: refusal.queueingReason } : {}),
        }
      }
      throw err
    }
  })

  // ---- associations -------------------------------------------------------

  router.post('api/item/:id/associate', async ({ req, params, res }) => {
    const item = await loadItem(params.id!)
    if (!item) return header(res, 404, { error: `item not found: ${params.id}` })
    const body = await readJsonBody(req)
    if (!isAssociationType(body.type)) {
      return header(res, 400, { error: `type must be one of ${ASSOCIATION_TYPES.join(' | ')}` })
    }
    const refId = typeof body.refId === 'string' ? body.refId.trim() : ''
    if (!refId) return header(res, 400, { error: 'refId is required' })
    const associate = requireService(board, 'associate', '@helmsman/board')
    const updated = await associate.call(board, item.id, {
      type: body.type,
      refId,
      ...(typeof body.label === 'string' && body.label !== '' ? { label: body.label } : {}),
      at: now(),
    })
    return { ok: true, item: await cardPayload(updated) }
  })

  // refId is a path for docs/artifacts, so it travels as a query parameter
  // (path-segment style would need triple-encoded slashes).
  router.delete('api/item/:id/associate', async ({ params, query, res }) => {
    const item = await loadItem(params.id!)
    if (!item) return header(res, 404, { error: `item not found: ${params.id}` })
    const type = query.get('type')
    const refId = query.get('refId') ?? ''
    if (!isAssociationType(type)) {
      return header(res, 400, { error: `type must be one of ${ASSOCIATION_TYPES.join(' | ')}` })
    }
    if (!refId) return header(res, 400, { error: 'refId is required' })
    const disassociate = requireService(board, 'disassociate', '@helmsman/board')
    const updated = await disassociate.call(board, item.id, { type, refId })
    return { ok: true, item: await cardPayload(updated) }
  })

  // ---- WIP occupancy ------------------------------------------------------

  router.get('api/board/wip', async () => {
    const list = requireService(board, 'list', '@helmsman/board')
    const items: WorkItem[] = await list.call(board)
    const cards = items.map((item) => toCardPayload(item, null))
    return await loadWip(cards)
  })

  router.get('api/board/events', async ({ query }) => {
    if (typeof board.queryEvents !== 'function') return { events: [], available: false }
    const itemId = query.get('itemId') ?? undefined
    const kind = query.get('kind') ?? undefined
    const limitRaw = Number(query.get('limit'))
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 20
    const events = await board.queryEvents({ ...(itemId ? { itemId } : {}), ...(kind ? { kind } : {}), limit })
    return { events, available: true }
  })

  // ---- runs (per card) + history pass-through ----------------------------

  router.get('api/item/:id/runs', async ({ params, res }) => {
    const item = await loadItem(params.id!)
    if (!item) return header(res, 404, { error: `item not found: ${params.id}` })
    const cfg = configPayload()
    return {
      ok: true,
      itemId: item.id,
      runs: await loadRuns(item),
      approvals: pendingApprovalsFor(item),
      historyAvailable: cfg.services.orchestrator,
      streamUrlTemplate: cfg.streamUrlTemplate,
      pollMs: cfg.pollMs,
      diffMount: cfg.diffMount,
    }
  })

  // ---- start a run for a card (the only write path of this package) ------

  /**
   * `POST api/item/:id/run` — 第 ③ 列卡片的「▶ 发起执行」(change
   * `enable-card-start-run`).
   *
   * Body: `{ prompt, agents, cascade? }` (`agents` = array, or a comma-separated
   * string as the headless tool takes). The project group is taken from the CARD
   * — never from the request — so a card can only ever start runs inside its own
   * topology.
   *
   * Semantics locked by the spec:
   *  - delegates to the EXISTING `runParallelTask` with exactly
   *    `{ prompt, agents, projectGroupId, cascade }` — no new pathway, no
   *    timeout/repoPath overrides (design D3: 其余参数不暴露);
   *  - writes nothing else — no board store write, no topology/declaration/ignore
   *    write (spec 「不修改任何既有数据」). Linking the returned `taskId` into the
   *    card's `runs[]` is deliberately NOT done here (that is a board-store write);
   *    it is the host's existing persistence channel, and this route only proves
   *    the run was injected by echoing the `taskId` back;
   *  - does NOT consult WIP or the stage gate — a saturated conflict domain
   *    gates entering the dev column, not adding a run inside it
   *    (spec 「WIP 不拦列内追加 run」);
   *  - does NOT offer cancel/retry/approval/merge (design D4) — those stay in
   *    the execution dashboard;
   *  - refuses as `200 + ok:false + reason` (a displayable outcome, exactly like
   *    a gate/WIP refusal) when the entry would fail: missing projectGroup, no
   *    orchestrator, no installed agent, an agent that is not installed, or the
   *    service rejecting the task. Only a malformed body (400) / unknown card
   *    (404) is non-200.
   */
  router.post('api/item/:id/run', async ({ req, params, res }) => {
    const item = await loadItem(params.id!)
    if (!item) return header(res, 404, { error: `item not found: ${params.id}` })
    const body = await readJsonBody(req)
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    if (prompt === '') return header(res, 400, { error: 'prompt is required' })
    const agents = parseAgents(body.agents)
    if (agents === null) return header(res, 400, { error: 'agents must be a non-empty array of agent names' })

    const projectGroup = item.repoScope?.projectGroup ?? null
    if (!projectGroup) {
      return { ok: false, reason: '卡片未配置项目群(projectGroup),无法解析项目拓扑' }
    }
    const orch = orchestrator()
    const runParallelTask = orch?.runParallelTask
    if (!orch || typeof runParallelTask !== 'function') {
      return { ok: false, reason: '编排服务(orchestrator)不可用,请先在执行看板发起' }
    }
    const probe = await probeAgents()
    if (probe.installed.length === 0) {
      return { ok: false, reason: '该项目群暂无已安装的 agent,请先在执行看板发起' }
    }
    // An agent the user picked explicitly is sent VERBATIM (spec 「用户主动改」:
    // no silent fallback) — an uninstalled one is refused loudly instead.
    const missing = agents.filter((agent) => !probe.installed.includes(agent))
    if (missing.length > 0) {
      return { ok: false, reason: `agent 未安装:${missing.join('、')}` }
    }

    const cascade = body.cascade === true
    let taskId: string
    try {
      // EXACTLY these four fields — the existing tool does the rest.
      const started = await runParallelTask.call(orch, { prompt, agents, projectGroupId: projectGroup, cascade })
      taskId = started.taskId
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }

    // Attach the started run to the card so its runs[] and run panel see it
    // (user decision ④: run 挂到卡片、SSE 实时滚动). This is the ONLY board
    // write this capability performs — it links an existing run id to the card
    // and changes no stage/gate/WIP. A failure here must NOT roll back the run:
    // it already started, so we report the reason and let the user re-link.
    const associate = board.associate
    let linked = false
    let linkError: string | undefined
    if (typeof associate === 'function') {
      try {
        await associate.call(board, item.id, { type: 'run', refId: taskId, label: prompt.slice(0, 80), at: now() })
        linked = true
      } catch (err) {
        linkError = err instanceof Error ? err.message : String(err)
      }
    } else {
      linkError = '看板服务不支持关联(associate),run 已起跑但未挂到卡片'
    }
    return {
      ok: true,
      taskId,
      prompt,
      agents,
      projectGroupId: projectGroup,
      cascade,
      linked,
      ...(linkError ? { linkError } : {}),
    }
  })

  /**
   * Polling fallback for the run timeline (design 风险: SSE 不可用时回退轮询).
   * Primary path is the dashboard's SSE endpoint; this route reads the SAME
   * durable timeline through the change-A service in-process, so the run panel
   * keeps working when the dashboard plugin is absent or its mount moved.
   */
  router.get('api/run/:taskId/events', async ({ params, query, res }) => {
    const orch = orchestrator()
    if (!orch) return header(res, 503, { error: 'orchestrator unavailable' })
    const taskId = params.taskId!
    const after = parseAfter(query.get('after'))
    const page = await orch.history.getEvents(taskId, after)
    const last = page.events.length > 0 ? page.events[page.events.length - 1]!.seq : after
    const task = orch.getTaskStatus(taskId) ?? (await orch.history.getTask?.(taskId)) ?? null
    return {
      task: task ? { id: task.id, status: task.status, prompt: task.prompt ?? null } : null,
      events: page.events,
      pruned: page.pruned,
      after,
      nextCursor: last,
    }
  })

  return router
}

function parseRepoScope(body: Record<string, unknown>): { baseRepo?: string; projectGroup?: string; repoPath?: string } {
  const nested = (body.repoScope ?? {}) as Record<string, unknown>
  const pick = (key: string): string | undefined => {
    const fromNested = nested[key]
    if (typeof fromNested === 'string' && fromNested.trim() !== '') return fromNested.trim()
    const direct = body[key]
    return typeof direct === 'string' && direct.trim() !== '' ? direct.trim() : undefined
  }
  const baseRepo = pick('baseRepo')
  const projectGroup = pick('projectGroup')
  const repoPath = pick('repoPath')
  return {
    ...(baseRepo ? { baseRepo } : {}),
    ...(projectGroup ? { projectGroup } : {}),
    ...(repoPath ? { repoPath } : {}),
  }
}

function parseConversation(raw: unknown): CreateWorkItemInput['conversation'] {
  if (!raw || typeof raw !== 'object') return undefined
  const c = raw as { type?: unknown; sessionId?: unknown; transcriptPath?: unknown }
  const type = c.type === 'dsh' || c.type === 'claude' || c.type === 'codex' ? c.type : null
  const sessionId = typeof c.sessionId === 'string' ? c.sessionId.trim() : ''
  if (!type || !sessionId) return undefined
  return {
    type,
    sessionId,
    ...(typeof c.transcriptPath === 'string' && c.transcriptPath !== '' ? { transcriptPath: c.transcriptPath } : {}),
  }
}

/**
 * Accepts the SPA's array form and the headless tool's comma-separated form.
 * Returns null for anything unusable (the route answers 400) — an empty list is
 * never silently widened to "all agents".
 */
function parseAgents(raw: unknown): string[] | null {
  const list =
    typeof raw === 'string'
      ? raw.split(',')
      : Array.isArray(raw)
        ? raw.filter((entry): entry is string => typeof entry === 'string')
        : []
  const names = [...new Set(list.map((name) => name.trim()).filter((name) => name !== ''))]
  return names.length > 0 ? names : null
}

function parseAfter(raw: string | null): number {
  const n = raw === null ? NaN : Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
}

export function columnsOf(cards: Array<{ stage: Stage }>): ColumnPayload[] {
  return STAGES.map((stage) => ({
    stage,
    label: STAGE_LABELS[stage],
    count: cards.filter((card) => card.stage === stage).length,
  }))
}

/**
 * Occupancy as reported by the board (`wip()`); returns null when the shape is
 * unusable so the caller can degrade to `deriveWip`.
 */
function normalizeWip(raw: WipReport | WipDomain[] | undefined, cards: BoardCardPayload[]): WipPayload | null {
  if (raw === undefined || raw === null) return null
  const domainsRaw = Array.isArray(raw) ? raw : raw.domains
  if (!Array.isArray(domainsRaw)) return null
  const inDev = cards.filter((card) => card.stage === 'dev')
  const domains: WipDomainPayload[] = domainsRaw.map((domain) => {
    const key = typeof domain.key === 'string' && domain.key !== '' ? domain.key : `${domain.repo ?? '?'}:${domain.module ?? '*'}`
    const counted = inDev.filter((card) => card.conflictDomain === key)
    const repo = domain.repo ?? key.split(':')[0] ?? ''
    const module = domain.module === undefined ? (key.split(':')[1] === '*' ? null : key.split(':')[1] ?? null) : domain.module
    return {
      key,
      repo,
      module,
      running: typeof domain.running === 'number' ? domain.running : counted.length,
      limit: typeof domain.limit === 'number' ? domain.limit : null,
      itemIds: Array.isArray(domain.itemIds) ? domain.itemIds.map(String) : counted.map((c) => c.id),
    }
  })
  const policy = (!Array.isArray(raw) && raw.policy) || null
  return { source: 'service', policy: policy ?? null, domains: domains.sort(byDomainKey) }
}

/** Fallback occupancy: counted from the item list, limits unknown. */
function deriveWip(cards: BoardCardPayload[]): WipPayload {
  const counts = new Map<string, string[]>()
  for (const card of cards) {
    if (card.stage !== 'dev') continue
    const list = counts.get(card.conflictDomain) ?? []
    list.push(card.id)
    counts.set(card.conflictDomain, list)
  }
  const domains: WipDomainPayload[] = [...counts.entries()].map(([key, itemIds]) => {
    const [repo = '', module = '*'] = key.split(':')
    return { key, repo, module: module === '*' ? null : module, running: itemIds.length, limit: null, itemIds }
  })
  return { source: 'derived', policy: null, domains: domains.sort(byDomainKey) }
}

function byDomainKey(a: WipDomainPayload, b: WipDomainPayload): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}
