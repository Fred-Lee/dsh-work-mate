/**
 * @helmsman/board model — the WorkItem aggregation root (change
 * `add-task-workitem-model`, design.md D1–D5).
 *
 * Every type here is plain JSON data: no classes, no runtime deps, no display
 * copy. Chinese stage names (需求分析 / 规格设计 / 开发实施 / 验收归档) intentionally
 * live in the UI layer, not in the model — this file only carries the ordered
 * `Stage` enum, so any host can render its own labels.
 *
 * Two-level structure (D1): a WorkItem OWNS `runs[]` as lightweight
 * `RunRef { taskId, startedAt, terminal? }` references only. Run state stays in
 * the orchestrator's own timeline; board never copies run data and never
 * changes the meaning of `taskId`.
 */
import { randomUUID } from 'node:crypto'

// ---------------------------------------------------------------------------
// Lifecycle stages
// ---------------------------------------------------------------------------

/** The four ordered stages of a WorkItem. Ordered: index IS the pipeline order. */
export const STAGES = ['requirements', 'spec', 'dev', 'done'] as const

export type Stage = (typeof STAGES)[number]

/** Runtime guard for values arriving from JSON / HTTP / config. */
export function isStage(value: unknown): value is Stage {
  return typeof value === 'string' && (STAGES as readonly string[]).includes(value)
}

/** Pipeline position of a stage (0-based). */
export function stageIndex(stage: Stage): number {
  return STAGES.indexOf(stage)
}

/** The single next stage, or `undefined` at the terminal stage (`done`). */
export function nextStage(stage: Stage): Stage | undefined {
  return STAGES[stageIndex(stage) + 1]
}

// ---------------------------------------------------------------------------
// WorkItem aggregate
// ---------------------------------------------------------------------------

/** Repo identity of a card: an explicit repo, a topology project group, or both. */
export interface RepoScope {
  baseRepo?: string
  projectGroup?: string
}

/**
 * Optional development scope (D7). `module` turns the card's conflict domain
 * into `repo:module`; when absent the card falls back to the whole-repo domain
 * `repo:*`.
 */
export interface Scope {
  module?: string
}

/**
 * Card summary snapshot (D4). Board STORES summaries only — generation happens
 * in the host (model call, manual edit, or degraded fallback), so this service
 * stays deterministic and unit-testable.
 */
export interface Summary {
  text: string
  generatedBy: SummarySource
  /** Optional provenance, e.g. a conversation id or `dsh`/`claude`/`codex`. */
  source?: string
  /** Epoch ms of the last write. */
  at: number
}

/** How a summary came to be. */
export const SUMMARY_SOURCES = ['model', 'manual', 'fallback'] as const

export type SummarySource = (typeof SUMMARY_SOURCES)[number]

/** Runtime guard for `generatedBy`. */
export function isSummarySource(value: unknown): value is SummarySource {
  return typeof value === 'string' && (SUMMARY_SOURCES as readonly string[]).includes(value)
}

/** Association categories (D3). All of them store REFERENCES, never content. */
export const ASSOCIATION_TYPES = ['doc', 'conversation', 'service', 'worktree', 'artifact', 'run'] as const

export type AssociationType = (typeof ASSOCIATION_TYPES)[number]

/** Runtime guard for `Association.type`. */
export function isAssociationType(value: unknown): value is AssociationType {
  return typeof value === 'string' && (ASSOCIATION_TYPES as readonly string[]).includes(value)
}

/**
 * A normalized reference to an object owned by another service (D3):
 * `refId` is the target's own id/path (vault note path, draft id, artifact
 * sha256, run taskId, conversation session id …) and `label` is a rendering
 * snapshot so the board's first paint needs no N+1 IO. The pointed-at content
 * is never copied into board storage.
 */
export interface Association {
  type: AssociationType
  refId: string
  label?: string
  /** Epoch ms the association was recorded. */
  at: number
}

/**
 * Reference to one orchestrator run. Board does not own run state: it reads
 * results through injected probes and never writes back to the run machine.
 */
export interface RunRef {
  taskId: string
  /** Epoch ms the run was attached to the card. */
  startedAt: number
  /**
   * Host-written terminal outcome label (e.g. `'merged'`, `'completed'`,
   * `'cancelled'`), or null/absent while the run is live. Board itself never
   * fabricates run state — the kanban derives `在跑 / 排队 / 已合并 / 完成`
   * from this label plus the durable `merge-decision` event.
   */
  terminal?: string | null
}

/** Gate keys whose values the board service evaluates itself. */
export const GATE_KEYS = ['specFinalized'] as const

/**
 * Per-card DoR/DoD data (D5). Deliberately extensible: hosts may store extra
 * boolean facts on the card without a schema change.
 */
export interface GateState {
  /** Set by the host once the spec document exists and is final. */
  specFinalized?: boolean
  [key: string]: unknown
}

/** A single unsatisfied gate (or WIP) check, rendered by any client. */
export interface GateGap {
  /**
   * Stable machine key — the localization contract for UIs. See
   * `GATE_GAP_KEYS`; the board ships English `label`/`action` copy.
   */
  key: string
  label: string
  action?: string
}

/**
 * Stable gap keys. The `label`/`action` strings this service returns are
 * English (code messages are English throughout Helmsman); a client that wants
 * Chinese copy (or any other locale) should switch on these keys.
 */
export const GATE_GAP_KEYS = {
  specFinalized: 'spec-finalized',
  runMerged: 'run-merged',
  auditOnRecord: 'audit-on-record',
  wipLimit: 'wip-limit',
  /** Structural refusal: the requested stage transition is not a forward +1 step. */
  stageTransition: 'stage-transition',
} as const

