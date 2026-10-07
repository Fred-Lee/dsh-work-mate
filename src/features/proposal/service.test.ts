import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProposalStore } from './store.ts'
import { ProposalServiceImpl } from './service.ts'
import { EventLog } from './events.ts'

let home: string
let store: ProposalStore
let service: ProposalServiceImpl

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'workmate-service-'))
  store = new ProposalStore({ homeRoot: home, subdir: 'workmate' })
  service = new ProposalServiceImpl(store)
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('provenance fields (add-feedback-loop)', () => {
  it('stores the declared origin, relation and capture facts', async () => {
    const created = await service.upsert({
      id: 'fix-42',
      title: '修复 INC-42',
      source: 'incident',
      sourceRef: 'INC-42',
      relatesTo: ['p-old'],
      provenance: { capturedAt: '2026-10-05T00:00:00.000Z', untrusted: true },
    })

    expect(created.source).toBe('incident')
    expect(created.sourceRef).toBe('INC-42')
    expect(created.relatesTo).toEqual(['p-old'])
    expect(created.provenance?.untrusted).toBe(true)
  })

  it('never clears provenance on a re-run that omits it', async () => {
    await service.upsert({ id: 'fix-42', title: '修复 INC-42', source: 'incident', sourceRef: 'INC-42' })
    const again = await service.upsert({ id: 'fix-42', title: '修复 INC-42（改标题）' })

    expect(again.source).toBe('incident')
    expect(again.sourceRef).toBe('INC-42')
  })
})

describe('transition events (add-proposal-metrics)', () => {
  it('records one event per status write, attributed to the caller', async () => {
    const log = new EventLog({ homeRoot: home, subdir: 'workmate' })
    const timed = new ProposalServiceImpl(store, undefined, log)
    await timed.upsert({ id: 'p1', title: '标题' })

    await timed.setStatus('p1', 'proposing', { actor: 'agent' })
    await timed.setStatus('p1', 'reviewing', { actor: 'human' })

    const { events, skippedLines } = await log.read()
    expect(skippedLines).toBe(0)
    expect(events.map((event) => [event.kind, event.from, event.to, event.actor])).toEqual([
      ['transition', 'draft', 'proposing', 'agent'],
      ['transition', 'proposing', 'reviewing', 'human'],
    ])
    expect(events[0]?.at).toBeTruthy()
    expect(events[0]?.proposalId).toBe('p1')
  })

  it('falls back to the system actor and writes nothing when the status is unchanged', async () => {
    const log = new EventLog({ homeRoot: home, subdir: 'workmate' })
    const timed = new ProposalServiceImpl(store, undefined, log)
    await timed.upsert({ id: 'p1', title: '标题' })

    await timed.setStatus('p1', 'draft')
    await timed.setStatus('p1', 'proposing')
    await timed.setStatus('p1', 'proposing')

    const { events } = await log.read()
    expect(events).toHaveLength(1)
    expect(events[0]?.actor).toBe('system')
  })

  it('keeps working without an event log (read-only embeddings)', async () => {
    await service.upsert({ id: 'p1', title: '标题' })
    await expect(service.setStatus('p1', 'proposing', { actor: 'agent' })).resolves.toMatchObject({ status: 'proposing' })
    await expect(service.recordEvent({
      at: new Date().toISOString(),
      proposalId: 'p1',
      kind: 'gate-failed',
      actor: 'system',
    })).resolves.toBeUndefined()
  })
})

describe('ProposalServiceImpl.upsert', () => {
  it('creates a draft proposal defaulting openspecChangeId to the id', async () => {
    const created = await service.upsert({ id: 'batch-grading-v2', title: '批量批改 v2.1' })

    expect(created).toMatchObject({
      id: 'batch-grading-v2',
      title: '批量批改 v2.1',
      status: 'draft',
      projects: [],
      commits: [],
      openspecChangeId: 'batch-grading-v2',
    })
    expect(created.createdAt).toBe(created.updatedAt)
    await expect(service.list()).resolves.toHaveLength(1)
  })

  it('updates in place: identity fields and createdAt stay, updatedAt moves', async () => {
    let tick = 0
    const timed = new ProposalServiceImpl(
      store,
      () => new Date(Date.UTC(2026, 8, 28, 12, 0, ++tick)),
    )
    const created = await timed.upsert({ id: 'p1', title: 'v1' })
    const updated = await timed.upsert({ id: 'p1', title: 'v2', projects: ['a'] })

    expect(updated.createdAt).toBe(created.createdAt)
    expect(updated.updatedAt).not.toBe(created.updatedAt)
    expect(updated.title).toBe('v2')
    expect(updated.projects).toEqual(['a'])
    await expect(service.list()).resolves.toHaveLength(1)
  })

  it('rejects an empty id', async () => {
    await expect(service.upsert({ id: '  ', title: 'x' })).rejects.toThrow(
      'proposal id must be a non-empty string',
    )
  })
})

