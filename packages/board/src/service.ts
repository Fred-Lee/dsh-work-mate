/**
 * BoardService — the domain rules over the WorkItem aggregation root.
 *
 * Split from `store.ts` on purpose: the store owns bytes (atomic snapshot,
 * event stream, corrupt-file policy) and this file owns lifecycle rules —
 * single-step stage advance, DoR/DoD gate validation, conflict-domain WIP, the
 * reference-only association set and summary bookkeeping.
 *
 * Two injection seams keep the service standalone and testable (design D4/D5):
 * `ExistenceProbe` validates association targets (absent ⇒ references are
 * accepted as-is and the event records `verified: false`) and `GateProbe`
 * adjudicates the archival gate (absent ⇒ the gate reports "cannot be
 * verified" and REFUSES, never silently passes).
 *
 * Refusal semantics:
 * - structural mistakes (unknown id, invalid/backward/skip transition) THROW;
 * - domain refusals (unsatisfied gates, WIP ceiling) RETURN the gap list with
 *   the item unchanged, so a board can render the checklist and retry.
 */
import { HelmsmanBoardError, errorMessage } from './errors.ts'
import {
  DEFAULT_WIP_LIMITS,
  GATE_GAP_KEYS,
  STAGES,
  cloneItem,
  domainKey,
  domainOf,
  isAssociationType,
  isPlainObject,
  isStage,
  isSummarySource,
  moduleOf,
  newItemId,
  nextStage,
  repoKey,
  sameJson,
  stageIndex,
  trimmed,
  wipLimit,
  type Association,
  type AssociationType,
  type BoardEvent,
  type EventQuery,
  type GateGap,
  type GateState,
  type RepoScope,
  type RunRef,
  type Scope,
  type Stage,
  type Summary,
  type SummarySource,
  type WipDecision,
  type WipLimits,
  type WipStatus,
  type WorkItem,
} from './model.ts'
import { BoardStore, type BoardStoreOptions, type BoardEventInput } from './store.ts'

/** Default actor recorded on migration events when the caller does not name one. */
export const DEFAULT_ACTOR = 'helmsman.board'

/**
 * Validates that an association target resolves. Wired by the host (vault,
 * drafts, artifacts, orchestrator …); when absent the board accepts references
 * as-is and flags them `verified: false` in the event stream.
 */
export interface ExistenceProbe {
  exists(target: { type: AssociationType; refId: string }): boolean | Promise<boolean>
}

/**
 * Adjudicates the `dev → done` archival gate. Both facts live outside board
 * (orchestrator run state + the audit journal), so the host wires whichever it
 * has; a missing fact is reported as an unknown/unconfigured gap and refuses
 * the advance.
 */
export interface GateProbe {
  /** True when at least one of the item's runs has been merged. */
  hasMergedRun?(item: WorkItem): boolean | Promise<boolean>
  /** True when a merge audit record is on file for the item. */
  hasAuditOnRecord?(item: WorkItem): boolean | Promise<boolean>
}

export interface BoardServiceConfig extends BoardStoreOptions {
  /** WIP ceilings. @default { module: 1, repo: 2 } */
  wipLimits?: WipLimits
  /** Allow multi-stage jumps in `advance`. @default false */
  allowSkip?: boolean
  /** Optional association-target validator. */
  existenceProbe?: ExistenceProbe
  /** Optional archival-gate adjudicator. */
  gateProbe?: GateProbe
}

export interface CreateWorkItemInput {
  title: string
  /** Repo identity; at least one of `baseRepo` / `projectGroup` must be set. */
  repoScope: RepoScope
  /** Convenience alias merged over `repoScope`. */
  projectGroup?: string
  /** Convenience alias merged over `repoScope`. */
  baseRepo?: string
  /** Initial stage. @default 'requirements' */
  stage?: Stage
  /** Initial development scope (module conflict domain). */
  scope?: Scope
  /** Initial summary text; `at` is always stamped by the service. */
  summary?: SummaryInput
}

export interface WorkItemPatch {
  title?: string
  repoScope?: RepoScope
  scope?: Scope
  /**
   * Additive convenience alias for `setGates`: merged into the card's
   * `GateState` in the same update event. Non-boolean values (other than
   * `undefined`) are rejected.
   */
  specFinalized?: boolean
  /**
   * Rejected unless it equals the card's current stage. Stage writes belong to
   * `advance()` alone, so a board cannot rewrite a column behind the gates'
   * back (spec task-kanban "阶段迁移留痕" / design D5).
   */
  stage?: Stage
  /**
   * Additive gate-record alias: any boolean gate key may be set here instead of
   * through `setGates`.
   */
  gates?: GateState
}

