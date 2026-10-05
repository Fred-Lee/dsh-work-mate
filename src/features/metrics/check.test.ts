import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runBandsCheck } from './check.ts'
import { ProposalStore } from '../proposal/store.ts'
import { ProposalServiceImpl } from '../proposal/service.ts'
import { EventLog, type ProposalEvent } from '../proposal/events.ts'

let home: string
let store: ProposalStore
let events: EventLog
let proposals: ProposalServiceImpl

const NOW = new Date('2026-10-20T12:00:00.000Z')

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wm-bands-check-'))
  store = new ProposalStore({ homeRoot: home, subdir: 'workmate' })
  events = new EventLog({ homeRoot: home, subdir: 'workmate' })
  proposals = new ProposalServiceImpl(store, undefined, events)

  // 8 clean proposals then 5 that bounced: a uniform baseline (σ = 0) with
  // movement, which the band rules treat as a 3σ departure.
  for (let index = 0; index < 13; index += 1) {
    const day = String(index + 1).padStart(2, '0')
    const id = `p${index}`
    await proposals.upsert({ id, title: id })
    const all = await store.load()
    const record = all.find((entry) => entry.id === id)
    if (record !== undefined) {
      record.createdAt = `2026-10-${day}T00:00:00.000Z`
      record.status = 'reviewing'
    }
    await store.save(all)
    const log: ProposalEvent[] = [
      { at: `2026-10-${day}T01:00:00.000Z`, proposalId: id, kind: 'transition', from: 'proposing', to: 'reviewing', actor: 'agent' },
    ]
    if (index >= 8) {
      log.push(
        { at: `2026-10-${day}T02:00:00.000Z`, proposalId: id, kind: 'transition', from: 'ready', to: 'implementing', actor: 'agent' },
        { at: `2026-10-${day}T03:00:00.000Z`, proposalId: id, kind: 'transition', from: 'implementing', to: 'ready', actor: 'agent' },
      )
    }
    for (const event of log) await events.append(event)
  }
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

const deps = (createProposal?: ReturnType<typeof vi.fn>): Parameters<typeof runBandsCheck>[0] => ({
  proposals,
  events,
  bandsFile: join(home, 'workmate', 'bands.json'),
  now: () => NOW,
  ...(createProposal !== undefined ? { createProposal } : {}),
})

describe('runBandsCheck', () => {
  it('detects the breach, records it, and creates nothing without apply', async () => {
    const result = await runBandsCheck(deps())

    expect(result.breachCount).toBeGreaterThan(0)
    expect(result.created).toEqual([])
    const { events: log } = await events.read()
    const breach = log.find((event) => event.kind === 'band-breach')
    expect(breach?.metric).toBe('rework')
    expect(breach?.tier).toBe('propose')
    expect(breach?.proposalId).toBe('_metrics_')
  })

  it('opens one metric-regression draft per propose breach when apply is set', async () => {
    const createProposal = vi.fn(async (input: { id: string }) => ({ id: input.id }))
    const result = await runBandsCheck(deps(createProposal), { apply: true })

    expect(result.created).toEqual([`band-rework-${NOW.toISOString().slice(0, 10)}`])
    expect(createProposal).toHaveBeenCalledTimes(1)
    expect(createProposal.mock.calls[0]?.[0]).toMatchObject({
      id: `band-rework-${NOW.toISOString().slice(0, 10)}`,
      source: 'metric-regression',
      sourceRef: 'bands:rework',
    })
    // The notes carry the facts the reviewer needs.
    expect(String(createProposal.mock.calls[0]?.[0]?.notes)).toContain('metric=rework')
  })

  it('does not create a duplicate proposal on the next run', async () => {
    const createProposal = vi.fn(async (input: { id: string }) => ({ id: input.id }))
    await proposals.upsert({ id: `band-rework-${NOW.toISOString().slice(0, 10)}`, title: '已有的越界提案' })

    const result = await runBandsCheck(deps(createProposal), { apply: true })

    expect(result.created).toEqual([])
    expect(createProposal).not.toHaveBeenCalled()
  })

  it('says so when apply is requested without a creation path', async () => {
    const result = await runBandsCheck(deps(), { apply: true })

    expect(result.created).toEqual([])
    expect(result.note).toContain('breaches were recorded only')
  })

  it('honours a narrowed window', async () => {
    const result = await runBandsCheck(deps(), { windowDays: 1 })

    // Everything predates a one-day window → insufficient baseline, no breach.
    expect(result.breachCount).toBe(0)
    expect(result.evaluations.every((entry) => entry.status === 'insufficient-data')).toBe(true)
  })
})
