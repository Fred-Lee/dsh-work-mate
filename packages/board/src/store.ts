/**
 * BoardStore — durable WorkItem state + the lifecycle event stream (D6).
 *
 * Layout (HELMSMAN_HOME aware; default `~/.helmsman/board`):
 *   <root>/items.json    { schemaVersion, items[] } — authoritative snapshot,
 *                        rewritten atomically (tmp + rename) on every mutation
 *   <root>/events.jsonl  append-only lifecycle rows ({ v, ts, type, itemId,
 *                        payload }), consumed by audit / the kanban timeline
 *
 * Failure policy (deliberately the opposite of artifacts' self-healing):
 * `items.json` is the single source of truth for cards, so a corrupt or
 * unknown-schema file is reported as an explicit typed error and LEFT UNTOUCHED
 * for the user to fix. The store then refuses all reads and writes instead of
 * silently rebuilding an empty board — an empty board would look like data
 * loss and the next write would destroy the user's real file. Events are
 * best-effort on read (torn tails ignored) but a failed append still fails the
 * operation loudly, because the audit trail must not silently lose migrations.
 *
 * All mutations run through one serialized queue (single-writer assumption,
 * loopback single user) so a read-modify-write can never interleave.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { appendFile, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { HelmsmanBoardError, errorMessage } from './errors.ts'
import {
  BOARD_EVENT_VERSION,
  cloneItem,
  isAssociationType,
  isPlainObject,
  isStage,
  type BoardEvent,
  type BoardEventType,
  type EventQuery,
  type WorkItem,
} from './model.ts'

/** On-disk `items.json` schema version. */
export const BOARD_SCHEMA_VERSION = 1 as const

export const ITEMS_FILE = 'items.json'
export const EVENTS_FILE = 'events.jsonl'

/** HELMSMAN_HOME-aware default state root: `$HELMSMAN_HOME/board`, else `~/.helmsman/board`. */
export function defaultBoardRootDir(): string {
  const base = process.env.HELMSMAN_HOME ?? join(homedir(), '.helmsman')
  return join(base, 'board')
}

/** One row to append; the store stamps `v`/`ts`. */
export interface BoardEventInput {
  type: BoardEventType
  itemId: string
  payload: Record<string, unknown>
}

/**
 * Outcome of one mutation attempt.
 * - `result` is returned to the caller.
 * - `items` present ⇒ the full next item set is persisted (and becomes the
 *   in-memory state); absent ⇒ nothing changed (e.g. a refused advance).
 * - `events` are appended after the state lands.
 */
export interface MutationPlan<T> {
  result: T
  items?: WorkItem[]
  events?: BoardEventInput[]
}

export type Mutator<T> = (items: WorkItem[]) => MutationPlan<T> | Promise<MutationPlan<T>>

export interface BoardStoreOptions {
  /** State root override. @default $HELMSMAN_HOME/board, else ~/.helmsman/board */
  rootDir?: string
}

interface ItemsFile {
  schemaVersion: number
  items: WorkItem[]
}

export class BoardStore {
  readonly rootDir: string
  readonly itemsFile: string
  readonly eventsFile: string

  /** Canonical state; only `transact` swaps it. Never handed out by reference. */
  private state: WorkItem[] | null = null
  /** Sticky load failure: while set, every operation fails closed. */
  private broken: HelmsmanBoardError | null = null
  /** Monotonic event clock (seeded from the tail of events.jsonl). */
  private clock = 0
  private clockSeeded = false
  /** Serializes mutations so read-modify-write cannot interleave. */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(opts: BoardStoreOptions = {}) {
    this.rootDir = opts.rootDir ?? defaultBoardRootDir()
    this.itemsFile = join(this.rootDir, ITEMS_FILE)
    this.eventsFile = join(this.rootDir, EVENTS_FILE)
  }

  /**
   * Loads state eagerly so a corrupt file is reported at plugin boot instead of
   * on the first user action. Never throws — returns the error for logging.
   */
  warmUp(): HelmsmanBoardError | null {
    try {
      this.ensureItems()
      return null
    } catch (err) {
      return err instanceof HelmsmanBoardError
        ? err
        : new HelmsmanBoardError('STORE_UNREADABLE', errorMessage(err), { path: this.itemsFile })
    }
  }

  /** Deep copies of every card, in creation order. */
  snapshot(): WorkItem[] {
    return this.ensureItems().map(cloneItem)
  }

  /** Deep copy of one card, or `undefined` when the id is unknown. */
  find(id: string): WorkItem | undefined {
    const items = this.requireItems()
    const found = items.findIndex((item) => item.id === id)
    return found === -1 ? undefined : cloneItem(items[found]!)
  }