export interface AdvanceOptions {
  /** Target stage. @default the single next stage */
  to?: Stage
  /** Override the configured skipless rule for this call. */
  allowSkip?: boolean
  /** Per-call gate probe override (test/host seam). */
  gateProbe?: GateProbe
  /** Trigger identity recorded on the migration event. @default 'helmsman.board' */
  actor?: string
  /** Declare (or clear) the development scope as part of entering `dev`. */
  scope?: Scope
}

/**
 * Object-style advance request: `advance({ id, to, allowSkip })` is accepted
 * exactly like `advance(id, { to, allowSkip })`.
 */
export interface AdvanceRequest extends AdvanceOptions {
  id: string
}

export interface AdvanceResult {
  /** True when the card moved; false when `gaps` explains the refusal. */
  ok: boolean
  /** The advanced card, or the unchanged card when `gaps` is non-empty. */
  item: WorkItem
  /** Empty ⇒ the advance happened. Non-empty ⇒ refused, nothing changed. */
  gaps: GateGap[]
  /** Set on a WIP refusal: the conflict-domain queueing reason. */
  queueingReason?: string
  /** Set on a refusal: every gap label joined, for single-reason surfaces. */
  reason?: string
}

export interface WorkItemFilter {
  /** Matches `repoScope.baseRepo` or `repoScope.projectGroup`. */
  repo?: string
  stage?: Stage
}

export interface AssociationInput {
  type: AssociationType
  /** Target's own id/path (vault note path, draft id, artifact sha256, taskId …). */
  refId: string
  /** Rendering snapshot (title/file name). */
  label?: string
}

export interface SummaryInput {
  text: string
  /**
   * @default 'manual' — a bare `setSummary` call is a user edit (the sibling UI
   * sends exactly `{ text }` for a hand-edited summary).
   */
  generatedBy?: SummarySource
  /** Preserved from the previous summary when omitted. */
  source?: string
}

/** Object-style WIP query: `evaluateWip({ repo, module, excludeId })`. */
export interface WipQuery {
  repo: string
  module?: string
  /** Ignore this card when counting the domain (e.g. re-evaluating a card). */
  excludeId?: string
}

/** The `helmsman.board` service surface. */
export interface BoardService {
  create(input: CreateWorkItemInput): Promise<WorkItem>
  update(id: string, patch: WorkItemPatch): Promise<WorkItem>
  get(id: string): Promise<WorkItem | undefined>
  list(filter?: WorkItemFilter): Promise<WorkItem[]>
  /** Accepts `(id, opts)` or the equivalent `({ id, ...opts })` object form. */
  advance(idOrRequest: string | AdvanceRequest, opts?: AdvanceOptions): Promise<AdvanceResult>
  gate(id: string, to?: Stage): Promise<GateGap[]>
  /** Canonical gate writer (see `WorkItemPatch.specFinalized` for the update alias). */
  setGates(id: string, patch: GateState): Promise<WorkItem>
  associate(id: string, association: AssociationInput): Promise<WorkItem>
  disassociate(id: string, association: Pick<AssociationInput, 'type' | 'refId'>): Promise<WorkItem>
  setSummary(id: string, summary: SummaryInput): Promise<WorkItem>
  wip(): Promise<WipStatus[]>
  /**
   * Synchronous by contract: reads the already-loaded in-memory snapshot.
   * Accepts `(repoScope, scope)` or `({ repo, module, excludeId })`.
   */
  evaluateWip(target: RepoScope | WipQuery, scope?: Scope): WipDecision
  queryEvents(filter?: EventQuery): Promise<BoardEvent[]>
  /**
   * Wires (or clears) the archival-gate adjudicator after construction.
   *
   * The adjudicated facts (merged run, audit record) live outside board, so the
   * host that owns them has to inject the probe — but it may only reach this
   * service after this plugin loaded. Config remains the other seam; this one
   * exists so wiring does not have to be serializable.
   *
   * `gate()` reads the probe on every call, so this must be set for the
   * read-only gap query and `advance` to agree (design D4: the drawer's gap list
   * is the same list that refuses the move).
   */
  setGateProbe(probe: GateProbe | undefined): void
}

export class BoardServiceImpl implements BoardService {
  readonly store: BoardStore
  readonly wipLimits: Required<WipLimits>
  readonly allowSkip: boolean
  private readonly existenceProbe: ExistenceProbe | undefined
  private gateProbe: GateProbe | undefined

  constructor(config: BoardServiceConfig = {}) {
    this.store = new BoardStore(config)
    this.wipLimits = {
      module: positiveLimit(config.wipLimits?.module, DEFAULT_WIP_LIMITS.module),
      repo: positiveLimit(config.wipLimits?.repo, DEFAULT_WIP_LIMITS.repo),
    }
    this.allowSkip = config.allowSkip === true
    this.existenceProbe = config.existenceProbe
    this.gateProbe = config.gateProbe
  }

