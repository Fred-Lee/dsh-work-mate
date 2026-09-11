import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AuditUnavailableError,
  JsonlAuditJournal,
  MemoryAuditJournal,
  defaultAuditPath,
  type AuditDecisionEntry,
} from './journal.ts'

function decision(over: Partial<AuditDecisionEntry> = {}): AuditDecisionEntry {
  return {
    v: 1,
    ts: 1_000,
    type: 'decision',
    operation: 'merge',
    scope: 'merge:t-1',
    source: 'ui',
    decision: 'granted',
    ...over,
  }
}

describe('MemoryAuditJournal', () => {
  it('round-trips decisions and completions in order', async () => {
    const journal = new MemoryAuditJournal()
    await journal.recordDecision(decision({ decision: 'auto-grant' }))
    await journal.recordDecision(decision({ ts: 2_000, decision: 'denied', operation: 'discard', scope: 'discard:t-2' }))
    await journal.recordCompletion({
      v: 1, ts: 3_000, type: 'run-completion', operation: 'merge', scope: 'merge:t-1', source: 'tool', taskId: 't-1', outcome: 'completed',
      detail: { agents: ['claude'], resolutions: { 'a.ts': { kind: 'agent', agent: 'claude' } } },
    })
    const all = await journal.query()
    expect(all).toHaveLength(3)
    expect(all.map((e) => e.type)).toEqual(['decision', 'decision', 'run-completion'])
  })

  it('queries filter by op, taskId and time window', async () => {
    const journal = new MemoryAuditJournal()
    await journal.recordDecision(decision({ ts: 100, operation: 'merge', taskId: 't-1' }))
    await journal.recordDecision(decision({ ts: 200, operation: 'discard', taskId: 't-2' }))
    await journal.recordCompletion({ v: 1, ts: 300, type: 'run-completion', operation: 'merge', scope: 's', taskId: 't-1', outcome: 'completed' })
    expect((await journal.query({ op: 'merge' })).map((e) => e.ts)).toEqual([100, 300])
    expect((await journal.query({ taskId: 't-2' })).map((e) => e.ts)).toEqual([200])
    expect((await journal.query({ from: 150, to: 250 })).map((e) => e.ts)).toEqual([200])
  })

  it('failWrites makes decisions throw (fail-closed seam)', async () => {
    const journal = new MemoryAuditJournal()
    journal.failWrites = true
    await expect(journal.recordDecision(decision())).rejects.toThrow(AuditUnavailableError)
  })
})

describe('JsonlAuditJournal', () => {
  it('default path is HELMSMAN_HOME aware under audit/audit.jsonl', () => {
    const prev = process.env.HELMSMAN_HOME
    try {
      process.env.HELMSMAN_HOME = '/tmp/hh'
      expect(defaultAuditPath()).toBe('/tmp/hh/audit/audit.jsonl')
    } finally {
      if (prev === undefined) delete process.env.HELMSMAN_HOME
      else process.env.HELMSMAN_HOME = prev
    }
  })

  it('appends entries as one JSONL line each and survives a store reopen', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'audit-'))
    const file = join(dir, 'audit.jsonl')
    const journal = new JsonlAuditJournal(file)
    await journal.recordDecision(decision({ ts: 10, taskId: 't-1' }))
    await journal.recordCompletion({
      v: 1, ts: 20, type: 'run-completion', operation: 'merge', scope: 'merge:t-1', taskId: 't-1', outcome: 'completed',
      detail: { resolutions: { 'f.ts': { kind: 'skip' } }, conflictFiles: ['f.ts'] },
    })
    const reopened = new JsonlAuditJournal(file)
    const entries = await reopened.query()
    expect(entries).toHaveLength(2)
    expect(entries[0]!.type).toBe('decision')
    const raw = await readFile(file, 'utf8')
    expect(raw.trim().split('\n')).toHaveLength(2)
    expect(JSON.parse(raw.trim().split('\n')[0]!)!.v).toBe(1)
  })

  it('query filters and returns append order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'audit-'))
    const file = join(dir, 'audit.jsonl')
    const journal = new JsonlAuditJournal(file)
    await journal.recordDecision(decision({ ts: 1, operation: 'merge', taskId: 't-1' }))
    await journal.recordDecision(decision({ ts: 2, operation: 'discard', taskId: 't-2' }))
    const filtered = await journal.query({ taskId: 't-1' })
    expect(filtered).toHaveLength(1)
    expect(filtered[0]).toMatchObject({ operation: 'merge' })
    const noFile = new JsonlAuditJournal(join(dir, 'missing.jsonl'))
    expect(await noFile.query()).toEqual([])
  })

  it('a torn trailing line is tolerated on read (append-safety)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'audit-'))
    const file = join(dir, 'audit.jsonl')
    const journal = new JsonlAuditJournal(file)
    await journal.recordDecision(decision({ ts: 1 }))
    // simulate a crash mid-append: incomplete JSON tail line
    await writeFile(file, `${await readFile(file, 'utf8')}{"v":1,"ts":2,"type":"deci`, 'utf8')
    const entries = await journal.query()
    expect(entries).toHaveLength(1)
  })

  it('a decision write to an unwritable location throws AuditUnavailableError', async () => {
    const blocker = await mkdtemp(join(tmpdir(), 'audit-block-'))
    const asFile = join(blocker, 'not-a-dir')
    await writeFile(asFile, 'x', 'utf8')
    const journal = new JsonlAuditJournal(join(asFile, 'audit.jsonl'))
    await expect(journal.recordDecision(decision())).rejects.toThrow(AuditUnavailableError)
  })

  it('completion record failures surface loudly but do not throw', async () => {
    const blocker = await mkdtemp(join(tmpdir(), 'audit-block-'))
    const asFile = join(blocker, 'not-a-dir')
    await writeFile(asFile, 'x', 'utf8')
    const journal = new JsonlAuditJournal(join(asFile, 'audit.jsonl'))
    await expect(
      journal.recordCompletion({ v: 1, ts: 1, type: 'run-completion', operation: 'run', scope: 's', outcome: 'completed' }),
    ).resolves.toBeUndefined()
  })
})
