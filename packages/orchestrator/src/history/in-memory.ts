/**
 * InMemoryHistoryStore — the default backend used by engine unit tests and by
 * any caller that never opts into durable history. Mirrors the semantics of
 * `JsonlHistoryStore` (per-task event ring + task summaries + cursor reads +
 * pruning) without touching the filesystem.
 */
import type { TaskRecord } from '../types.ts'
import {
  EXECUTION_EVENT_VERSION,
  type AppendExecutionEvent,
  type ExecutionEvent,
  type EventsPage,
  type HistoryStore,
  type PruneOptions,
  type PruneResult,
} from './types.ts'

export interface InMemoryHistoryStoreOptions {
  /** Event ring cap applied by `prune()`. @default 2000 */
  maxEventRowsPerTask?: number
  /** Summary-map cap applied by `prune()`. @default 50 */
  maxTasks?: number
}

/** Sorted helper for pruning "oldest first". */
function recencyKey(task: TaskRecord): number {
  return task.endedAt ?? task.createdAt
}

export class InMemoryHistoryStore implements HistoryStore {
  readonly kind = 'memory' as const

  private readonly summaries = new Map<string, TaskRecord>()
  /** Per-task event lists in append order (head may be trimmed by prune). */
  private readonly events = new Map<string, ExecutionEvent[]>()
  private readonly nextSeq = new Map<string, number>()
  /** Task ids whose whole history was pruned → taskId → its last seq. */
  private readonly prunedTasks = new Map<string, number>()
  private readonly listeners = new Map<string, Set<(event: ExecutionEvent) => void>>()

  private maxTasks: number
  private maxEventRowsPerTask: number

  /** Serialized write chain — FIFO so appends keep monotonic seq under load. */
  private tail: Promise<unknown> = Promise.resolve()

  constructor(opts: InMemoryHistoryStoreOptions = {}) {
    this.maxTasks = opts.maxTasks ?? 50
    this.maxEventRowsPerTask = opts.maxEventRowsPerTask ?? 2000
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.tail.then(op, op)
    this.tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async flush(): Promise<void> {
    await this.tail
  }

  /** Snapshot the write queue tail before reading so reads never miss a write. */
  private async drain(): Promise<void> {
    await this.tail
  }

  private notify(event: ExecutionEvent): void {
    const set = this.listeners.get(event.taskId)
    if (!set || set.size === 0) return
    for (const listener of [...set]) {
      try {
        listener(event)
      } catch {
        // a subscriber must never break the append path
      }
    }
  }

  async listTasks(): Promise<TaskRecord[]> {
    await this.drain()
    return [...this.summaries.values()].sort((a, b) => recencyKey(b) - recencyKey(a))
  }

  async getTask(taskId: string): Promise<TaskRecord | undefined> {
    await this.drain()
    return this.summaries.get(taskId)
  }

  async eventsAfter(taskId: string, after: number): Promise<EventsPage> {
    await this.drain()
    const list = this.events.get(taskId)
    if (!list || list.length === 0) {
      const lastSeq = this.prunedTasks.get(taskId)
      if (lastSeq !== undefined && after < lastSeq) return { events: [], pruned: true }
      return { events: [], pruned: false }
    }
    const firstSeq = list[0]!.seq
    const events = list.filter((e) => e.seq > after)
    // A gap exists between the cursor and the retained head: [after+1, firstSeq).
    const pruned = after + 1 < firstSeq
    return { events, pruned }
  }

  async upsertTask(task: TaskRecord): Promise<void> {
    const snapshot = structuredClone(task)
    await this.enqueue(async () => {
      this.summaries.set(task.id, snapshot)
    })
  }

  async append(input: AppendExecutionEvent): Promise<ExecutionEvent> {
    const event: ExecutionEvent = await this.enqueue(async () => {
      const seq = (this.nextSeq.get(input.taskId) ?? 0) + 1
      this.nextSeq.set(input.taskId, seq)
      const base = { v: EXECUTION_EVENT_VERSION, seq, ts: input.ts, taskId: input.taskId } as const
      const isTaskLevel = input.kind === 'task-state' || input.kind === 'merge-decision'
      const full = (isTaskLevel
        ? { ...base, kind: input.kind, payload: input.payload }
        : { ...base, agent: input.agent, kind: input.kind, payload: input.payload }) as ExecutionEvent
      let list = this.events.get(input.taskId)
      if (!list) {
        list = []
        this.events.set(input.taskId, list)
      }
      list.push(full)
      return full
    })
    // Notify outside the mutex so a slow subscriber can never block appends,
    // but still in append order (this continuation runs as each append settles).
    this.notify(event)
    return event
  }

  async prune(opts: PruneOptions = {}): Promise<PruneResult> {
    const maxTasks = opts.maxTasks ?? this.maxTasks
    const maxEventRows = opts.maxEventRowsPerTask ?? this.maxEventRowsPerTask
    return await this.enqueue(async () => {
      const result: PruneResult = { removedTasks: 0, removedEventRows: 0 }
      // 1) Whole-task retention: keep the most-recent `maxTasks` summaries.
      const sorted = [...this.summaries.entries()].sort((a, b) => recencyKey(b[1]) - recencyKey(a[1]))
      for (const [taskId] of sorted.slice(maxTasks)) {
        const list = this.events.get(taskId)
        const lastSeq = list && list.length > 0 ? list[list.length - 1]!.seq : 0
        if (lastSeq > 0) this.prunedTasks.set(taskId, lastSeq)
        this.summaries.delete(taskId)
        this.events.delete(taskId)
        result.removedTasks += 1
      }
      // 2) Horizontal per-task cap: drop the oldest event rows.
      for (const [taskId, list] of this.events) {
        if (list.length <= maxEventRows) continue
        const drop = list.length - maxEventRows
        result.removedEventRows += drop
        list.splice(0, drop)
      }
      return result
    })
  }

  subscribe(taskId: string, listener: (event: ExecutionEvent) => void): () => void {
    let set = this.listeners.get(taskId)
    if (!set) {
      set = new Set()
      this.listeners.set(taskId, set)
    }
    set.add(listener)
    return () => {
      const current = this.listeners.get(taskId)
      current?.delete(listener)
      if (current && current.size === 0) this.listeners.delete(taskId)
    }
  }
}
