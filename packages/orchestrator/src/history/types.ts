/**
 * Execution-history contract shared by the engine and every storage backend.
 *
 * The design is deliberately framework-free: `OrchestratorCore` talks to a
 * `HistoryStore` interface and defaults to an in-memory implementation so the
 * engine tests never touch the filesystem. `JsonlHistoryStore` provides the
 * durable backend used by the DSH plugin entry (`~/.helmsman/history/`).
 *
 * Events are versioned from day one (`v: 1`) so older JSONL logs can coexist
 * with a future schema bump, and every event carries a per-task monotonic
 * `seq` cursor so clients can page forward and resync without duplicates.
 */
import type { AgentRunState, TaskRecord, TaskState } from '../types.ts'

/** Current event schema version — bump on any breaking change to `ExecutionEvent`. */
export const EXECUTION_EVENT_VERSION = 1 as const

export type ExecutionEventKind = 'task-state' | 'agent-log' | 'agent-attempt' | 'run-start' | 'run-end' | 'merge-decision'

/**
 * Trimmed per-agent view persisted inside a `task-state` event payload (no
 * logs, no full diffs — those live in `agent-log` events and the worktrees).
 */
export interface TaskAgentStatePayload {
  agent: string
  state: AgentRunState
  attempts: number
  startedAt?: number
  endedAt?: number
  exitCode?: number | null
  /** Short human-readable failure reason (already classified). */
  error?: string
  stats?: { files: number; additions: number; deletions: number }
  conflictingFiles?: string[]
  /** Derived: any diff was collected for this agent during aggregation. */
  hasDiff: boolean
}

/** Payload of a `task-state` event — enough to re-render a dashboard card. */
export interface TaskStateEventPayload {
  id: string
  prompt: string
  status: TaskState
  projectGroupId?: string
  cascade: boolean
  timeoutSec: number
  createdAt: number
  endedAt?: number
  /** True when this record was restored from disk after a host restart. */
  interrupted?: boolean
  agents: Record<string, TaskAgentStatePayload>
}

/** Payload of an `agent-log` event — one chunk of an agent's stdout+stderr. */
export interface AgentLogEventPayload {
  text: string
}

/** Payload of an `agent-attempt` event — a (re)trial of an agent began. */
export interface AgentAttemptEventPayload {
  attempt: number
}

/** Payload of a `run-start` event — an agent process attempt started. */
export interface RunStartEventPayload {
  attempt: number
}

/** Payload of a `run-end` event — an agent process attempt settled. */
export interface RunEndEventPayload {
  attempt: number
  state: AgentRunState
  exitCode?: number | null
  timedOut: boolean
  error?: string
}

/** Per-file human adjudication for one real (apply-failed) conflict file. */
export type MergeResolution =
  | { kind: 'agent'; agent: string }
  | { kind: 'manual' }
  | { kind: 'skip' }

/** Result row mirroring the merge result contract (kept JSON-safe). */
export interface MergeDecisionResultRow {
  agent: string
  ok: boolean
  committed: boolean
  message: string
  conflictFiles: string[]
}

/**
 * Payload of a `merge-decision` event — a durable record of a merge execution
 * on the run timeline: which agents/files were merged, the user's per-file
 * adjudication payload (`resolutions`), any real conflicts, and the outcome.
 * Serves as the "merge was human-adjudicated" evidence for acceptance
 * archival (spec merge-conflict-resolution).
 */
export interface MergeDecisionEventPayload {
  /** Agents targeted by this merge. */
  agents: string[]
  /** Repo-relative file scope, when the merge was file-restricted. */
  files?: string[]
  /** User's per-file adjudication for real conflict files (file → choice). */
  resolutions: Record<string, MergeResolution>
  /** Real (apply-failed) conflict files surfaced by this merge execution. */
  conflictFiles: string[]
  /** Worktrees were cleaned up as part of this merge decision. */
  discardAfterMerge: boolean
  outcome: 'merged' | 'aborted'
  /** Per-agent execution outcome rows. */
  results: MergeDecisionResultRow[]
}

export type ExecutionEventPayload =
  | TaskStateEventPayload
  | AgentLogEventPayload
  | AgentAttemptEventPayload
  | RunStartEventPayload
  | RunEndEventPayload
  | MergeDecisionEventPayload

