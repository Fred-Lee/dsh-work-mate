import { describe, expect, it } from 'vitest'
import { aggregateMetrics, proposalMetrics } from './metrics.ts'
import type { ProposalEvent } from './events.ts'
import type { Proposal } from './store.ts'

const NOW = new Date('2026-10-05T12:00:00.000Z')
const now = (): Date => NOW

const proposal = (overrides: Partial<Proposal> = {}): Proposal => ({
  id: 'p1',
  title: 'p1',
  status: 'proposing',
  projects: [],
  commits: [],
  openspecChangeId: 'p1',
  createdAt: '2026-10-05T00:00:00.000Z',
  updatedAt: '2026-10-05T00:00:00.000Z',
  ...overrides,
})

const transition = (overrides: Partial<ProposalEvent> = {}): ProposalEvent => ({
  at: '2026-10-05T00:00:00.000Z',
  proposalId: 'p1',
  kind: 'transition',
  from: 'draft',
  to: 'proposing',
  actor: 'agent',
  ...overrides,
})

describe('proposalMetrics', () => {
  it('splits dwell time across the states a proposal actually sat in', () => {
    const events = [
      transition({ at: '2026-10-05T01:00:00.000Z', from: 'draft', to: 'proposing' }),
      transition({ at: '2026-10-05T03:00:00.000Z', from: 'proposing', to: 'reviewing', actor: 'human' }),
    ]
    const metrics = proposalMetrics(proposal({ status: 'reviewing' }), events, now)

    expect(metrics.timeInStateMs['draft']).toBe(60 * 60 * 1000)
    expect(metrics.timeInStateMs['proposing']).toBe(2 * 60 * 60 * 1000)
    // Open state counts up to `now` (03:00 → 12:00).
    expect(metrics.timeInStateMs['reviewing']).toBe(9 * 60 * 60 * 1000)
    expect(metrics.transitions).toBe(2)
    expect(metrics.actorShare).toEqual({ agent: 1, human: 1, system: 0 })
    expect(metrics.cycleTimeMs).toBeUndefined()
    expect(metrics.archived).toBe(false)
  })

  it('counts backward moves as rework and forward-only progress as first pass', () => {
    const events = [
      transition({ at: '2026-10-05T01:00:00.000Z', from: 'draft', to: 'proposing' }),
      transition({ at: '2026-10-05T02:00:00.000Z', from: 'proposing', to: 'reviewing' }),
      transition({ at: '2026-10-05T03:00:00.000Z', from: 'reviewing', to: 'proposing' }),
      transition({ at: '2026-10-05T04:00:00.000Z', from: 'proposing', to: 'reviewing' }),
      transition({ at: '2026-10-05T05:00:00.000Z', from: 'reviewing', to: 'ready' }),
      transition({ at: '2026-10-05T06:00:00.000Z', from: 'ready', to: 'implementing' }),
      transition({ at: '2026-10-05T07:00:00.000Z', from: 'implementing', to: 'merging' }),
    ]
    const reworked = proposalMetrics(proposal({ status: 'merging' }), events, now)
    expect(reworked.reworkCount).toBe(1)
    expect(reworked.firstPass).toBe(false)

    const clean = proposalMetrics(
      proposal({ status: 'merging' }),
      events.filter((event) => event.at !== '2026-10-05T03:00:00.000Z' && event.at !== '2026-10-05T04:00:00.000Z'),
      now,
    )
    expect(clean.reworkCount).toBe(0)
    expect(clean.firstPass).toBe(true)
  })

  it('derives cycle time from the first event to the archive transition', () => {
    const events = [
      transition({ at: '2026-10-05T01:00:00.000Z', from: 'draft', to: 'proposing' }),
      transition({ at: '2026-10-05T04:00:00.000Z', from: 'archiving', to: 'archived', actor: 'human' }),
    ]
    const metrics = proposalMetrics(proposal({ status: 'archived' }), events, now)

    expect(metrics.archived).toBe(true)
    expect(metrics.cycleTimeMs).toBe(3 * 60 * 60 * 1000)
  })

  it('collects gate refusals with their gate name and keeps them out of the state walk', () => {
    const events = [
      transition({ at: '2026-10-05T01:00:00.000Z', from: 'draft', to: 'proposing' }),
      {
        at: '2026-10-05T02:00:00.000Z',
        proposalId: 'p1',
        kind: 'gate-failed' as const,
        to: 'reviewing' as const,
        actor: 'agent' as const,
        gate: 'proposal-branch',
        reason: 'proposal branch not found',
      },
    ]
    const metrics = proposalMetrics(proposal(), events, now)

    expect(metrics.transitions).toBe(1)
    expect(metrics.gateFailureCount).toBe(1)
    expect(metrics.gateFailures).toEqual([
      { gate: 'proposal-branch', to: 'reviewing', reason: 'proposal branch not found', at: '2026-10-05T02:00:00.000Z' },
    ])
    // Refusals do not extend dwell time: proposing still runs 01:00 → now.
    expect(metrics.timeInStateMs['proposing']).toBe(11 * 60 * 60 * 1000)
  })

  it('reads blockers, open blockers and superseded decisions off the record', () => {
    const metrics = proposalMetrics(
      proposal({
        blockers: [
          { id: 'b1', question: 'q', tried: 't', status: 'open', at: '2026-10-05T00:00:00.000Z' },
          { id: 'b2', question: 'q', tried: 't', status: 'resolved', at: '2026-10-05T00:00:00.000Z' },
        ],
        decisions: [
          { id: 'd1', decision: 'a', rationale: 'r', at: '2026-10-05T00:00:00.000Z' },
          { id: 'd2', decision: 'b', rationale: 'r', supersedes: 'd1', at: '2026-10-05T00:00:00.000Z' },
        ],
      }),
      [],
      now,
    )

    expect(metrics.blockers).toBe(2)
    expect(metrics.openBlockers).toBe(1)
    expect(metrics.decisions).toBe(2)
    expect(metrics.supersededDecisions).toBe(1)
  })

  it('never reports negative dwell time when a clock steps backwards', () => {
    const events = [transition({ at: '2026-10-05T11:00:00.000Z', from: 'draft', to: 'proposing' })]
    const metrics = proposalMetrics(proposal(), events, () => new Date('2026-10-05T10:00:00.000Z'))

    expect(metrics.timeInStateMs['proposing']).toBe(0)
  })
})

