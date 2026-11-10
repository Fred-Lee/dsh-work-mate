/**
 * Derived proposal metrics (change `add-proposal-metrics`, design D2/D5).
 *
 * Pure derivation: the event log and the proposal records are the only inputs, and
 * nothing is persisted — there is no second copy of the truth to drift. Definitions
 * live in the change's design doc; the table below is the contract these functions
 * implement.
 */
import { PROPOSAL_STATES, type ProposalState } from './state-machine.ts'
import type { ProposalEvent, EventActor } from './events.ts'
import type { Proposal } from './store.ts'

const stateIndex = (state: ProposalState): number => PROPOSAL_STATES.indexOf(state)

const openBlockers = (proposal: Proposal): number =>
  (proposal.blockers ?? []).filter((blocker) => blocker.status === 'open').length

export interface GateFailure {
  gate: string
  to?: ProposalState
  reason?: string
  at: string
}

export interface ProposalMetrics {
  id: string
  status: ProposalState
  archived: boolean
  /** First event → the transition into `archived`; absent while not archived. */
  cycleTimeMs?: number
  /** Only the states this proposal actually sat in. */
  timeInStateMs: Partial<Record<ProposalState, number>>
  /** Backward transitions (a state was re-entered) — the rework signal. */
  reworkCount: number
  /** Reached `merging` or beyond without a single backward move (first-pass merge). */
  firstPass: boolean
  transitions: number
  gateFailureCount: number
  gateFailures: GateFailure[]
  blockers: number
  openBlockers: number
  decisions: number
  /** Decisions that overturn an earlier one (`supersedes`). */
  supersededDecisions: number
  actorShare: Record<EventActor, number>
}

/** One row per proposal, for the control room (no N+1 requests). */
export interface ProposalMetricRow {
  id: string
  title: string
  status: ProposalState
  archived: boolean
  /** Deliberately abandoned proposals are history, not process samples. */
  abandoned: boolean
  /** Dwell time in the state the proposal currently sits in. */
  currentStateMs: number
  cycleTimeMs?: number
  reworkCount: number
  gateFailureCount: number
  openBlockers: number
  decisions: number
  /** Gate approvals recorded (change `add-approval-records`). */
  approvals: number
}

export interface AggregateMetrics {
  proposals: number
  byState: Record<ProposalState, number>
  /** Mean per-proposal time in each state, over proposals that sat there. */
  averageTimeInStateMs: Partial<Record<ProposalState, number>>
  cycleTimeMedianMs?: number
  archived7d: number
  archived30d: number
  /** Share of proposals that bounced backward at least once. */
  reworkRate: number
  /** Share of proposals that reached merging+ without a backward move (first-pass merge). */
  firstPassRate: number
  gateFailureRanking: Array<{ gate: string; count: number }>
  actorShare: Record<EventActor, number>
  /** Per-proposal projection: the control room renders this in one request. */
  perProposal: ProposalMetricRow[]
  events: number
  skippedLines: number
}

const emptyActorShare = (): Record<EventActor, number> => ({ agent: 0, human: 0, system: 0 })

const byTime = (a: ProposalEvent, b: ProposalEvent): number => {
  const left = Date.parse(a.at)
  const right = Date.parse(b.at)
  if (Number.isNaN(left) || Number.isNaN(right)) return 0
  return left - right
}

/** Between two timestamps; never negative (out-of-order clocks must not poison sums). */
const span = (from: string, to: string): number => Math.max(0, Date.parse(to) - Date.parse(from))

/**
 * One proposal's metrics. `now` is injectable so tests do not depend on wall time.
 */
export function proposalMetrics(
  proposal: Proposal,
  events: readonly ProposalEvent[],
  now: () => Date = () => new Date(),
): ProposalMetrics {
  const own = events.filter((event) => event.proposalId === proposal.id).slice().sort(byTime)
  const metrics: ProposalMetrics = {
    id: proposal.id,
    status: proposal.status,
    archived: proposal.status === 'archived',
    timeInStateMs: {},
    reworkCount: 0,
    firstPass: false,
    transitions: 0,
    gateFailureCount: 0,
    gateFailures: [],
    blockers: (proposal.blockers ?? []).length,
    openBlockers: openBlockers(proposal),
    decisions: (proposal.decisions ?? []).length,
    supersededDecisions: (proposal.decisions ?? []).filter((entry) => entry.supersedes !== undefined).length,
    actorShare: emptyActorShare(),
  }

  // Time in state: anchor on createdAt, then walk the transition events. A
  // `gate-failed` carries no state change and only contributes to the ranking.
  let anchorAt: string = proposal.createdAt
  let anchorState: ProposalState = 'draft'
  for (const event of own) {
    if (event.kind === 'gate-failed') {
      metrics.gateFailureCount += 1
      metrics.gateFailures.push({
        gate: event.gate ?? (event.to ?? 'unknown'),
        ...(event.to !== undefined ? { to: event.to } : {}),
        ...(event.reason !== undefined ? { reason: event.reason } : {}),
        at: event.at,
      })
      continue
    }
    metrics.transitions += 1
    metrics.actorShare[event.actor] += 1
    const from: ProposalState = event.from ?? anchorState
    const to: ProposalState | undefined = event.to
    metrics.timeInStateMs[from] = (metrics.timeInStateMs[from] ?? 0) + span(anchorAt, event.at)
    if (to !== undefined && stateIndex(to) < stateIndex(from)) metrics.reworkCount += 1
    anchorAt = event.at
    anchorState = to ?? from
    if (to === 'archived') {
      const first = own[0]
      if (first !== undefined) metrics.cycleTimeMs = span(first.at, event.at)
    }
  }
  metrics.timeInStateMs[anchorState] = (metrics.timeInStateMs[anchorState] ?? 0) + span(anchorAt, now().toISOString())
  metrics.firstPass = metrics.reworkCount === 0 && stateIndex(proposal.status) >= stateIndex('merging')

  return metrics
}

