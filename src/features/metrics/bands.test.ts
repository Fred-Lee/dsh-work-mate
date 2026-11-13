import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BandsConfigError,
  DEFAULT_BANDS,
  bandSamples,
  bandsPath,
  evaluateBands,
  loadBands,
  normalizeBands,
} from './bands.ts'
import type { Proposal } from '../proposal/store.ts'
import type { ProposalEvent } from '../proposal/events.ts'

let home: string
const NOW = new Date('2026-10-20T12:00:00.000Z')
const now = (): Date => NOW

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'workmate-bands-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

const proposal = (id: string, overrides: Partial<Proposal> = {}): Proposal => ({
  id,
  title: id,
  status: 'archived',
  projects: [],
  commits: [],
  openspecChangeId: id,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...overrides,
})

/** Archived proposal whose cycle time is `hours`, via a two-event story. */
const archivedIn = (id: string, hours: number, createdAt: string): { proposal: Proposal; events: ProposalEvent[] } => {
  const start = Date.parse(createdAt)
  const at = (offsetMs: number): string => new Date(start + offsetMs).toISOString()
  return {
    proposal: proposal(id, { createdAt }),
    events: [
      { at: at(0), proposalId: id, kind: 'transition', from: 'draft', to: 'proposing', actor: 'agent' },
      { at: at(hours * 60 * 60 * 1000), proposalId: id, kind: 'transition', from: 'archiving', to: 'archived', actor: 'human' },
    ],
  }
}

describe('loadBands / normalizeBands', () => {
  it('falls back to defaults when the file is absent', async () => {
    await expect(loadBands(join(home, 'workmate', 'bands.json'))).resolves.toEqual(DEFAULT_BANDS)
  })

  it('files the config next to the other state', () => {
    expect(bandsPath({ homeRoot: home, subdir: 'workmate' })).toBe(join(home, 'workmate', 'bands.json'))
  })

  it('accepts a partial override and fills the rest from defaults', async () => {
    const file = join(home, 'bands.json')
    await writeFile(file, JSON.stringify({ windowDays: 7, rules: [{ metric: 'rework', direction: 'high' }] }), 'utf8')

    const loaded = await loadBands(file)
    expect(loaded.windowDays).toBe(7)
    expect(loaded.recentSamples).toBe(DEFAULT_BANDS.recentSamples)
    expect(loaded.rules).toEqual([{ metric: 'rework', direction: 'high' }])
  })

  it('fails closed on malformed JSON, unknown metrics and bad numbers', async () => {
    const file = join(home, 'bands.json')
    await writeFile(file, '{ not json', 'utf8')
    await expect(loadBands(file)).rejects.toBeInstanceOf(BandsConfigError)

    expect(() => normalizeBands({ rules: [{ metric: 'loc' }] })).toThrow(BandsConfigError)
    expect(() => normalizeBands({ windowDays: -1 })).toThrow(BandsConfigError)
    expect(() => normalizeBands({ version: 2 })).toThrow(BandsConfigError)
    expect(() => normalizeBands({ rules: [] })).toThrow(BandsConfigError)
    expect(() => normalizeBands(null)).toThrow(BandsConfigError)
  })
})

describe('bandSamples', () => {
  it('takes one sample per proposal, oldest first', () => {
    const a = archivedIn('a', 1, '2026-10-01T00:00:00.000Z')
    const b = archivedIn('b', 3, '2026-10-02T00:00:00.000Z')
    const samples = bandSamples('cycleTime', [b.proposal, a.proposal], [...a.events, ...b.events], now)

    expect(samples).toEqual([1 * 60 * 60 * 1000, 3 * 60 * 60 * 1000])
  })

  it('counts rework and gate refusals per proposal', () => {
    const proposalRecord = proposal('a', { status: 'reviewing' })
    const events: ProposalEvent[] = [
      { at: '2026-10-01T01:00:00.000Z', proposalId: 'a', kind: 'transition', from: 'implementing', to: 'ready', actor: 'agent' },
      { at: '2026-10-01T02:00:00.000Z', proposalId: 'a', kind: 'transition', from: 'ready', to: 'implementing', actor: 'agent' },
      { at: '2026-10-01T03:00:00.000Z', proposalId: 'a', kind: 'gate-failed', to: 'merging', actor: 'agent', gate: 'wiki-coverage' },
    ]

    expect(bandSamples('rework', [proposalRecord], events, now)).toEqual([1])
    expect(bandSamples('gateFailures', [proposalRecord], events, now)).toEqual([1])
  })

  it('only samples first-pass for proposals that reached merging or beyond', () => {
    const early = proposal('early', { status: 'reviewing' })
    const merged = proposal('merged', { status: 'merging' })
    const samples = bandSamples(
      'firstPass',
      [early, merged],
      [{ at: '2026-10-01T01:00:00.000Z', proposalId: 'merged', kind: 'transition', from: 'ready', to: 'implementing', actor: 'agent' }],
      now,
    )

    expect(samples).toEqual([1])
  })
})