describe('aggregateMetrics', () => {
  const archived = (id: string, at: string): ProposalEvent => ({
    at,
    proposalId: id,
    kind: 'transition',
    from: 'archiving',
    to: 'archived',
    actor: 'human',
  })

  it('aggregates counts, medians, ranking and rates across proposals', () => {
    const proposals = [
      proposal({ id: 'p1', status: 'archived', createdAt: '2026-10-03T00:00:00.000Z' }),
      proposal({ id: 'p2', status: 'reviewing' }),
      proposal({ id: 'p3', status: 'merging' }),
    ]
    const events: ProposalEvent[] = [
      transition({ proposalId: 'p1', at: '2026-10-03T01:00:00.000Z', from: 'draft', to: 'proposing' }),
      archived('p1', '2026-10-03T05:00:00.000Z'),
      { at: '2026-10-04T00:00:00.000Z', proposalId: 'p2', kind: 'gate-failed', to: 'reviewing', actor: 'agent', gate: 'proposal-branch', reason: 'missing' },
      { at: '2026-10-04T01:00:00.000Z', proposalId: 'p2', kind: 'gate-failed', to: 'reviewing', actor: 'agent', gate: 'proposal-branch', reason: 'missing' },
      { at: '2026-10-04T02:00:00.000Z', proposalId: 'p3', kind: 'gate-failed', to: 'merging', actor: 'agent', gate: 'wiki-coverage', reason: 'missing' },
      transition({ proposalId: 'p2', at: '2026-10-04T03:00:00.000Z', from: 'ready', to: 'implementing', actor: 'human' }),
      transition({ proposalId: 'p2', at: '2026-10-04T04:00:00.000Z', from: 'implementing', to: 'ready' }),
      transition({ proposalId: 'p3', at: '2026-10-04T05:00:00.000Z', from: 'merging', to: 'archiving' }),
      transition({ proposalId: 'p3', at: '2026-10-04T06:00:00.000Z', from: 'archiving', to: 'archived', actor: 'human' }),
    ]
    const metrics = aggregateMetrics(proposals, events, { now, skippedLines: 1 })

    expect(metrics.proposals).toBe(3)
    expect(metrics.byState['archived']).toBe(1)
    expect(metrics.byState['reviewing']).toBe(1)
    expect(metrics.byState['merging']).toBe(1)
    expect(metrics.gateFailureRanking).toEqual([
      { gate: 'proposal-branch', count: 2 },
      { gate: 'wiki-coverage', count: 1 },
    ])
    expect(metrics.archived7d).toBe(2)
    expect(metrics.archived30d).toBe(2)
    // p2 bounced implementing→ready, p1/p3 did not.
    expect(metrics.reworkRate).toBeCloseTo(1 / 3)
    expect(metrics.actorShare).toEqual({ agent: 3, human: 3, system: 0 })
    // Cycle times: 4h (p1) and 1h (p3) → upper median 4h.
    expect(metrics.cycleTimeMedianMs).toBe(4 * 60 * 60 * 1000)
    expect(metrics.events).toBe(events.length)
    expect(metrics.skippedLines).toBe(1)
    // p1 (archived) and p3 (merging) never bounced back; p2 did.
    expect(metrics.firstPassRate).toBeCloseTo(2 / 3)
  })

  it('reports zeroed rates for an empty store', () => {
    const metrics = aggregateMetrics([], [], { now })

    expect(metrics.proposals).toBe(0)
    expect(metrics.reworkRate).toBe(0)
    expect(metrics.firstPassRate).toBe(0)
    expect(metrics.cycleTimeMedianMs).toBeUndefined()
    expect(metrics.gateFailureRanking).toEqual([])
    expect(metrics.averageTimeInStateMs).toEqual({})
  })

  it('averages dwell time per state across the proposals that sat there', () => {
    const proposals = [proposal({ id: 'p1' }), proposal({ id: 'p2' })]
    const events: ProposalEvent[] = [
      transition({ proposalId: 'p1', at: '2026-10-05T02:00:00.000Z' }),
      transition({ proposalId: 'p2', at: '2026-10-05T04:00:00.000Z' }),
    ]
    const metrics = aggregateMetrics(proposals, events, { now })

    // p1 sat in draft 2h, p2 4h → mean 3h.
    expect(metrics.averageTimeInStateMs['draft']).toBe(3 * 60 * 60 * 1000)
    // Both sat in proposing from their transition to now (10h / 8h) → mean 9h.
    expect(metrics.averageTimeInStateMs['proposing']).toBe(9 * 60 * 60 * 1000)
  })
})
