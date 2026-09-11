/**
 * AuditJournal — append-only JSONL journal of gated decisions and run
 * completions (design D3). Real hosts write `~/.helmsman/audit/audit.jsonl`
 * (HELMSMAN_HOME aware) and fsync each gated decision BEFORE it is allowed to
 * produce a side effect — a journal write failure therefore aborts the gated
 * operation (fail-closed). Engine unit tests use the in-memory journal.
 *
 * Two entry families:
 *  - `decision`  — every gated decision: granted (token accepted, before the
 *                  effect), denied (refused at the gate), auto-grant.
 *                  A decision is journaled at two distinct stages (see
 *                  `AuditDecisionEntry.stage`): `decide` — a human approves or
 *                  denies a pending request in the gate's phase 2 (so an
 *                  operator denial — or a grant that is never executed — is
 *                  itself an audit record), and `enforce` — the engine records
 *                  the outcome of an execution attempt or an auto-grant
 *                  immediately before a protected side effect.
 *  - `run-completion` — the outcome of a merge execution or of a run reaching
 *                  a terminal state (completed / cancelled / failed, with the
 *                  precise terminal state in `detail.status`), including merge
 *                  resolution payloads and real conflict file lists
 *                  (governance-grade run history + DoD evidence).
 *
 * The journal is read-only over the REST surface (`GET /api/audit`); nothing
 * ever edits or deletes an entry.
 */
import { open, mkdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AuditSource, GateOp } from '../gate/gate.ts'

export const AUDIT_VERSION = 1 as const

export type AuditDecision = 'granted' | 'denied' | 'auto-grant'

/** A gated decision, durably fsynced before the protected side effect runs. */
export interface AuditDecisionEntry {
  v: typeof AUDIT_VERSION
  ts: number
  type: 'decision'
  operation: GateOp
  /** Canonical scope key (op + normalized task/agent/group ids). */
  scope: string
  source: AuditSource
  decision: AuditDecision
  /** Task id when the decision concerns a fleet task (queryable). */
  taskId?: string
  /** Machine-readable gate reason when decision === 'denied'. */
  reason?: string
  /** Human-readable context when the decision carries one. */
  message?: string
  /**
   * Stage at which the decision was recorded. `decide` = a human (or headless
   * caller) approved/denied a pending request in phase 2 of the gate; `enforce`
   * = the engine validated a confirmation token (or auto-granted) immediately
   * before the protected side effect. Absent on legacy entries — treat a
   * missing stage as `enforce`.
   */
  stage?: 'decide' | 'enforce'
  /** The pending request id this decision settles (present on `decide` stage). */
  approvalId?: string
}

/**
 * Outcome of a gated merge execution or of an ungated run reaching a terminal
 * state. Merge executions report `completed` (all requested agents applied) or
 * `aborted` (real conflicts, base untouched). Runs map their terminal state:
 * COMPLETED → `completed`, CANCELLED → `cancelled`, PARTIAL_FAILED /
 * ALL_FAILED → `failed`. The precise terminal state always lives in
 * `detail.status`.
 */
export interface AuditCompletionEntry {
  v: typeof AUDIT_VERSION
  ts: number
  type: 'run-completion'
  operation: GateOp | 'run'
  scope: string
  /** Attribution for gated executions (runs reaching terminal have none). */
  source?: AuditSource
  taskId?: string
  outcome: 'completed' | 'aborted' | 'cancelled' | 'failed' | 'denied'
  /** Free-form detail — merge resolutions/conflict lists/results (JSON-safe). */
  detail?: Record<string, unknown>
  error?: string
}

export type AuditEntry = AuditDecisionEntry | AuditCompletionEntry

export interface AuditQuery {
  op?: GateOp
  taskId?: string
  from?: number
  to?: number
}

export interface AuditJournal {
  readonly kind: 'memory' | 'jsonl'
  /**
   * Persist a gated decision and fsync BEFORE returning. Throws
   * `AuditUnavailableError` when the journal cannot be written — the caller
   * MUST then abort the gated operation.
   */
  recordDecision(entry: AuditDecisionEntry): Promise<void>
  /** Persist a run-completion entry (after the effect). */
  recordCompletion(entry: AuditCompletionEntry): Promise<void>
  /** Ordered (append order) filtered read — the ONLY read surface. */
  query(filter?: AuditQuery): Promise<AuditEntry[]>
}