  /** State root actually in use (for logging / diagnostics). */
  get rootDir(): string {
    return this.store.rootDir
  }

  /**
   * Late wiring seam for the archival gate (see `BoardService.setGateProbe`).
   * Passing `undefined` restores the standalone behaviour: the gate reports
   * "unconfigured" and refuses instead of silently passing.
   */
  setGateProbe(probe: GateProbe | undefined): void {
    this.gateProbe = probe
  }

  /**
   * Best-effort eager load. Returns a load failure (corrupt items.json, unknown
   * schema) for the plugin entry to log instead of crashing the profile; every
   * later operation fails closed with the same typed error.
   */
  warmUp(): HelmsmanBoardError | null {
    return this.store.warmUp()
  }

  // -- CRUD ------------------------------------------------------------------

  async create(input: CreateWorkItemInput): Promise<WorkItem> {
    if (!isPlainObject(input)) throw invalid('create input must be an object')
    const title = requireText(input.title, 'title')
    const repoScope = normalizeRepoScope(input.repoScope, input.baseRepo, input.projectGroup)
    const stage = input.stage ?? 'requirements'
    if (!isStage(stage)) throw invalid(`unknown stage: ${JSON.stringify(input.stage)}`, { stage: input.stage })
    const scope = normalizeScope(input.scope)
    const now = Date.now()
    const summary = normalizeCreateSummary(input.summary, now)

    const item: WorkItem = {
      id: newItemId(),
      title,
      summary,
      repoScope,
      ...(scope ? { scope } : {}),
      stage,
      gates: {},
      associations: [],
      runs: [],
      createdAt: now,
      updatedAt: now,
    }

    return this.store.transact((items) => ({
      result: cloneItem(item),
      items: [...items, item],
      events: [
        {
          type: 'create',
          itemId: item.id,
          payload: {
            title,
            stage,
            repo: repoKey(repoScope),
            baseRepo: repoScope.baseRepo,
            projectGroup: repoScope.projectGroup,
            module: moduleOf(scope),
            summary: summaryEvent(summary),
          },
        },
      ],
    }))
  }

  async update(id: string, patch: WorkItemPatch): Promise<WorkItem> {
    if (!isPlainObject(patch)) throw invalid('update patch must be an object')
    const title = 'title' in patch ? requireText(patch.title, 'title') : undefined
    const repoScope = 'repoScope' in patch ? normalizeRepoScopePatch(patch.repoScope) : undefined
    // `'scope' in patch` matters: an empty scope CLEARS the module declaration
    // (whole-repo conflict domain), which is not the same as "leave it alone".
    const scopeProvided = 'scope' in patch
    const scope = scopeProvided ? normalizeScope(patch.scope) : undefined
    const gates = patch.gates === undefined ? undefined : normalizeGates(patch.gates)
    // Gate-record alias: `{ specFinalized: true }` is the shape a board sends.
    const specFinalized = patch.specFinalized
    if (specFinalized !== undefined && typeof specFinalized !== 'boolean') {
      throw invalid('specFinalized must be a boolean', { specFinalized })
    }
    if (patch.stage !== undefined && !isStage(patch.stage)) {
      throw invalid(`unknown stage: ${JSON.stringify(patch.stage)}`, { stage: patch.stage })
    }

    return this.store.transact((items) => {
      const item = requireIn(items, id)
      if (patch.stage !== undefined && patch.stage !== item.stage) {
        // Stages are written by advance() only — a client must never move a
        // column behind the gates (spec task-kanban "阶段迁移留痕").
        throw new HelmsmanBoardError(
          'INVALID_INPUT',
          `update() cannot change stage ("${item.stage}" → "${patch.stage}"): use advance() so gates and WIP are checked`,
          { id, from: item.stage, to: patch.stage },
        )
      }
      const changed: string[] = []
      const payload: Record<string, unknown> = {}

      if (title !== undefined && title !== item.title) {
        changed.push('title')
        payload.title = title
        item.title = title
      }
      if (repoScope !== undefined && !sameJson(repoScope, item.repoScope)) {
        changed.push('repoScope')
        payload.repo = repoKey(repoScope)
        payload.baseRepo = repoScope.baseRepo
        payload.projectGroup = repoScope.projectGroup
        item.repoScope = repoScope
      }
      if (scopeProvided && !sameJson(scope, item.scope)) {
        changed.push('scope')
        payload.module = moduleOf(scope)
        if (scope) item.scope = scope
        else delete item.scope
      }
      let gatePatch: GateState = { ...(gates ?? {}) }
      if (typeof specFinalized === 'boolean') gatePatch = { ...gatePatch, specFinalized }
      if (gateDiffs(item.gates, gatePatch).length > 0) {
        changed.push('gates')
        item.gates = { ...item.gates, ...gatePatch }
        payload.gates = item.gates
      }

      // An update that changes nothing is a no-op: no `updatedAt` bump, no event.
      if (changed.length === 0) return { result: cloneItem(item) }

      item.updatedAt = Date.now()
      return {
        result: cloneItem(item),
        items,
        events: [{ type: 'update', itemId: item.id, payload: { changed, ...payload } }],
      }
    })
  }