describe('evaluateBands', () => {
  /**
   * 13 archived proposals on consecutive October days: the first `baseline`
   * values form the baseline, the rest are the recent window.
   */
  const series = (baseline: number[], recentList: number[]): { proposals: Proposal[]; events: ProposalEvent[] } => {
    const proposals: Proposal[] = []
    const events: ProposalEvent[] = []
    const hours = [...baseline, ...recentList]
    hours.forEach((value, index) => {
      const day = String(index + 1).padStart(2, '0')
      const built = archivedIn(`p${index}`, value, `2026-10-${day}T00:00:00.000Z`)
      proposals.push(built.proposal)
      events.push(...built.events)
    })
    return { proposals, events }
  }
  const VARYING = [2, 3, 2, 3, 2, 3, 2, 3]

  it('reports insufficient-data (never a breach) while the baseline is thin', () => {
    const { proposals, events } = series([2, 2], [2, 2, 2, 2])
    const [cycleTime] = evaluateBands(proposals, events, { now })

    expect(cycleTime?.status).toBe('insufficient-data')
    expect(cycleTime?.tier).toBe('normal')
    expect(cycleTime?.note).toContain('基线样本不足：至少 8 条')
  })

  it('classifies a 2σ rise as diagnose and a 3σ rise as propose', () => {
    const diagnose = series(VARYING, [3.5, 3.5, 3.5, 3.5, 3.5])
    const diagnosed = evaluateBands(diagnose.proposals, diagnose.events, { now })
    const cycleTime = diagnosed.find((entry) => entry.metric === 'cycleTime')
    expect(cycleTime?.baseline).toBe(2.5 * 60 * 60 * 1000)
    expect(cycleTime?.sigma).toBe(0.5 * 60 * 60 * 1000)
    expect(cycleTime?.deviation).toBeCloseTo(2)
    expect(cycleTime?.tier).toBe('diagnose')

    const propose = series(VARYING, [4, 4, 4, 4, 4])
    const proposed = evaluateBands(propose.proposals, propose.events, { now })
    expect(proposed.find((entry) => entry.metric === 'cycleTime')?.tier).toBe('propose')
  })

  it('reports a normal tier when the recent window matches the baseline', () => {
    const flat = series(VARYING, [2.5, 2.5, 2.5, 2.5, 2.5])
    const evaluation = evaluateBands(flat.proposals, flat.events, { now })

    expect(evaluation.find((entry) => entry.metric === 'cycleTime')?.tier).toBe('normal')
  })

  it('reads a uniform baseline with movement as a 3σ departure instead of dividing by zero', () => {
    const { proposals, events } = series([2, 2, 2, 2, 2, 2, 2, 2], [6, 6, 6, 6, 6])
    const [cycleTime] = evaluateBands(proposals, events, { now })

    expect(cycleTime?.baseline).toBe(2 * 60 * 60 * 1000)
    expect(cycleTime?.sigma).toBe(0)
    expect(cycleTime?.tier).toBe('propose')
    expect(cycleTime?.note).toContain('sigma: 0')
  })

  it('treats a good metric moving the wrong way as worse (firstPass low is bad)', () => {
    const proposals: Proposal[] = []
    const events: ProposalEvent[] = []
    // Twelve first-pass merges, then five that bounced backward.
    for (let index = 0; index < 17; index += 1) {
      const day = String(index + 1).padStart(2, '0')
      const id = `f${index}`
      proposals.push(proposal(id, { status: 'merging', createdAt: `2026-09-${day}T00:00:00.000Z` }))
      events.push({ at: `2026-09-${day}T01:00:00.000Z`, proposalId: id, kind: 'transition', from: 'ready', to: 'implementing', actor: 'agent' })
      if (index >= 12) {
        events.push({ at: `2026-09-${day}T02:00:00.000Z`, proposalId: id, kind: 'transition', from: 'merging', to: 'implementing', actor: 'agent' })
      }
    }
    const evaluation = evaluateBands(proposals, events, { now, windowDays: 60 })
    const firstPass = evaluation.find((entry) => entry.metric === 'firstPass')

    expect(firstPass?.direction).toBe('low')
    expect(firstPass?.tier).toBe('propose')
  })

  it('honours per-tier action overrides and window narrowing', () => {
    const { proposals, events } = series(VARYING, [4, 4, 4, 4, 4])
    const overridden = evaluateBands(proposals, events, {
      now,
      config: { ...DEFAULT_BANDS, rules: [{ metric: 'cycleTime', direction: 'high', actions: { sigma3: 'log' } }] },
    })
    expect(overridden[0]?.tier).toBe('log')

    // Everything predates a one-day window → no samples → insufficient data.
    const narrowed = evaluateBands(proposals, events, { now, windowDays: 1 })
    expect(narrowed[0]?.samples).toBe(0)
    expect(narrowed[0]?.status).toBe('insufficient-data')
  })
})