describe('ProposalServiceImpl.get', () => {
  it('finds by id and returns undefined otherwise', async () => {
    await service.upsert({ id: 'p1', title: 't' })
    expect((await service.get('p1'))?.title).toBe('t')
    expect(await service.get('missing')).toBeUndefined()
  })
})

describe('decisions and blockers', () => {
  let store2: ProposalStore
  let service2: ProposalServiceImpl

  beforeEach(async () => {
    store2 = new ProposalStore({ homeRoot: home, subdir: 'workmate-dl' })
    service2 = new ProposalServiceImpl(store2)
    await service2.upsert({ id: 'dl', title: '决策日志' })
  })

  it('appends decisions and validates the supersedes chain', async () => {
    const d1 = await service2.addDecision('dl', { decision: '用分支', rationale: '串行够用' })
    const d2 = await service2.addDecision('dl', { decision: '用 worktree', rationale: '需要并行', supersedes: d1.id })

    expect(d2.supersedes).toBe(d1.id)
    await expect(
      service2.addDecision('dl', { decision: 'x', rationale: 'y', supersedes: 'ghost' }),
    ).rejects.toThrow("does not reference an existing decision")
    expect((await service2.get('dl'))?.decisions).toHaveLength(2)
  })

  it('walks the blocker round-trip open → resolved with the answer stored', async () => {
    const blocker = await service2.block('dl', { question: '字段语义？', tried: '查了两轮 GitNexus' })
    expect(blocker.status).toBe('open')

    await expect(service2.unblock('dl', blocker.id, '  ')).rejects.toThrow('non-empty')
    const resolved = await service2.unblock('dl', blocker.id, '语义已与用户确认')
    expect(resolved.status).toBe('resolved')
    expect(resolved.answer).toBe('语义已与用户确认')
    await expect(service2.unblock('dl', blocker.id, 'again')).rejects.toThrow('already resolved')
    expect((await service2.get('dl'))?.blockers).toHaveLength(1)
  })
})

describe('abandon (deliberate exit)', () => {
  it('moves the proposal to the terminal state with a reason and an event', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wm-abandon-'))
    const store = new ProposalStore({ homeRoot: dir, subdir: 'workmate' })
    const log = new EventLog({ homeRoot: dir, subdir: 'workmate' })
    const service = new ProposalServiceImpl(store, undefined, log)
    await service.upsert({ id: 'orphan', title: '孤儿提案' })

    const abandoned = await service.abandon('orphan', '项目目录已删除，演示数据')

    expect(abandoned.status).toBe('archived')
    expect(abandoned.abandonedReason).toContain('演示数据')
    expect(abandoned.abandonedAt).toBeDefined()
    const { events } = await log.read()
    const transition = events.find((event) => event.proposalId === 'orphan' && event.kind === 'transition')
    expect(transition?.to).toBe('archived')
    expect(transition?.actor).toBe('human')
    expect(transition?.reason).toContain('abandoned')
  })

  it('requires a reason and refuses to re-abandon an archived proposal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wm-abandon2-'))
    const service = new ProposalServiceImpl(new ProposalStore({ homeRoot: dir, subdir: 'workmate' }))
    await service.upsert({ id: 'p', title: 't' })

    await expect(service.abandon('p', '   ')).rejects.toThrow(/原因/)
    await service.abandon('p', '不做了')
    await expect(service.abandon('p', 'again')).rejects.toThrow(/已归档/)
    await rm(dir, { recursive: true, force: true })
  })
})

describe('abandon keeps the actor honest (abandon-tool-entry)', () => {
  it('records actor=agent when an agent abandons, and human by default', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wm-abandon-actor-'))
    const log = new EventLog({ homeRoot: dir, subdir: 'workmate' })
    const service = new ProposalServiceImpl(new ProposalStore({ homeRoot: dir, subdir: 'workmate' }), undefined, log)
    await service.upsert({ id: 'a1', title: 'agent 终止' })
    await service.upsert({ id: 'h1', title: 'human 终止' })

    await service.abandon('a1', '孤儿提案', 'agent')
    await service.abandon('h1', '不做了')

    const { events } = await log.read()
    const byId = (id: string) => events.find((event) => event.proposalId === id && event.kind === 'transition')
    expect(byId('a1')?.actor).toBe('agent')
    expect(byId('h1')?.actor).toBe('human')
    await rm(dir, { recursive: true, force: true })
  })
})