  async get(id: string): Promise<WorkItem | undefined> {
    return this.store.find(id)
  }

  async list(filter: WorkItemFilter = {}): Promise<WorkItem[]> {
    const wanted = trimmed(filter.repo)
    const items = this.store.snapshot()
    return items
      .filter((item) => {
        if (filter.stage !== undefined && item.stage !== filter.stage) return false
        if (wanted === undefined) return true
        return item.repoScope.baseRepo === wanted || item.repoScope.projectGroup === wanted
      })
      // Stable sort on `createdAt` only: cards created in the same millisecond
      // keep their storage (creation) order instead of drifting on id.
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  // -- stages and gates ------------------------------------------------------

  async advance(idOrRequest: string | AdvanceRequest, opts: AdvanceOptions = {}): Promise<AdvanceResult> {
    // Two accepted call shapes: `advance(id, opts)` and the object form
    // `advance({ id, to, allowSkip })` used by structural consumers.
    const request: AdvanceOptions & { id?: unknown } =
      typeof idOrRequest === 'string' ? { ...opts, id: idOrRequest } : { ...idOrRequest, ...opts }
    const id = requireText(request.id, 'id')
    const actor = trimmed(request.actor) ?? DEFAULT_ACTOR

    return this.store.transact<AdvanceResult>(async (items) => {
      const item = requireIn(items, id)
      const from = item.stage
      const target = request.to ?? nextStage(from)

      if (target === undefined) {
        throw structuralRefusal('STAGE_TERMINAL', `work item "${id}" is already in the final stage "${from}"`, {
          id,
          from,
          to: null,
          gap: '已是最后一个阶段,没有可推进的目标',
        })
      }
      if (!isStage(target)) {
        throw invalid(`unknown target stage: ${JSON.stringify(request.to)}`, { to: request.to })
      }

      const delta = stageIndex(target) - stageIndex(from)
      if (delta <= 0) {
        throw structuralRefusal(
          'INVALID_TRANSITION',
          `stages advance forward only: "${from}" → "${target}" is not a forward transition`,
          {
            id,
            from,
            to: target,
            gap: `卡片只能一次向前推进一个阶段;"${target}" 并不在 "${from}" 之后`,
          },
        )
      }
      const skipAllowed = request.allowSkip ?? this.allowSkip
      if (delta > 1 && !skipAllowed) {
        const missing = missingStages(from, target)
        throw structuralRefusal(
          'SKIP_NOT_ALLOWED',
          `cannot skip stages: "${from}" → "${target}" would skip ${missing.map((stage) => `"${stage}"`).join(', ')}`,
          {
            id,
            from,
            to: target,
            missingStages: missing,
            gap: `需要先经过中间阶段 ${missing.map((stage) => `"${stage}"`).join(', ')}`,
          },
        )
      }

      // The scope a card would enter dev with (declared on the call, else kept).
      const scope = target === 'dev' && 'scope' in request ? normalizeScope(request.scope) : item.scope

      const gaps = await this.gapsFor(item, target, request.gateProbe)
      let queueingReason: string | undefined
      if (gaps.length === 0 && target === 'dev') {
        const decision = evaluateDomain(items, item.repoScope, scope, this.wipLimits)
        if (!decision.allowed) {
          queueingReason = decision.reason
          gaps.push(wipGap(decision))
        }
      }
      // Refused: card, storage and event stream all stay untouched.
      if (gaps.length > 0) {
        return {
          result: {
            ok: false,
            item: cloneItem(item),
            gaps,
            ...(queueingReason ? { queueingReason } : {}),
            reason: gaps.map((gap) => gap.label).join('; '),
          },
        }
      }

      const next: WorkItem = { ...item, stage: target, updatedAt: Date.now() }
      if (target === 'dev' && 'scope' in request) {
        if (scope) next.scope = scope
        else delete next.scope
      }
      const index = items.findIndex((candidate) => candidate.id === id)
      items[index] = next

      return {
        result: { ok: true, item: cloneItem(next), gaps: [] },
        items,
        events: [
          {
            type: 'advance',
            itemId: id,
            payload: {
              from,
              to: target,
              at: next.updatedAt,
              actor,
              runs: next.runs.map((run) => run.taskId),
              module: moduleOf(next.scope) ?? null,
              ...(target === 'dev' ? { domain: domainOf(next) } : {}),
            },
          },
        ],
      }
    })
  }

  async gate(id: string, to?: Stage): Promise<GateGap[]> {
    const item = this.store.require(id)
    // `to` may be omitted: the only meaningful target is the next stage, and at
    // the terminal stage there is nothing further to gate.
    const target = to ?? nextStage(item.stage)
    if (target === undefined) return []
    if (!isStage(target)) throw invalid(`unknown target stage: ${JSON.stringify(to)}`, { to })
    return this.gapsFor(item, target)
  }

  async setGates(id: string, patch: GateState): Promise<WorkItem> {
    const gates = normalizeGates(patch)
    return this.store.transact((items) => {
      const item = requireIn(items, id)
      if (gateDiffs(item.gates, gates).length === 0) return { result: cloneItem(item) }
      item.gates = { ...item.gates, ...gates }
      item.updatedAt = Date.now()
      return {
        result: cloneItem(item),
        items,
        events: [{ type: 'update', itemId: item.id, payload: { changed: ['gates'], gates: item.gates } }],
      }
    })
  }

  // -- associations ----------------------------------------------------------

  async associate(id: string, association: AssociationInput): Promise<WorkItem> {
    const { type, refId, label } = normalizeAssociationInput(association)
    // Probe outside the write lock: resolution may hit another service's IO.
    const verified = await this.verifyTarget(type, refId)

    return this.store.transact((items) => {
      const item = requireIn(items, id)
      const already = item.associations.some((entry) => entry.type === type && entry.refId === refId)
      if (already) return { result: cloneItem(item) } // idempotent: no event, no bump

      const at = Date.now()
      const entry: Association = { type, refId, ...(label ? { label } : {}), at }
      item.associations = [...item.associations, entry]
      if (type === 'run' && !item.runs.some((run) => run.taskId === refId)) {
        // D1: runs are referenced, never copied — ids and times only.
        item.runs = [...item.runs, { taskId: refId, startedAt: at } satisfies RunRef]
      }
      item.updatedAt = at

      return {
        result: cloneItem(item),
        items,
        events: [
          {
            type: 'associate',
            itemId: item.id,
            payload: { type, refId, label: label ?? null, verified, at },
          },
        ],
      }
    })
  }

  async disassociate(id: string, association: Pick<AssociationInput, 'type' | 'refId'>): Promise<WorkItem> {
    const type = requireAssociationType(association?.type)
    const refId = requireText(association?.refId, 'refId')

    return this.store.transact((items) => {
      const item = requireIn(items, id)
      const kept = item.associations.filter((entry) => !(entry.type === type && entry.refId === refId))
      if (kept.length === item.associations.length) return { result: cloneItem(item) } // nothing to remove

      item.associations = kept
      if (type === 'run') item.runs = item.runs.filter((run) => run.taskId !== refId)
      item.updatedAt = Date.now()

      return {
        result: cloneItem(item),
        items,
        events: [{ type: 'disassociate', itemId: item.id, payload: { type, refId, at: item.updatedAt } }],
      }
    })
  }

  // -- summary ---------------------------------------------------------------

  async setSummary(id: string, summary: SummaryInput): Promise<WorkItem> {
    if (!isPlainObject(summary)) throw invalid('summary must be an object')
    if (typeof summary.text !== 'string') throw invalid('summary text must be a string')
    const source0 = summary.generatedBy ?? 'manual'
    if (!isSummarySource(source0)) {
      throw invalid(
        `summary generatedBy must be one of ${SUMMARY_SOURCE_LIST}; got ${JSON.stringify(summary.generatedBy)}`,
        { generatedBy: summary.generatedBy },
      )
    }
    const text = summary.text
    const generatedBy = source0
    // Metadata is preserved across a manual edit unless the caller supplies a new source.
    const explicitSource = trimmed(summary.source)

    return this.store.transact((items) => {
      const item = requireIn(items, id)
      const source = explicitSource ?? item.summary.source
      const unchanged =
        item.summary.text === text && item.summary.generatedBy === generatedBy && item.summary.source === source
      if (unchanged) return { result: cloneItem(item) }

      const previous = item.summary.generatedBy
      const next: Summary = { text, generatedBy, ...(source ? { source } : {}), at: Date.now() }
      item.summary = next
      item.updatedAt = next.at

      return {
        result: cloneItem(item),
        items,
        events: [
          {
            type: 'summary',
            itemId: item.id,
            // Conversation-derived text can be sensitive, so the trail records
            // shape/metadata only — never the prose itself.
            payload: { generatedBy, source: source ?? null, chars: text.length, previousGeneratedBy: previous, at: next.at },
          },
        ],
      }
    })
  }

  // -- WIP -------------------------------------------------------------------

  async wip(): Promise<WipStatus[]> {
    const items = this.store.snapshot()
    const byDomain = new Map<string, WipStatus>()
    for (const item of items) {
      const domain = domainOf(item)
      const repo = repoKey(item.repoScope)
      const entry = byDomain.get(domain) ?? {
        domain,
        key: domain,
        running: 0,
        limit: wipLimit(item.scope, this.wipLimits),
        queueing: [],
        itemIds: [],
        repo,
        module: moduleOf(item.scope) ?? null,
      }
      if (item.stage === 'dev') {
        entry.running += 1
        entry.itemIds.push(item.id)
      } else if (item.stage === 'spec') entry.queueing.push(item.id)
      byDomain.set(domain, entry)
    }
    return [...byDomain.values()]
      .map((entry) => ({ ...entry, queueing: [...entry.queueing].sort(), itemIds: [...entry.itemIds].sort() }))
      .sort((a, b) => a.domain.localeCompare(b.domain))
  }

  evaluateWip(target: RepoScope | WipQuery, scope?: Scope): WipDecision {
    const query = normalizeWipTarget(target, scope)
    const items =
      query.excludeId === undefined
        ? this.store.snapshot()
        : this.store.snapshot().filter((item) => item.id !== query.excludeId)
    return evaluateDomain(items, query.repoScope, query.scope, this.wipLimits)
  }

  // -- events ----------------------------------------------------------------

  async queryEvents(filter: EventQuery = {}): Promise<BoardEvent[]> {
    return this.store.events(filter)
  }

  // -- internals -------------------------------------------------------------

  /** DoR/DoD gaps for entering `target` (stage ordering is handled by `advance`). */
  private async gapsFor(item: WorkItem, target: Stage, probeOverride?: GateProbe): Promise<GateGap[]> {
    if (target === 'requirements' || target === 'spec') return [] // DoR: nothing beyond the previous stage
    if (target === 'dev') {
      return item.gates.specFinalized === true ? [] : [specGap()]
    }
    if (target === 'done') return this.archivalGaps(item, probeOverride)
    throw invalid(`unknown target stage: ${JSON.stringify(target)}`, { to: target })
  }

  /** `dev → done`: ≥1 merged run AND the audit-on-record probe. */
  private async archivalGaps(item: WorkItem, probeOverride?: GateProbe): Promise<GateGap[]> {
    const probe = probeOverride ?? this.gateProbe
    const gaps: GateGap[] = []

    if (item.runs.length === 0) {
      gaps.push(
        gap(
          GATE_GAP_KEYS.runMerged,
          '该卡片尚未关联任何 run',
          '先为这张卡片发起一次舰队运行,再重试归档推进。',
        ),
      )
    } else if (typeof probe?.hasMergedRun !== 'function') {
      gaps.push(
        gap(
          GATE_GAP_KEYS.runMerged,
          `无法判定 ${item.runs.length} 个 run 是否已合并:未配置 gate probe`,
          '把 GateProbe.hasMergedRun(读 orchestrator 运行状态)接入 @helmsman/board,再重试。',
        ),
      )
    } else {
      const merged = await probeFlag(probe.hasMergedRun.bind(probe), item)
      if (merged.error !== undefined) {
        gaps.push(
          gap(
            GATE_GAP_KEYS.runMerged,
            `合并状态无法验证:${merged.error}`,
            '修复已接入的 GateProbe.hasMergedRun 实现,再重试。',
          ),
        )
      } else if (!merged.value) {
        gaps.push(
          gap(
            GATE_GAP_KEYS.runMerged,
            '该卡片还没有任何 run 被合并',
            '合并其中一个 run(逐文件裁决仍由你决定),再重试。',
          ),
        )
      }
    }

    if (typeof probe?.hasAuditOnRecord !== 'function') {
      gaps.push(
        gap(
          GATE_GAP_KEYS.auditOnRecord,
          '无法确认合并审计记录:未配置 gate probe',
          '把 GateProbe.hasAuditOnRecord(读审计日志)接入 @helmsman/board,再重试。',
        ),
      )
    } else {
      const audited = await probeFlag(probe.hasAuditOnRecord.bind(probe), item)
      if (audited.error !== undefined) {
        gaps.push(
          gap(
            GATE_GAP_KEYS.auditOnRecord,
            `合并审计记录无法验证:${audited.error}`,
            '修复已接入的 GateProbe.hasAuditOnRecord 实现,再重试。',
          ),
        )
      } else if (!audited.value) {
        gaps.push(
          gap(
            GATE_GAP_KEYS.auditOnRecord,
            '该卡片没有对应的合并审计记录在案',
            '通过有审计的合并路径执行合并,让记录落进审计日志。',
          ),
        )
      }
    }

    return gaps
  }

  /** Resolves an association target; throws `TARGET_NOT_FOUND` on a miss. */
  private async verifyTarget(type: AssociationType, refId: string): Promise<boolean> {
    if (!this.existenceProbe) return false // accepted as-is; the event records verified:false
    let exists: boolean
    try {
      exists = (await this.existenceProbe.exists({ type, refId })) === true
    } catch (err) {
      // Fail closed: an unverifiable target is not silently accepted.
      throw new HelmsmanBoardError(
        'TARGET_NOT_FOUND',
        `cannot verify association target ${type} "${refId}": ${errorMessage(err)}`,
        { type, refId },
      )
    }
    if (!exists) {
      throw new HelmsmanBoardError(
        'TARGET_NOT_FOUND',
        `association target does not exist: ${type} "${refId}"`,
        { type, refId },
      )
    }
    return true
  }
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

const SUMMARY_SOURCE_LIST = "'model', 'manual' or 'fallback'"

/** Stages strictly between `from` and `to` (empty for a valid single step). */
function missingStages(from: Stage, to: Stage): Stage[] {
  return STAGES.slice(stageIndex(from) + 1, stageIndex(to))
}

/**
 * Conflict-domain WIP evaluation (D7): counts cards currently in `dev` whose
 * domain key equals the candidate's, and compares against that domain's ceiling.
 */
function evaluateDomain(
  items: WorkItem[],
  repoScope: RepoScope,
  scope: Scope | undefined,
  limits: Required<WipLimits>,
): WipDecision {
  const domain = domainKey(repoScope, scope)
  const limit = wipLimit(scope, limits)
  const running = items.filter((item) => item.stage === 'dev' && domainOf(item) === domain).length
  if (running < limit) return { domain, key: domain, allowed: true, running, limit }
  const reason = `冲突域 "${domain}" 已达 WIP 上限(${running}/${limit})`
  return { domain, key: domain, allowed: false, running, limit, reason, queueingReason: reason }
}

/**
 * Accepting either `(repoScope, scope)` or the object form
 * `({ repo, module, excludeId })` that structural clients send.
 */
function normalizeWipTarget(
  target: RepoScope | WipQuery,
  scope?: Scope,
): { repoScope: RepoScope; scope?: Scope; excludeId?: string } {
  if (!isPlainObject(target)) throw invalid('evaluateWip needs a repoScope or a { repo, module } query')
  const flat = target as unknown as WipQuery
  const nested = target as RepoScope
  if (nested.baseRepo === undefined && nested.projectGroup === undefined && typeof flat.repo === 'string') {
    const module = trimmed(flat.module)
    const excludeId = trimmed(flat.excludeId)
    const query: { repoScope: RepoScope; scope?: Scope; excludeId?: string } = {
      repoScope: { baseRepo: flat.repo },
    }
    if (module !== undefined) query.scope = { module }
    if (excludeId !== undefined) query.excludeId = excludeId
    return query
  }
  return scope === undefined ? { repoScope: nested } : { repoScope: nested, scope }
}

/** Structural transitions carry a displayable gap so a REST layer need not 500. */
function structuralRefusal(
  code: 'STAGE_TERMINAL' | 'INVALID_TRANSITION' | 'SKIP_NOT_ALLOWED',
  message: string,
  details: { id: string; from: Stage; to: Stage | null; gap: string; missingStages?: Stage[] },
): HelmsmanBoardError {
  const gap: GateGap = {
    key: GATE_GAP_KEYS.stageTransition,
    label: details.gap,
    action: '每次只推进一个阶段(通过 advance())。'
  }
  return new HelmsmanBoardError(code, message, { ...details, gaps: [gap] })
}

function specGap(): GateGap {
  return gap(
    GATE_GAP_KEYS.specFinalized,
    '缺少已定稿的 spec',
    '关联 spec 文档并置位卡片的 specFinalized 门(setGates),再重试。',
  )
}

function wipGap(decision: WipDecision): GateGap {
  return gap(
    GATE_GAP_KEYS.wipLimit,
    decision.reason ?? `冲突域 "${decision.domain}" 已达 WIP 上限`,
    '等待该冲突域内有卡片离开开发阶段,或改声明不同的 scope.module。',
  )
}

function gap(key: string, label: string, action?: string): GateGap {
  return action === undefined ? { key, label } : { key, label, action }
}

/** Runs a probe flag, converting a throw into a reported (not swallowed) error. */
async function probeFlag(
  fn: (item: WorkItem) => boolean | Promise<boolean>,
  item: WorkItem,
): Promise<{ value: boolean; error?: string }> {
  try {
    return { value: (await fn(item)) === true }
  } catch (err) {
    return { value: false, error: errorMessage(err) }
  }
}

function requireIn(items: WorkItem[], id: string): WorkItem {
  const found = items.find((item) => item.id === id)
  if (!found) throw new HelmsmanBoardError('NOT_FOUND', `unknown work item "${id}"`, { id })
  return found
}

/** Gate keys whose patched value differs from what the card already carries. */
function gateDiffs(current: GateState, patch: GateState): string[] {
  return Object.entries(patch)
    .filter(([key, value]) => !sameJson(current[key], value))
    .map(([key]) => key)
}

function invalid(message: string, details: Record<string, unknown> = {}): HelmsmanBoardError {
  return new HelmsmanBoardError('INVALID_INPUT', message, details)
}

function requireText(value: unknown, field: string): string {
  const text = trimmed(value)
  if (text === undefined) throw invalid(`${field} must be a non-empty string`, { field })
  return text
}

function normalizeRepoScope(repoScope: unknown, baseRepo?: unknown, projectGroup?: unknown): RepoScope {
  const scope = isPlainObject(repoScope) ? (repoScope as RepoScope) : undefined
  const repo = trimmed(scope?.baseRepo) ?? trimmed(baseRepo)
  const group = trimmed(scope?.projectGroup) ?? trimmed(projectGroup)
  if (repo === undefined && group === undefined) {
    throw invalid('a work item needs a repo identity: set repoScope.baseRepo or repoScope.projectGroup')
  }
  return { ...(repo ? { baseRepo: repo } : {}), ...(group ? { projectGroup: group } : {}) }
}

function normalizeRepoScopePatch(repoScope: unknown): RepoScope {
  if (!isPlainObject(repoScope)) throw invalid('repoScope must be an object')
  const repo = trimmed(repoScope.baseRepo)
  const group = trimmed(repoScope.projectGroup)
  if (repo === undefined && group === undefined) {
    throw invalid('repoScope must keep at least one of baseRepo / projectGroup non-empty')
  }
  return { ...(repo ? { baseRepo: repo } : {}), ...(group ? { projectGroup: group } : {}) }
}

/** Normalizes a scope; `undefined` means "no module declared" (whole-repo domain). */
function normalizeScope(scope: unknown): Scope | undefined {
  if (scope === undefined || scope === null) return undefined
  if (!isPlainObject(scope)) throw invalid('scope must be an object')
  const module = moduleOf(scope as Scope)
  return module === undefined ? undefined : { module }
}

/** Normalizes gate data; only booleans are accepted for the declared gate keys. */
function normalizeGates(patch: unknown): GateState {
  if (!isPlainObject(patch)) throw invalid('gates must be an object')
  const out: GateState = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (typeof value !== 'boolean') {
      throw invalid(`gate "${key}" must be a boolean`, { key, value })
    }
    out[key] = value
  }
  return out
}

function normalizeAssociationInput(association: AssociationInput): {
  type: AssociationType
  refId: string
  label: string | undefined
} {
  if (!isPlainObject(association)) throw invalid('association must be an object')
  return {
    type: requireAssociationType(association.type),
    refId: requireText(association.refId, 'refId'),
    label: trimmed(association.label),
  }
}

function requireAssociationType(value: unknown): AssociationType {
  if (!isAssociationType(value)) {
    throw invalid(`unknown association type: ${JSON.stringify(value)}`, { type: value })
  }
  return value
}

function normalizeCreateSummary(summary: SummaryInput | undefined, at: number): Summary {
  if (summary === undefined || summary === null) return { text: '', generatedBy: 'fallback', at }
  if (!isPlainObject(summary)) throw invalid('summary must be an object')
  if (typeof summary.text !== 'string') throw invalid('summary text must be a string')
  const generatedBy = summary.generatedBy ?? 'fallback'
  if (!isSummarySource(generatedBy)) {
    throw invalid(`summary generatedBy must be one of ${SUMMARY_SOURCE_LIST}`, { generatedBy })
  }
  const source = trimmed(summary.source)
  return { text: summary.text, generatedBy, ...(source ? { source } : {}), at }
}

/** Summary metadata shape recorded in event payloads (never the prose itself). */
function summaryEvent(summary: Summary): Record<string, unknown> {
  return {
    generatedBy: summary.generatedBy,
    source: summary.source ?? null,
    chars: summary.text.length,
  }
}

function positiveLimit(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return fallback
  return Math.floor(value)
}
