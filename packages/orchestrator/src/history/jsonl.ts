/**
 * JsonlHistoryStore — durable task history under `~/.helmsman/history/`
 * (override with HELMSMAN_HOME). Layout:
 *
 *   <root>/tasks/<taskId>.jsonl   append-only JSONL, one ExecutionEvent/line
 *   <root>/tasks.json             atomic task-summary snapshot (tmp+rename)
 *
 * Append-safety: an event is a single appended JSON line; a crash mid-write
 * only ever tears the trailing line, which reads ignore. The summary snapshot
 * is rewritten atomically (tmp file + rename) so a crash never leaves it half
 * written. Every write runs through one serialized queue, so per-task `seq`
 * stays monotonic even when several agents append concurrently.
 */
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile, appendFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
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

export interface JsonlHistoryStoreOptions {
  /** History directory override. @default ~/.helmsman/history (HELMSMAN_HOME aware) */
  rootDir?: string
  /** Default `maxTasks` when `prune()` is called without options. @default 50 */
  maxTasks?: number
  /** Default per-task event cap when `prune()` is called without options. @default 2000 */
  maxEventRowsPerTask?: number
}

export function defaultHistoryRootDir(): string {
  const base = process.env.HELMSMAN_HOME ?? join(homedir(), '.helmsman')
  return join(base, 'history')
}

const SNAPSHOT_FILE = 'tasks.json'
const SNAPSHOT_VERSION = 1 as const

interface SnapshotFile {
  v: 1
  tasks: TaskRecord[]
  pruned: Array<{ taskId: string; lastSeq: number }>
}

/** Task ids come from the engine but we refuse anything that could traverse. */
function assertSafeTaskId(taskId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(taskId)) {
    throw new Error(`unsafe task id for history path: ${JSON.stringify(taskId)}`)
  }
}

function recencyKey(task: TaskRecord): number {
  return task.endedAt ?? task.createdAt
}

function parseEventLine(line: string): ExecutionEvent | null {
  const text = line.trim()
  if (!text) return null
  try {
    const raw = JSON.parse(text) as Partial<ExecutionEvent> & { v?: number }
    // v:1 + seq + taskId are required — anything else (corrupt/partial line,
    // future schema) is ignored rather than allowed to break a replay.
    if (raw.v !== 1 || typeof raw.seq !== 'number' || typeof raw.taskId !== 'string' || typeof raw.kind !== 'string') return null
    if (!raw.payload || typeof raw.ts !== 'number') return null
    return raw as ExecutionEvent
  } catch {
    return null // torn tail from a crash mid-append
  }
}

export class JsonlHistoryStore implements HistoryStore {
  readonly kind = 'jsonl' as const
  readonly rootDir: string
  private readonly tasksDir: string
  private readonly snapshotPath: string

  private readonly maxTasks: number
  private readonly maxEventRowsPerTask: number

  private readonly listeners = new Map<string, Set<(event: ExecutionEvent) => void>>()
  /** Per-task next seq, hydrated lazily from disk on first append after boot. */
  private readonly nextSeq = new Map<string, number>()
  private hydratedSeqTasks = new Set<string>()

  /** Serialized write chain — all appends/snapshot rewrites/prunes are FIFO. */
  private tail: Promise<unknown> = Promise.resolve()