export class AuditUnavailableError extends Error {
  readonly code = 'audit-unavailable'
  constructor(message: string) {
    super(message)
    this.name = 'AuditUnavailableError'
  }
}

/** HELMSMAN_HOME-aware default journal file path. */
export function defaultAuditPath(): string {
  const base = process.env.HELMSMAN_HOME ?? join(homedir(), '.helmsman')
  return join(base, 'audit', 'audit.jsonl')
}

function matches(entry: AuditEntry, filter: AuditQuery): boolean {
  if (filter.op !== undefined && entry.operation !== filter.op) return false
  if (filter.taskId !== undefined && entry.taskId !== filter.taskId) return false
  if (filter.from !== undefined && entry.ts < filter.from) return false
  if (filter.to !== undefined && entry.ts > filter.to) return false
  return true
}

/**
 * Appends one JSON line and fsyncs before resolving. Throws
 * `AuditUnavailableError` for any IO failure so the caller can fail closed.
 */
async function appendLineDurable(file: string, line: string): Promise<void> {
  try {
    await mkdir(dirname(file), { recursive: true })
    const handle = await open(file, 'a')
    try {
      await handle.writeFile(`${line}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (err) {
    throw new AuditUnavailableError(
      `audit journal write failed at ${file}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

function parseLine(line: string): AuditEntry | null {
  const text = line.trim()
  if (!text) return null
  try {
    const raw = JSON.parse(text) as Partial<AuditEntry> & { v?: number }
    if (raw.v !== AUDIT_VERSION || (raw.type !== 'decision' && raw.type !== 'run-completion')) return null
    if (typeof raw.ts !== 'number' || typeof raw.operation !== 'string' || typeof raw.scope !== 'string') return null
    return raw as AuditEntry
  } catch {
    return null // torn tail from a crash mid-append — never blocks a replay
  }
}

export class JsonlAuditJournal implements AuditJournal {
  readonly kind = 'jsonl' as const
  readonly file: string
  constructor(file: string = defaultAuditPath()) {
    this.file = file
  }

  async recordDecision(entry: AuditDecisionEntry): Promise<void> {
    await appendLineDurable(this.file, JSON.stringify(entry))
  }

  async recordCompletion(entry: AuditCompletionEntry): Promise<void> {
    // Post-effect best-effort durability: the gated decision was already
    // fsynced, so a completion failure cannot be rolled back — surface loudly.
    try {
      await appendLineDurable(this.file, JSON.stringify(entry))
    } catch (err) {
      console.error(`[helmsman/audit] completion record failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async query(filter: AuditQuery = {}): Promise<AuditEntry[]> {
    if (!existsSync(this.file)) return []
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch {
      return []
    }
    const entries: AuditEntry[] = []
    for (const line of text.split('\n')) {
      const entry = parseLine(line)
      if (entry && matches(entry, filter)) entries.push(entry)
    }
    return entries
  }
}

/** Engine/test seam: keeps entries in memory, mirrors jsonl semantics. */
export class MemoryAuditJournal implements AuditJournal {
  readonly kind = 'memory' as const
  private readonly entries: AuditEntry[] = []
  /**
   * Test toggle for the fail-closed requirement: when true every write throws
   * `AuditUnavailableError` (simulates an unwritable journal directory).
   */
  failWrites = false

  private async guard(): Promise<void> {
    if (this.failWrites) {
      throw new AuditUnavailableError('audit journal write failed (simulated unwritable directory)')
    }
  }

  async recordDecision(entry: AuditDecisionEntry): Promise<void> {
    await this.guard()
    this.entries.push(entry)
  }

  async recordCompletion(entry: AuditCompletionEntry): Promise<void> {
    await this.guard()
    this.entries.push(entry)
  }

  async query(filter: AuditQuery = {}): Promise<AuditEntry[]> {
    return this.entries.filter((e) => matches(e, filter))
  }
}