export type GateGapKey = (typeof GATE_GAP_KEYS)[keyof typeof GATE_GAP_KEYS]

/** The aggregation root: one cross-stage card. */
export interface WorkItem {
  id: string
  title: string
  summary: Summary
  repoScope: RepoScope
  /** Present once the host declares a module scope (see `Scope`). */
  scope?: Scope
  stage: Stage
  gates: GateState
  /** Reference set — never content copies. */
  associations: Association[]
  /** Two-level structure: references to orchestrator runs only. */
  runs: RunRef[]
  /** Epoch ms. */
  createdAt: number
  /** Epoch ms. */
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Conflict-domain WIP (D7)
// ---------------------------------------------------------------------------

/** Per-domain WIP ceilings. `module` applies to `repo:module`, `repo` to `repo:*`. */
export interface WipLimits {
  module?: number
  repo?: number
}

/** Defaults: one card per declared module, two per undeclared whole-repo domain. */
export const DEFAULT_WIP_LIMITS: Required<WipLimits> = { module: 1, repo: 2 }

/** Resolved WIP counters for one conflict domain, consumed by the kanban column. */
export interface WipStatus {
  /** Conflict-domain key: `repo:module` or `repo:*`. */
  domain: string
  /** Alias of `domain`: structural clients that key on `key` read this. */
  key: string
  running: number
  limit: number
  /**
   * Ids of cards one step short of the domain (their stage is `spec`, the only
   * stage that can advance into `dev`) that would land in this same domain —
   * i.e. the domain's next in line.
   */
  queueing: string[]
  /** Ids of the cards currently occupying the domain (the `running` set). */
  itemIds: string[]
  /** Repo half of the domain key. */
  repo: string
  /** Module half of the domain key, `null` for the whole-repo fallback. */
  module: string | null
}

/** Result of a conflict-domain WIP evaluation. */
export interface WipDecision {
  domain: string
  /** Alias of `domain`. */
  key: string
  allowed: boolean
  /** Cards currently occupying the domain. */
  running: number
  /** Ceiling that governs the domain. */
  limit: number
  /** Present only when `allowed` is false; always names `domain`. */
  reason?: string
  /** Alias of `reason` for clients that render a "queueing" wording. */
  queueingReason?: string
}

/** Trimmed, non-empty repo identity or `''` when the card declares neither. */
export function repoKey(repoScope: RepoScope | undefined): string {
  return trimmed(repoScope?.baseRepo) ?? trimmed(repoScope?.projectGroup) ?? ''
}

/** Trimmed, non-empty module name, or `undefined`. */
export function moduleOf(scope: Scope | undefined): string | undefined {
  return trimmed(scope?.module)
}

/**
 * Conflict-domain key (D7): `repo:module` when a module scope is declared,
 * `repo:*` otherwise. Same repo + different modules therefore never count
 * against each other.
 */
export function domainKey(repoScope: RepoScope | undefined, scope?: Scope): string {
  const repo = repoKey(repoScope) || '<unscoped>'
  return `${repo}:${moduleOf(scope) ?? '*'}`
}

/** Conflict domain of an existing card. */
export function domainOf(item: Pick<WorkItem, 'repoScope' | 'scope'>): string {
  return domainKey(item.repoScope, item.scope)
}

/**
 * The WIP ceiling that governs a card's domain: the module limit when the card
 * declares `scope.module`, otherwise the whole-repo fallback limit.
 */
export function wipLimit(scope: Scope | undefined, limits: Required<WipLimits>): number {
  return moduleOf(scope) !== undefined ? limits.module : limits.repo
}

// ---------------------------------------------------------------------------
// Lifecycle event stream (`~/.helmsman/board/events.jsonl`)
// ---------------------------------------------------------------------------

/** Event schema version, bumped only on a breaking payload change. */
export const BOARD_EVENT_VERSION = 1 as const

/** Every lifecycle event kind this service appends. */
export const BOARD_EVENT_TYPES = ['create', 'update', 'advance', 'associate', 'disassociate', 'summary'] as const

export type BoardEventType = (typeof BOARD_EVENT_TYPES)[number]

/** One append-only JSONL row. */
export interface BoardEvent {
  v: typeof BOARD_EVENT_VERSION
  /** Epoch ms, STRICTLY increasing within a store (safe `since` cursor). */
  ts: number
  type: BoardEventType
  itemId: string
  payload: Record<string, unknown>
}

/**
 * Event query filter. `since` is an inclusive lower bound on `ts`; because the
 * store never emits two rows with the same `ts`, clients can page by passing
 * the last seen `ts` back in without skipping events.
 */
export interface EventQuery {
  since?: number
  /** Event type (see `BOARD_EVENT_TYPES`). */
  type?: string
  /** Alias of `type` for structural clients that use OpenSpec's `kind` wording. */
  kind?: string
  itemId?: string
  /**
   * Maximum rows to return. Trimming keeps the NEWEST rows (the tail of the
   * stream, still in append order) — what a timeline wants by default.
   */
  limit?: number
}

// ---------------------------------------------------------------------------
// Ids and small shared helpers
// ---------------------------------------------------------------------------

/** Card id: `wi_` + 16 hex chars (URL-safe, filesystem-safe, collision-safe enough). */
export function newItemId(): string {
  return `wi_${randomUUID().replace(/-/g, '').slice(0, 16)}`
}

/** Trimmed non-empty string, or `undefined`. */
export function trimmed(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text === '' ? undefined : text
}

/** Plain-object guard (not null, not an array). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Deep copy of a card, so callers can never mutate stored state. */
export function cloneItem(item: WorkItem): WorkItem {
  return structuredClone(item)
}

/**
 * Structural deep-equality used to decide whether an `update` actually changed
 * anything (no-op updates do not append events).
 */
export function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