  /** Deep copy of one card; throws `NOT_FOUND` when the id is unknown. */
  require(id: string): WorkItem {
    const found = this.find(id)
    if (!found) throw new HelmsmanBoardError('NOT_FOUND', `unknown work item "${id}"`, { id })
    return found
  }

  /**
   * Serialized read-modify-write. The mutator receives deep copies, returns the
   * next `items` (when state changed) plus the events to append. The state file
   * is written before the events so the card snapshot — the source of truth —
   * can never lag behind the audit trail.
   */
  transact<T>(mutator: Mutator<T>): Promise<T> {
    return this.exclusive(async () => {
      const current = this.ensureItems()
      const plan = await mutator(current.map(cloneItem))
      if (plan.items) {
        await this.writeItems(plan.items)
        this.state = plan.items
      }
      if (plan.events && plan.events.length > 0) await this.appendEvents(plan.events)
      return plan.result
    })
  }

  /** Ordered lifecycle rows matching `filter` (append order === `ts` order). */
  async events(filter: EventQuery = {}): Promise<BoardEvent[]> {
    const rows = this.readEventRows()
    const wantedType = filter.type ?? filter.kind
    const out: BoardEvent[] = []
    for (const row of rows) {
      if (wantedType !== undefined && row.type !== wantedType) continue
      if (filter.itemId !== undefined && row.itemId !== filter.itemId) continue
      if (filter.since !== undefined && row.ts < filter.since) continue
      out.push(row)
    }
    // `limit` keeps the newest rows (the tail), still in append order.
    if (typeof filter.limit === 'number' && Number.isFinite(filter.limit) && filter.limit >= 0) {
      const limit = Math.floor(filter.limit)
      return out.length > limit ? out.slice(out.length - limit) : out
    }
    return out
  }

  // -- load ------------------------------------------------------------------

  private ensureItems(): WorkItem[] {
    if (this.broken) throw this.broken
    if (this.state) return this.state
    try {
      this.state = this.loadItems()
    } catch (err) {
      const failure =
        err instanceof HelmsmanBoardError
          ? err
          : new HelmsmanBoardError('STORE_UNREADABLE', errorMessage(err), { path: this.itemsFile })
      // Sticky: a broken store must never be written over.
      this.broken = failure
      throw failure
    }
    return this.state
  }

  private requireItems(): WorkItem[] {
    return this.ensureItems()
  }

  private loadItems(): WorkItem[] {
    if (!existsSync(this.itemsFile)) return []
    let raw: string
    try {
      raw = readFileSync(this.itemsFile, 'utf8')
    } catch (err) {
      throw new HelmsmanBoardError(
        'STORE_UNREADABLE',
        `cannot read ${this.itemsFile}: ${errorMessage(err)} (the file was left untouched)`,
        { path: this.itemsFile },
      )
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      throw corrupt(this.itemsFile, `it is not valid JSON (${errorMessage(err)})`)
    }
    if (!isPlainObject(parsed)) throw corrupt(this.itemsFile, 'its top level is not a JSON object')

    const version = parsed.schemaVersion
    if (typeof version !== 'number' || !Number.isFinite(version)) {
      throw corrupt(this.itemsFile, 'it has no numeric schemaVersion')
    }
    if (version !== BOARD_SCHEMA_VERSION) {
      throw new HelmsmanBoardError(
        'SCHEMA_UNSUPPORTED',
        `${this.itemsFile} uses schemaVersion ${version} but this build supports ${BOARD_SCHEMA_VERSION}; ` +
          'upgrade Helmsman or move the file aside (it was left untouched)',
        { path: this.itemsFile, schemaVersion: version, supported: BOARD_SCHEMA_VERSION },
      )
    }
    if (!Array.isArray(parsed.items)) throw corrupt(this.itemsFile, '"items" is not an array')

    const items: WorkItem[] = []
    const seen = new Set<string>()
    for (let i = 0; i < parsed.items.length; i += 1) {
      const entry: unknown = parsed.items[i]
      if (!isStoredItem(entry)) throw corrupt(this.itemsFile, `items[${i}] is not a valid WorkItem`)
      if (seen.has(entry.id)) throw corrupt(this.itemsFile, `items[${i}] duplicates id "${entry.id}"`)
      seen.add(entry.id)
      items.push(entry)
    }
    return items
  }

  // -- write -----------------------------------------------------------------

