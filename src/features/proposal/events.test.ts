import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventLog, type ProposalEvent } from './events.ts'

let home: string
let log: EventLog

const transition = (overrides: Partial<ProposalEvent> = {}): ProposalEvent => ({
  at: '2026-10-05T00:00:00.000Z',
  proposalId: 'p1',
  kind: 'transition',
  from: 'draft',
  to: 'proposing',
  actor: 'agent',
  ...overrides,
})

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'workmate-events-'))
  log = new EventLog({ homeRoot: home, subdir: 'workmate' })
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('EventLog', () => {
  it('files the log next to proposals.json', () => {
    expect(log.paths().file).toBe(join(home, 'workmate', 'events.jsonl'))
  })

  it('reads an absent log as "no events yet" instead of throwing', async () => {
    await expect(log.read()).resolves.toEqual({ events: [], skippedLines: 0 })
  })

  it('appends one JSON line per event and reads them back in order', async () => {
    await log.append(transition())
    await log.append(transition({ to: 'reviewing', from: 'proposing', actor: 'human' }))

    const { events, skippedLines } = await log.read()
    expect(skippedLines).toBe(0)
    expect(events.map((event) => [event.from, event.to, event.actor])).toEqual([
      ['draft', 'proposing', 'agent'],
      ['proposing', 'reviewing', 'human'],
    ])

    const raw = await readFile(log.paths().file, 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(raw.trim().split('\n')).toHaveLength(2)
  })

  it('tolerates a torn trailing line and counts it', async () => {
    await log.append(transition())
    await writeFile(log.paths().file, `${await readFile(log.paths().file, 'utf8')}{"at":"2026-10-0`, 'utf8')

    const { events, skippedLines } = await log.read()
    expect(events).toHaveLength(1)
    expect(skippedLines).toBe(1)
  })

  it('skips unparsable or foreign lines without dropping the rest', async () => {
    await mkdir(join(home, 'workmate'), { recursive: true })
    await writeFile(
      log.paths().file,
      ['not json', JSON.stringify({ hello: 'world' }), JSON.stringify(transition())].join('\n') + '\n',
      'utf8',
    )

    const { events, skippedLines } = await log.read()
    expect(events).toHaveLength(1)
    expect(skippedLines).toBe(2)
  })

  it('filters by proposal', async () => {
    await log.append(transition())
    await log.append(transition({ proposalId: 'p2' }))

    expect((await log.listFor('p2')).map((event) => event.proposalId)).toEqual(['p2'])
    expect(await log.listFor('p3')).toEqual([])
  })

  it('serializes concurrent appends into complete lines', async () => {
    await Promise.all(Array.from({ length: 25 }, (_value, index) => log.append(transition({ proposalId: `p${index}` }))))

    const { events, skippedLines } = await log.read()
    expect(skippedLines).toBe(0)
    expect(events).toHaveLength(25)
  })
})
