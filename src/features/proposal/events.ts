/**
 * Proposal event log (change `add-proposal-metrics`): one append-only JSONL file
 * next to `proposals.json`, holding the process facts the aggregate record cannot
 * express — every state transition, and every gate that refused one.
 *
 * Why a separate file instead of a `history[]` inside `proposals.json` (design D1):
 * migration is append-only while the aggregate store is read-modify-write under
 * an atomic tmp+rename with fail-closed corruption handling. Keeping them apart
 * means a damaged log only loses history, and a damaged aggregate still fails
 * closed exactly as before. Torn trailing lines (the normal crash shape of an
 * append) are tolerated on read; the count is reported so callers can tell.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ProposalStore } from './store.ts'
import type { ProposalState } from './state-machine.ts'

/**
 * Who caused a transition: the agent's tool call, a human acting through the
 * panel/API, or the plugin itself. The agent/human split is the one the SDLC
 * measurement layer asks for by name ("who asked for what, what the agent
 * produced, and who approved it").
 */
export type EventActor = 'agent' | 'human' | 'system'

export interface ProposalEvent {
  /** ISO timestamp. */
  at: string
  proposalId: string
  /**
   * `transition` = a state change happened; `gate-failed` = one was refused;
   * `band-breach` = a control band was left; `approval` = a human/system crossed
   * a gated state (change `add-approval-records`).
   */
  kind:
    | 'transition'
    | 'gate-failed'
    | 'band-breach'
    | 'approval'
    | 'decision'
    // 历史 kind：团队执行器已移除（change `remove-team-executor`），但 events.jsonl
    // 是 append-only 事实流，旧行必须继续可读，否则指标会把它们算成非法行。
    | 'team-dispatch'
    | 'team-settled'
    | 'team-run'
    // 任务层自己的事实（创建/指派/停止/回答），由 `TaskServiceImpl` 写入。
    | 'task-settled'
    | 'advance-scan'
  from?: ProposalState
  to?: ProposalState
  actor: EventActor
  /** Gate name for `gate-failed` (e.g. `branch-merged`, `review-gate`). */
  gate?: string
  /** Readable refusal reason, forwarded from the error the caller still receives. */
  reason?: string
  /** Extra step-level detail (archive orchestration summaries). */
  detail?: string
  /** `band-breach`: which metric left its band. */
  metric?: string
  /** `band-breach`: the tier the deviation reached. */
  tier?: 'log' | 'diagnose' | 'propose'
  /** `band-breach` numbers: current sample mean, baseline mean, baseline σ. */
  current?: number
  baseline?: number
  sigma?: number
  /** `approval`: which gate was crossed and how. */
  decision?: 'approve' | 'reject'
  /** `decision`: the judgement layer's node, action and provider facts. */
  node?: string
  action?: string
  choice?: string
  certainty?: number
  provider?: string
  samples?: number
  threshold?: number
  latencyMs?: number
  degraded?: boolean
  /** `decision`: the answer came from the cache instead of a fresh call. */
  cached?: boolean
  /** `team-*`: run/task/dispatch identity and terminal status. */
  runId?: string
  taskId?: string
  dispatchId?: string
  /**
   * `task-settled`：任务动作名（task-create / task-assign / task-retry / task-stop /
   * task-reopen / task-reply）。kind 固定为 task-settled 以免破坏 append-only 事实流，
   * 动作放在这里——面板与审计按它区分六种任务动作。
   */
  status?: string
}

export interface EventReadResult {
  events: ProposalEvent[]
  /** Lines that could not be parsed (torn tail, partial write) — tolerated, never thrown. */
  skippedLines: number
}

export interface EventLogOptions {
  /** Overrides `$DSH_HOME` entirely (tests / embedding). */
  homeRoot?: string
  /** Subdirectory name under the DSH home, from `Config.workmateHome`. */
  subdir: string
}

const isEvent = (value: unknown): value is ProposalEvent => {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record['at'] === 'string' &&
    typeof record['proposalId'] === 'string' &&
    (record['kind'] === 'transition' ||
      record['kind'] === 'gate-failed' ||
      record['kind'] === 'team-dispatch' ||
      record['kind'] === 'team-settled' ||
      record['kind'] === 'team-run' ||
      record['kind'] === 'task-settled' ||
      record['kind'] === 'advance-scan' ||
      record['kind'] === 'band-breach' ||
      record['kind'] === 'approval' ||
      record['kind'] === 'decision')
  )
}

export class EventLog {
  readonly file: string
  private chain: Promise<unknown> = Promise.resolve()

  constructor(options: EventLogOptions) {
    this.file = join(new ProposalStore(options).rootDir, 'events.jsonl')
  }

  paths(): { file: string } {
    return { file: this.file }
  }

  /** Append one event. Serialized in-process so concurrent calls cannot interleave. */
  async append(event: ProposalEvent): Promise<void> {
    const run = this.chain.then(async () => {
      // The log may be the first thing in the store directory (a refused first
      // transition, say), so create it before appending rather than assuming
      // `proposals.json` got there first.
      await mkdir(dirname(this.file), { recursive: true })
      await appendFile(this.file, `${JSON.stringify(event)}\n`, 'utf8')
    })
    this.chain = run.catch(() => undefined)
    return run
  }

  /** Missing file reads as "no events yet"; unparsable lines are skipped, not thrown. */
  async read(): Promise<EventReadResult> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return { events: [], skippedLines: 0 }
      throw error
    }
    const events: ProposalEvent[] = []
    let skippedLines = 0
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      try {
        const parsed: unknown = JSON.parse(line)
        if (isEvent(parsed)) events.push(parsed)
        else skippedLines += 1
      } catch {
        skippedLines += 1
      }
    }
    return { events, skippedLines }
  }

  /** Events of one proposal, in file order (append order = chronological). */
  async listFor(proposalId: string): Promise<ProposalEvent[]> {
    const { events } = await this.read()
    return events.filter((event) => event.proposalId === proposalId)
  }
}

interface NodeError extends Error {
  code?: string
}

function isNodeError(error: unknown): error is NodeError {
  return error instanceof Error && typeof (error as NodeError).code === 'string'
}