/** Median of a non-empty numeric list (upper median for even counts). */
function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted[mid]
}

const DAY_MS = 24 * 60 * 60 * 1000

export function aggregateMetrics(
  proposals: readonly Proposal[],
  events: readonly ProposalEvent[],
  options: { now?: () => Date; skippedLines?: number } = {},
): AggregateMetrics {
  const now = options.now ?? ((): Date => new Date())
  const nowMs = now().getTime()

  const byState = Object.fromEntries(PROPOSAL_STATES.map((state) => [state, 0])) as Record<ProposalState, number>
  const totalByState: Partial<Record<ProposalState, number>> = {}
  const countedByState: Partial<Record<ProposalState, number>> = {}
  const cycleTimes: number[] = []
  let reworked = 0
  let firstPassed = 0
  const actorShare = emptyActorShare()
  const gateCounts = new Map<string, number>()
  let archived7d = 0
  let archived30d = 0
  const perProposal: ProposalMetricRow[] = []

  for (const event of events) {
    if (event.kind === 'gate-failed') {
      const gate = event.gate ?? (event.to ?? 'unknown')
      gateCounts.set(gate, (gateCounts.get(gate) ?? 0) + 1)
    }
    if (event.kind === 'transition') actorShare[event.actor] += 1
  }

  // 「已终止」只认 abandon 落盘形态（status=archived + abandonedAt）；
  // abandonedAt 残留但已回到活跃状态的提案不连坐（真机 2026-11-11 team-e2e-final）。
  const activeProposals = proposals.filter(
    (proposal) => proposal.abandonedAt === undefined || proposal.status !== 'archived',
  )
  for (const proposal of activeProposals) {
    byState[proposal.status] += 1
    const metrics = proposalMetrics(proposal, events, now)
    for (const [state, ms] of Object.entries(metrics.timeInStateMs) as Array<[ProposalState, number]>) {
      totalByState[state] = (totalByState[state] ?? 0) + ms
      countedByState[state] = (countedByState[state] ?? 0) + 1
    }
    perProposal.push({
      id: proposal.id,
      title: proposal.title,
      status: proposal.status,
      archived: metrics.archived,
      // 与 activeProposals 同判据：只有真终止的提案才标 abandoned（控制台表格按它过滤）。
      abandoned: proposal.abandonedAt !== undefined && proposal.status === 'archived',
      currentStateMs: metrics.timeInStateMs[proposal.status] ?? 0,
      ...(metrics.cycleTimeMs !== undefined ? { cycleTimeMs: metrics.cycleTimeMs } : {}),
      reworkCount: metrics.reworkCount,
      gateFailureCount: metrics.gateFailureCount,
      openBlockers: metrics.openBlockers,
      decisions: metrics.decisions,
      approvals: (proposal.approvals ?? []).length,
    })
    if (metrics.reworkCount > 0) reworked += 1
    if (metrics.firstPass) firstPassed += 1
    if (metrics.cycleTimeMs !== undefined) cycleTimes.push(metrics.cycleTimeMs)
    for (const event of events) {
      if (event.proposalId !== proposal.id || event.kind !== 'transition' || event.to !== 'archived') continue
      const age = nowMs - Date.parse(event.at)
      if (age <= 7 * DAY_MS) archived7d += 1
      if (age <= 30 * DAY_MS) archived30d += 1
    }
  }

  const averageTimeInStateMs: Partial<Record<ProposalState, number>> = {}
  for (const state of PROPOSAL_STATES) {
    const total = totalByState[state]
    const count = countedByState[state]
    if (total !== undefined && count !== undefined && count > 0) {
      averageTimeInStateMs[state] = Math.round(total / count)
    }
  }

  return {
    proposals: activeProposals.length,
    byState,
    averageTimeInStateMs,
    ...(median(cycleTimes) !== undefined ? { cycleTimeMedianMs: median(cycleTimes) } : {}),
    archived7d,
    archived30d,
    reworkRate: proposals.length === 0 ? 0 : reworked / proposals.length,
    firstPassRate: proposals.length === 0 ? 0 : firstPassed / proposals.length,
    gateFailureRanking: [...gateCounts.entries()]
      .map(([gate, count]) => ({ gate, count }))
      .sort((a, b) => b.count - a.count || a.gate.localeCompare(b.gate)),
    actorShare,
    perProposal,
    events: events.length,
    skippedLines: options.skippedLines ?? 0,
  }
}