  /** Atomic snapshot rewrite (tmp + rename): a crash keeps the previous file. */
  private async writeItems(items: WorkItem[]): Promise<void> {
    const body = `${JSON.stringify({ schemaVersion: BOARD_SCHEMA_VERSION, items } satisfies ItemsFile, null, 2)}\n`
    const tmp = join(this.rootDir, `.${ITEMS_FILE}.tmp-${randomUUID().slice(0, 8)}`)
    try {
      await mkdir(this.rootDir, { recursive: true })
      await writeFile(tmp, body, 'utf8')
      await rename(tmp, this.itemsFile)
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined)
      throw new HelmsmanBoardError(
        'STORE_WRITE_FAILED',
        `cannot write ${this.itemsFile}: ${errorMessage(err)} (existing files were not modified)`,
        { path: this.itemsFile },
      )
    }
  }

  /**
   * Appends lifecycle rows in one syscall. Called only after the state file
   * landed, so a failure here means "state applied, audit trail missing": the
   * error says so explicitly to stop callers from blindly retrying a create.
   */
  private async appendEvents(events: BoardEventInput[]): Promise<void> {
    this.seedClock()
    const lines = events.map((event) => JSON.stringify(this.stamp(event))).join('\n')
    try {
      await mkdir(this.rootDir, { recursive: true })
      await appendFile(this.eventsFile, `${lines}\n`, 'utf8')
    } catch (err) {
      throw new HelmsmanBoardError(
        'EVENT_WRITE_FAILED',
        `the board change was applied but its lifecycle event could not be appended to ` +
          `${this.eventsFile}: ${errorMessage(err)}`,
        { path: this.eventsFile, applied: true },
      )
    }
  }

  /** Stamps one row with a strictly increasing epoch-ms cursor. */
  private stamp(input: BoardEventInput): BoardEvent {
    const ts = Math.max(Date.now(), this.clock + 1)
    this.clock = ts
    return { v: BOARD_EVENT_VERSION, ts, type: input.type, itemId: input.itemId, payload: input.payload }
  }

  /**
   * Seeds the event clock from the newest row already on disk so `ts` stays a
   * usable `since` cursor across restarts. Best effort: an unreadable stream
   * just means the first new row may tie with historical rows.
   */
  private seedClock(): void {
    if (this.clockSeeded) return
    this.clockSeeded = true
    for (const row of this.readEventRows()) {
      if (row.ts > this.clock) this.clock = row.ts
    }
  }

  private readEventRows(): BoardEvent[] {
    if (!existsSync(this.eventsFile)) return []
    let text: string
    try {
      text = readFileSync(this.eventsFile, 'utf8')
    } catch (err) {
      console.warn(`[helmsman/board] cannot read ${this.eventsFile}: ${errorMessage(err)}`)
      return []
    }
    const rows: BoardEvent[] = []
    for (const line of text.split('\n')) {
      const row = parseEventLine(line)
      if (row) rows.push(row)
    }
    return rows
  }

  /** In-process mutex so concurrent mutators serialize (single-writer, D6). */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task, task)
    this.chain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
}

function corrupt(path: string, why: string): HelmsmanBoardError {
  return new HelmsmanBoardError(
    'STORE_CORRUPT',
    `${path} is corrupt (${why}); it was left untouched for you to repair or move aside`,
    { path },
  )
}

/** Tolerant row parser: a torn tail from a crash mid-append is simply skipped. */
function parseEventLine(line: string): BoardEvent | null {
  const text = line.trim()
  if (text === '') return null
  try {
    const raw = JSON.parse(text) as Partial<BoardEvent>
    if (raw.v !== BOARD_EVENT_VERSION) return null
    if (typeof raw.ts !== 'number' || typeof raw.type !== 'string' || typeof raw.itemId !== 'string') return null
    if (!isPlainObject(raw.payload)) return null
    return raw as BoardEvent
  } catch {
    return null
  }
}

/**
 * Structural validation of a persisted card. Strict on the fields the service
 * and UI branch on (id/title/stage/timestamps/collections) and lenient on free
 * metadata, so a hand-edited file is either fully trusted or explicitly
 * rejected — never half-read.
 */
function isStoredItem(value: unknown): value is WorkItem {
  if (!isPlainObject(value)) return false
  const v = value
  if (typeof v.id !== 'string' || v.id.trim() === '') return false
  if (typeof v.title !== 'string') return false
  if (!isStage(v.stage)) return false
  if (!isFiniteNumber(v.createdAt) || !isFiniteNumber(v.updatedAt)) return false
  if (!isPlainObject(v.repoScope)) return false
  if (v.scope !== undefined && !isPlainObject(v.scope)) return false
  if (!isPlainObject(v.gates)) return false
  if (!isPlainObject(v.summary) || typeof v.summary.text !== 'string') return false
  if (!Array.isArray(v.associations) || !v.associations.every(isStoredAssociation)) return false
  if (!Array.isArray(v.runs) || !v.runs.every(isStoredRunRef)) return false
  return true
}

function isStoredAssociation(value: unknown): boolean {
  if (!isPlainObject(value)) return false
  return isAssociationType(value.type) && typeof value.refId === 'string' && isFiniteNumber(value.at)
}

function isStoredRunRef(value: unknown): boolean {
  if (!isPlainObject(value)) return false
  return typeof value.taskId === 'string' && isFiniteNumber(value.startedAt)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