  constructor(opts: JsonlHistoryStoreOptions = {}) {
    this.rootDir = opts.rootDir ?? defaultHistoryRootDir()
    this.tasksDir = join(this.rootDir, 'tasks')
    this.snapshotPath = join(this.rootDir, SNAPSHOT_FILE)
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

  private async ensureDirs(): Promise<void> {
    await mkdir(this.tasksDir, { recursive: true })
  }

  private async readSnapshotLocked(): Promise<SnapshotFile> {
    if (!existsSync(this.snapshotPath)) return { v: SNAPSHOT_VERSION, tasks: [], pruned: [] }
    try {
      const parsed = JSON.parse(await readFile(this.snapshotPath, 'utf8')) as Partial<SnapshotFile>
      if (!Array.isArray(parsed.tasks)) return { v: SNAPSHOT_VERSION, tasks: [], pruned: [] }
      return {
        v: SNAPSHOT_VERSION,
        tasks: parsed.tasks as TaskRecord[],
        pruned: Array.isArray(parsed.pruned) ? (parsed.pruned as Array<{ taskId: string; lastSeq: number }>) : [],
      }
    } catch {
      // corrupt snapshot degrades to empty — it is rebuilt on the next upsert
      return { v: SNAPSHOT_VERSION, tasks: [], pruned: [] }
    }
  }

  /** Rewrite the whole snapshot atomically (tmp file + rename). */
  private async writeSnapshotLocked(snapshot: SnapshotFile): Promise<void> {
    await this.ensureDirs()
    const tmp = join(this.rootDir, `${SNAPSHOT_FILE}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`)
    await writeFile(tmp, JSON.stringify(snapshot), 'utf8')
    await rename(tmp, this.snapshotPath)
  }

  private eventFileFor(taskId: string): string {
    assertSafeTaskId(taskId)
    return join(this.tasksDir, `${taskId}.jsonl`)
  }

  /** Read a task's JSONL, ignoring torn/corrupt lines. Empty when absent. */
  private async readEventFile(taskId: string): Promise<ExecutionEvent[]> {
    const file = this.eventFileFor(taskId)
    if (!existsSync(file)) return []
    const text = await readFile(file, 'utf8')
    const events: ExecutionEvent[] = []
    for (const line of text.split('\n')) {
      const event = parseEventLine(line)
      if (event) events.push(event)
    }
    return events
  }

  private async readLastSeq(taskId: string): Promise<number> {
    const events = await this.readEventFile(taskId)
    return events.length > 0 ? events[events.length - 1]!.seq : 0
  }

  private async hydrateSeq(taskId: string): Promise<void> {
    if (this.hydratedSeqTasks.has(taskId)) return
    this.nextSeq.set(taskId, await this.readLastSeq(taskId))
    this.hydratedSeqTasks.add(taskId)
  }

  // -------------------------------------------------------------------------
  // HistoryStore reads (all drain the write queue first so a read can never
  // observe a half-applied state).
  // -------------------------------------------------------------------------

  async listTasks(): Promise<TaskRecord[]> {
    await this.drain()
    const snapshot = await this.readSnapshotLocked()
    return snapshot.tasks.sort((a, b) => recencyKey(b) - recencyKey(a))
  }

  async getTask(taskId: string): Promise<TaskRecord | undefined> {
    await this.drain()
    const snapshot = await this.readSnapshotLocked()
    return snapshot.tasks.find((t) => t.id === taskId)
  }

  /**
   * Synchronous bootstrap read used by the plugin entry at startup (before
   * the cordis service is provided), so task restoration never races with
   * the first dashboard request. Corrupt/absent snapshot → empty.
   */
  loadSnapshotSync(): { tasks: TaskRecord[]; pruned: Array<{ taskId: string; lastSeq: number }> } {
    if (!existsSync(this.snapshotPath)) return { tasks: [], pruned: [] }
    try {
      const parsed = JSON.parse(readFileSync(this.snapshotPath, 'utf8')) as Partial<SnapshotFile>
      if (!Array.isArray(parsed.tasks)) return { tasks: [], pruned: [] }
      return {
        tasks: parsed.tasks as TaskRecord[],
        pruned: Array.isArray(parsed.pruned) ? (parsed.pruned as Array<{ taskId: string; lastSeq: number }>) : [],
      }
    } catch {
      return { tasks: [], pruned: [] }
    }
  }

  async eventsAfter(taskId: string, after: number): Promise<EventsPage> {
    await this.drain()
    const events = await this.readEventFile(taskId)
    if (events.length === 0) {
      const snapshot = await this.readSnapshotLocked()
      const tombstone = snapshot.pruned.find((p) => p.taskId === taskId)
      if (tombstone && after < tombstone.lastSeq) return { events: [], pruned: true }
      return { events: [], pruned: false }
    }
    const firstSeq = events[0]!.seq
    const page = events.filter((e) => e.seq > after)
    const pruned = after + 1 < firstSeq
    return { events: page, pruned }
  }

  // -------------------------------------------------------------------------
  // HistoryStore writes
  // -------------------------------------------------------------------------

  async upsertTask(task: TaskRecord): Promise<void> {
    const snapshot = structuredClone(task)
    await this.enqueue(async () => {
      await this.ensureDirs()
      const current = await this.readSnapshotLocked()
      const rest = current.tasks.filter((t) => t.id !== task.id)
      await this.writeSnapshotLocked({
        v: SNAPSHOT_VERSION,
        tasks: [...rest, snapshot],
        pruned: current.pruned,
      })
    })
  }

  async append(input: AppendExecutionEvent): Promise<ExecutionEvent> {
    const event: ExecutionEvent = await this.enqueue(async () => {
      await this.ensureDirs()
      await this.hydrateSeq(input.taskId)
      const seq = (this.nextSeq.get(input.taskId) ?? 0) + 1
      this.nextSeq.set(input.taskId, seq)
      const base = { v: EXECUTION_EVENT_VERSION, seq, ts: input.ts, taskId: input.taskId } as const
      const isTaskLevel = input.kind === 'task-state' || input.kind === 'merge-decision'
      const full = (isTaskLevel
        ? { ...base, kind: input.kind, payload: input.payload }
        : { ...base, agent: input.agent, kind: input.kind, payload: input.payload }) as ExecutionEvent
      // Single line per event; an interrupted write only tears the tail line.
      await appendFile(this.eventFileFor(input.taskId), `${JSON.stringify(full)}\n`, 'utf8')
      return full
    })
    this.notify(event)
    return event
  }

  async prune(opts: PruneOptions = {}): Promise<PruneResult> {
    const maxTasks = opts.maxTasks ?? this.maxTasks
    const maxEventRows = opts.maxEventRowsPerTask ?? this.maxEventRowsPerTask
    return await this.enqueue(async () => {
      if (!existsSync(this.tasksDir) && !existsSync(this.snapshotPath)) {
        return { removedTasks: 0, removedEventRows: 0 }
      }
      await this.ensureDirs()
      const snapshot = await this.readSnapshotLocked()
      const result: PruneResult = { removedTasks: 0, removedEventRows: 0 }
      const pruned = new Map(snapshot.pruned.map((p) => [p.taskId, p.lastSeq]))

      // 1) Whole-task retention — keep the most-recent `maxTasks` summaries.
      const kept: TaskRecord[] = []
      const sorted = [...snapshot.tasks].sort((a, b) => recencyKey(b) - recencyKey(a))
      for (const task of sorted) {
        if (kept.length >= maxTasks) {
          const lastSeq = await this.readLastSeq(task.id)
          const file = this.eventFileFor(task.id)
          if (existsSync(file)) {
            await rm(file)
            if (lastSeq > 0) pruned.set(task.id, lastSeq)
            result.removedTasks += 1
          }
          continue
        }
        kept.push(task)
      }

      // 2) Horizontal per-task cap — trim each event log to its latest rows.
      for (const task of kept) {
        const file = this.eventFileFor(task.id)
        if (!existsSync(file)) continue
        const lines = (await readFile(file, 'utf8')).split('\n')
        // The final empty element after a trailing newline does not count.
        const rowCount = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
        if (rowCount <= maxEventRows) continue
        const drop = rowCount - maxEventRows
        const keptLines = lines.slice(drop)
        const tmp = join(this.tasksDir, `${task.id}.jsonl.tmp-${process.pid}-${randomBytes(4).toString('hex')}`)
        await writeFile(tmp, keptLines.join('\n'), 'utf8')
        await rename(tmp, file)
        result.removedEventRows += drop
      }

      await this.writeSnapshotLocked({
        v: SNAPSHOT_VERSION,
        tasks: kept,
        pruned: [...pruned.entries()].map(([taskId, lastSeq]) => ({ taskId, lastSeq })),
      })
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