/**
 * A versioned execution event as it appears on the timeline and on the wire.
 * `seq` is per-task monotonic; `kind` discriminates the payload shape.
 * Consumers MUST tolerate unknown `kind` values (future additive kinds).
 */
export type ExecutionEvent =
  | { v: 1; seq: number; ts: number; taskId: string; kind: 'task-state'; payload: TaskStateEventPayload }
  | { v: 1; seq: number; ts: number; taskId: string; agent: string; kind: 'agent-log'; payload: AgentLogEventPayload }
  | { v: 1; seq: number; ts: number; taskId: string; agent: string; kind: 'agent-attempt'; payload: AgentAttemptEventPayload }
  | { v: 1; seq: number; ts: number; taskId: string; agent: string; kind: 'run-start'; payload: RunStartEventPayload }
  | { v: 1; seq: number; ts: number; taskId: string; agent: string; kind: 'run-end'; payload: RunEndEventPayload }
  | { v: 1; seq: number; ts: number; taskId: string; kind: 'merge-decision'; payload: MergeDecisionEventPayload }

/**
 * What the engine asks the store to append. `v`/`seq` are assigned by the
 * store so per-task monotonicity is guaranteed even across restarts.
 */
export type AppendExecutionEvent =
  | { ts: number; taskId: string; kind: 'task-state'; payload: TaskStateEventPayload }
  | { ts: number; taskId: string; agent: string; kind: 'agent-log'; payload: AgentLogEventPayload }
  | { ts: number; taskId: string; agent: string; kind: 'agent-attempt'; payload: AgentAttemptEventPayload }
  | { ts: number; taskId: string; agent: string; kind: 'run-start'; payload: RunStartEventPayload }
  | { ts: number; taskId: string; agent: string; kind: 'run-end'; payload: RunEndEventPayload }
  | { ts: number; taskId: string; kind: 'merge-decision'; payload: MergeDecisionEventPayload }

/** Result of a cursor read: strictly events with `seq > after`, in order. */
export interface EventsPage {
  events: ExecutionEvent[]
  /**
   * True when the requested cursor precedes a pruned (dropped) range, so a
   * resync from `after` would silently skip events. Callers MUST surface this
   * as the explicit `history-pruned` signal instead of pretending full data.
   */
  pruned: boolean
}

export interface PruneOptions {
  /** Keep at most this many most-recent task records. @default 50 */
  maxTasks?: number
  /** Keep at most this many most-recent events per task. @default 2000 */
  maxEventRowsPerTask?: number
}

export interface PruneResult {
  /** Whole task records (summary + event log) removed by retention. */
  removedTasks: number
  /** Event lines dropped by the per-task horizontal cap. */
  removedEventRows: number
}

/**
 * Storage seam for durable task history + the event timeline. Implementations
 * must be append-safe (a crash mid-write never corrupts earlier records) and
 * MUST order every append under a per-task monotonic `seq`.
 */
export interface HistoryStore {
  readonly kind: 'memory' | 'jsonl'
  /** All task summaries, most-recent first. */
  listTasks(): Promise<TaskRecord[]>
  /** Last-known lifecycle record of one task (undefined when unknown/pruned). */
  getTask(taskId: string): Promise<TaskRecord | undefined>
  /** Cursor read: events with `seq > after`; empty + `pruned:false` when at latest. */
  eventsAfter(taskId: string, after: number): Promise<EventsPage>
  /** Upsert the task lifecycle snapshot (durable when the backend is jsonl). */
  upsertTask(task: TaskRecord): Promise<void>
  /** Persist one execution event and return it with its assigned `seq`. */
  append(event: AppendExecutionEvent): Promise<ExecutionEvent>
  /**
   * Live tail: `listener` fires after an event for `taskId` has been durably
   * appended (in seq order). Returns an unsubscribe function.
   */
  subscribe(taskId: string, listener: (event: ExecutionEvent) => void): () => void
  /**
   * Apply retention: drop the oldest task records beyond `maxTasks` and trim
   * each remaining task's event log beyond `maxEventRowsPerTask`. Only ever
   * touches Helmsman-owned history files.
   */
  prune(opts?: PruneOptions): Promise<PruneResult>
  /** Resolves once every previously enqueued write has settled. */
  flush(): Promise<void>
}
