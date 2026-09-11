/**
 * @helmsman/board — DSH plugin entry.
 *
 * Pure-Service cordis plugin (no `webServer`, no tools, no runtime deps)
 * owning the WorkItem aggregation root: the four-stage lifecycle with
 * versioned migration events, the reference-only association set, DoR/DoD gate
 * data + validation, conflict-domain WIP and conversation summaries — durable
 * under `HELMSMAN_HOME/board` (`~/.helmsman/board`).
 *
 * Exposes `helmsman.board` via `ctx.provide`:
 *   create / update / get / list / advance / gate / setGates /
 *   associate / disassociate / setSummary / wip / evaluateWip / queryEvents
 *
 * The two optional seams (`ExistenceProbe`, `GateProbe`) are wired through
 * `Config`; without them the service is fully standalone: associations are
 * accepted as unverified references and the archival gate reports
 * "cannot be verified" instead of silently passing.
 *
 * Hosts (`ui-board`, `ui-workbench`, …) `ctx.get('helmsman.board')` lazily and
 * degrade when this plugin is absent, so `inject` stays empty.
 */
import type { Context } from '@deepseek-ai/cordis'
import { BoardServiceImpl, type BoardServiceConfig, type ExistenceProbe, type GateProbe } from './service.ts'
import type { BoardService } from './service.ts'
import type { WipLimits } from './model.ts'

export const name = '@helmsman/board'
export const inject = [] as const

/**
 * Plugin config. `rootDir` / `wipLimits` / `allowSkip` are the behavioural
 * knobs; the two probes are the optional injection seams (design D4/D5) and are
 * the only way a host wires external facts into gate/association validation.
 */
export interface Config extends BoardServiceConfig {
  /** State root. @default $HELMSMAN_HOME/board, else ~/.helmsman/board */
  rootDir?: string
  /** Conflict-domain WIP ceilings. @default { module: 1, repo: 2 } */
  wipLimits?: WipLimits
  /** Allow multi-stage jumps in `advance`. @default false */
  allowSkip?: boolean
  /** Validates association targets (vault/drafts/artifacts/orchestrator). */
  existenceProbe?: ExistenceProbe
  /** Adjudicates the `dev → done` archival gate (merged run + audit record). */
  gateProbe?: GateProbe
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    'helmsman.board': BoardService
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  const board = new BoardServiceImpl(config)

  // Eager best-effort load: a corrupt/unreadable items.json must be reported at
  // boot (the store then fails closed and never overwrites the file), but it
  // must NOT take the whole profile down.
  const failure = board.warmUp()
  if (failure) console.error(`[helmsman/board] ${failure.code}: ${failure.message}`)

  ctx.provide('helmsman.board', board)
  console.log(`[helmsman/board] service ready (root: ${board.rootDir})`)
}

export {
  BoardServiceImpl,
  DEFAULT_ACTOR,
  type AdvanceOptions,
  type AdvanceResult,
  type AssociationInput,
  type BoardService,
  type BoardServiceConfig,
  type CreateWorkItemInput,
  type ExistenceProbe,
  type GateProbe,
  type SummaryInput,
  type WorkItemFilter,
  type WorkItemPatch,
} from './service.ts'
export {
  BOARD_SCHEMA_VERSION,
  BoardStore,
  EVENTS_FILE,
  ITEMS_FILE,
  defaultBoardRootDir,
  type BoardEventInput,
  type BoardStoreOptions,
  type MutationPlan,
  type Mutator,
} from './store.ts'
export { HelmsmanBoardError, errorMessage, isErrno, type BoardErrorCode } from './errors.ts'
export {
  ASSOCIATION_TYPES,
  BOARD_EVENT_TYPES,
  BOARD_EVENT_VERSION,
  DEFAULT_WIP_LIMITS,
  GATE_GAP_KEYS,
  GATE_KEYS,
  STAGES,
  SUMMARY_SOURCES,
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
  stageIndex,
  trimmed,
  wipLimit,
  type Association,
  type AssociationType,
  type BoardEvent,
  type BoardEventType,
  type EventQuery,
  type GateGap,
  type GateGapKey,
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
