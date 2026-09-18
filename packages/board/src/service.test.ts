import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BoardServiceImpl, DEFAULT_ACTOR, type ExistenceProbe, type GateProbe } from './service.ts'
import type { Stage, WorkItem } from './model.ts'

let dir: string
let rootDir: string
let board: BoardServiceImpl

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'helmsman-board-'))
  rootDir = join(dir, 'board')
  board = new BoardServiceImpl({ rootDir })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Creates a card; overwrite anything via `over`. */
function create(over: Partial<Parameters<BoardServiceImpl['create']>[0]> = {}) {
  return board.create({ title: '需求卡片', repoScope: { baseRepo: 'R' }, ...over })
}

/** requirements → spec needs no gate. */
async function toSpec(id: string): Promise<WorkItem> {
  const { item, gaps } = await board.advance(id)
  expect(gaps).toEqual([])
  return item
}

/** spec → dev needs a finalized spec. */
async function toDev(id: string, module?: string): Promise<WorkItem> {
  await toSpec(id)
  await board.setGates(id, { specFinalized: true })
  const { item, gaps } = await board.advance(id, module ? { scope: { module } } : {})
  expect(gaps).toEqual([])
  return item
}

const allPassProbe: GateProbe = { hasMergedRun: () => true, hasAuditOnRecord: () => true }

describe('board: create / get / list / update', () => {
  it('creates a requirements card with empty collections and a stamped summary', async () => {
    const before = Date.now()
    const item = await create()

    expect(item.id).toMatch(/^wi_[0-9a-f]{16}$/)
    expect(item.stage).toBe('requirements')
    expect(item.repoScope).toEqual({ baseRepo: 'R' })
    expect(item.gates).toEqual({})
    expect(item.associations).toEqual([])
    expect(item.runs).toEqual([])
    expect(item.scope).toBeUndefined()
    expect(item.summary).toEqual({ text: '', generatedBy: 'fallback', at: item.summary.at })
    expect(item.summary.at).toBeGreaterThanOrEqual(before)
    expect(item.createdAt).toBe(item.updatedAt)

    const events = await board.queryEvents()
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('create')
    expect(events[0]!.itemId).toBe(item.id)
    expect(events[0]!.v).toBe(1)
  })

  it('accepts flat repo fields, an initial stage, scope and summary', async () => {
    const item = await create({
      repoScope: {},
      projectGroup: 'G',
      stage: 'spec',
      scope: { module: ' a ' },
      summary: { text: '三行摘要', generatedBy: 'model', source: 'dsh:session-1' },
    })

    expect(item.repoScope).toEqual({ projectGroup: 'G' })
    expect(item.stage).toBe('spec')
    expect(item.scope).toEqual({ module: 'a' })
    expect(item.summary.text).toBe('三行摘要')
    expect(item.summary.generatedBy).toBe('model')
    expect(item.summary.source).toBe('dsh:session-1')
  })

  it('requires a repo identity and a non-empty title', async () => {
    await expect(board.create({ title: 'x', repoScope: {} })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(board.create({ title: '  ', repoScope: { baseRepo: 'R' } })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
    await expect(
      board.create({ title: 'x', repoScope: { baseRepo: 'R' }, stage: 'nope' as unknown as Stage }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('gets by id and returns undefined for unknown ids', async () => {
    const item = await create()
    expect((await board.get(item.id))!.id).toBe(item.id)
    expect(await board.get('wi_missing')).toBeUndefined()

    await expect(board.update('wi_missing', { title: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(board.advance('wi_missing')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(board.setSummary('wi_missing', { text: 'x', generatedBy: 'manual' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('lists by repo or project group, filters by stage, in creation order', async () => {
    const a = await create({ title: 'a', repoScope: { baseRepo: 'R' } })
    const b = await create({ title: 'b', repoScope: { projectGroup: 'G' } })
    const c = await create({ title: 'c', repoScope: { baseRepo: 'R' }, stage: 'dev' })

    expect((await board.list()).map((item) => item.id)).toEqual([a.id, b.id, c.id])
    expect((await board.list({ repo: 'R' })).map((item) => item.id)).toEqual([a.id, c.id])
    expect((await board.list({ repo: 'G' })).map((item) => item.id)).toEqual([b.id])
    expect((await board.list({ stage: 'dev' })).map((item) => item.id)).toEqual([c.id])
    expect(await board.list({ repo: 'R', stage: 'done' })).toEqual([])
  })

  it('patches title / repoScope / scope and records one update event', async () => {
    const item = await create()
    const updated = await board.update(item.id, {
      title: '新标题',
      repoScope: { baseRepo: 'R2', projectGroup: 'G2' },
      scope: { module: 'b' },
    })

    expect(updated.title).toBe('新标题')
    expect(updated.repoScope).toEqual({ baseRepo: 'R2', projectGroup: 'G2' })
    expect(updated.scope).toEqual({ module: 'b' })
    expect(updated.updatedAt).toBeGreaterThanOrEqual(item.updatedAt)

    // An empty scope clears the module declaration (whole-repo domain).
    const cleared = await board.update(item.id, { scope: {} })
    expect(cleared.scope).toBeUndefined()

    const events = await board.queryEvents({ type: 'update' })
    expect(events).toHaveLength(2)
    expect(events[0]!.payload.changed).toEqual(['title', 'repoScope', 'scope'])
    expect(events[1]!.payload.changed).toEqual(['scope'])
  })

  it('treats a no-op update as a no-op (no event, no timestamp bump)', async () => {
    const item = await create()
    const same = await board.update(item.id, { title: item.title, repoScope: { baseRepo: 'R' } })

    expect(same.updatedAt).toBe(item.updatedAt)
    expect(await board.queryEvents({ type: 'update' })).toEqual([])
  })

  it('rejects a blank title or a repoScope that drops the repo identity', async () => {
    const item = await create()
    await expect(board.update(item.id, { title: '   ' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(board.update(item.id, { repoScope: {} })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect((await board.get(item.id))!.title).toBe('需求卡片')
  })

  it('hands out copies, never internal state', async () => {
    const item = await create()
    item.title = 'mutated outside'
    item.associations.push({ type: 'doc', refId: 'x', at: 1 })

    const reread = await board.get(item.id)
    expect(reread!.title).toBe('需求卡片')
    expect(reread!.associations).toEqual([])
  })
})

describe('board: stage advance', () => {
  it('advances one step at a time and appends a versioned migration event', async () => {
    const item = await create()
    const spec = await toSpec(item.id)
    expect(spec.stage).toBe('spec')

    const events = await board.queryEvents({ itemId: item.id, type: 'advance' })
    expect(events).toHaveLength(1)
    expect(events[0]!.payload).toMatchObject({ from: 'requirements', to: 'spec', actor: DEFAULT_ACTOR, runs: [] })
    expect(events[0]!.payload.at).toEqual(expect.any(Number))
  })

  it('records the calling actor on the migration event', async () => {
    const item = await create()
    await board.advance(item.id, { actor: 'kanban' })
    const [event] = await board.queryEvents({ type: 'advance' })
    expect(event!.payload.actor).toBe('kanban')
  })

  it('rejects a skip with the missing intermediate stages and changes nothing', async () => {
    const item = await create()

    await expect(board.advance(item.id, { to: 'done' })).rejects.toBeInstanceOf(Error)
    await expect(board.advance(item.id, { to: 'done' })).rejects.toMatchObject({
      code: 'SKIP_NOT_ALLOWED',
      details: { from: 'requirements', to: 'done', missingStages: ['spec', 'dev'] },
    })
    expect((await board.get(item.id))!.stage).toBe('requirements')
    expect(await board.queryEvents({ type: 'advance' })).toEqual([])
  })

  it('allows a jump when allowSkip is passed or configured', async () => {
    const item = await create()
    const perCall = await board.advance(item.id, { to: 'spec', allowSkip: true })
    expect(perCall.gaps).toEqual([])
    expect(perCall.item.stage).toBe('spec')

    const lenient = new BoardServiceImpl({ rootDir: join(dir, 'lenient'), allowSkip: true })
    const other = await lenient.create({ title: 'x', repoScope: { baseRepo: 'R' } })
    expect((await lenient.advance(other.id, { to: 'spec' })).item.stage).toBe('spec')
  })

  it('rejects backward and same-stage transitions', async () => {
    const item = await create()
    await toSpec(item.id)

    await expect(board.advance(item.id, { to: 'requirements' })).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
      details: { from: 'spec', to: 'requirements' },
    })
    await expect(board.advance(item.id, { to: 'spec' })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' })
    expect((await board.get(item.id))!.stage).toBe('spec')
  })

  it('reports a terminal-stage card instead of silently doing nothing', async () => {
    const item = await create({ stage: 'done' })
    await expect(board.advance(item.id)).rejects.toMatchObject({ code: 'STAGE_TERMINAL' })
  })
})

describe('board: DoR/DoD gates', () => {
  it('needs no gate data to enter spec', async () => {
    const item = await create()
    expect(await board.gate(item.id, 'spec')).toEqual([])
    expect((await board.advance(item.id)).gaps).toEqual([])
  })

  it('refuses dev without a finalized spec and lists the gap', async () => {
    const item = await toSpec((await create()).id)

    const gaps = await board.gate(item.id, 'dev')
    expect(gaps).toHaveLength(1)
    expect(gaps[0]!.key).toBe('spec-finalized')
    expect(gaps[0]!.label).toMatch(/spec/i)
    expect(gaps[0]!.action).toBeTruthy()

    const result = await board.advance(item.id)
    expect(result.gaps.map((gap) => gap.key)).toEqual(['spec-finalized'])
    expect(result.item.stage).toBe('spec')
    expect(await board.queryEvents({ type: 'advance' })).toHaveLength(1) // only the requirements→spec one
  })

  it('lets dev through once the spec is finalized', async () => {
    const item = await toSpec((await create()).id)
    const gated = await board.setGates(item.id, { specFinalized: true })
    expect(gated.gates).toEqual({ specFinalized: true })
    expect(await board.gate(item.id, 'dev')).toEqual([])

    const result = await board.advance(item.id)
    expect(result.gaps).toEqual([])
    expect(result.item.stage).toBe('dev')
    expect((await board.queryEvents({ type: 'advance' })).at(-1)!.payload.to).toBe('dev')
  })

  it('rejects non-boolean gate data', async () => {
    const item = await create()
    await expect(board.setGates(item.id, { specFinalized: 'yes' as unknown as boolean })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
    await expect(board.update(item.id, { gates: { specFinalized: 1 as unknown as boolean } })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
  })

  it('reports the archival gate as unverifiable when no probe is wired', async () => {
    const item = await toDev((await create()).id)
    const gaps = await board.gate(item.id, 'done')

    expect(gaps.map((gap) => gap.key)).toEqual(['run-merged', 'audit-on-record'])
    expect(gaps[0]!.label).toContain('尚未关联任何 run')
    expect(gaps[1]!.label).toContain('未配置 gate probe')

    const result = await board.advance(item.id)
    expect(result.gaps).toHaveLength(2)
    expect(result.item.stage).toBe('dev')
    expect(await board.queryEvents({ type: 'advance' })).toHaveLength(2) // never reached done
  })

  it('refuses the archival gate when the probe cannot confirm a merged run', async () => {
    const item = await toDev((await create()).id)
    await board.associate(item.id, { type: 'run', refId: 'task-1' })

    const gaps = await board.gate(item.id, 'done')
    expect(gaps.map((gap) => gap.key)).toEqual(['run-merged', 'audit-on-record'])
    expect(gaps[0]!.label).toContain('未配置 gate probe')

    // Probe wired but reporting "not merged" keeps the card in dev.
    const probe: GateProbe = { hasMergedRun: () => false, hasAuditOnRecord: () => true }
    const result = await board.advance(item.id, { gateProbe: probe })
    expect(result.gaps.map((gap) => gap.key)).toEqual(['run-merged'])
    expect(result.gaps[0]!.label).toContain('还没有任何 run 被合并')
    expect(result.item.stage).toBe('dev')
  })

  // `advance` takes a per-call probe, but the read-only `gate()` query does not
  // — it only ever sees the configured one. Without a late seam the drawer
  // would render gaps that the very same advance would accept, so the host has
  // to be able to wire the probe onto the service itself.
  it('setGateProbe makes the read-only gate query agree with advance', async () => {
    const item = await toDev((await create()).id)
    await board.associate(item.id, { type: 'run', refId: 'task-1' })

    expect((await board.gate(item.id, 'done')).map((gap) => gap.key)).toEqual([
      'run-merged',
      'audit-on-record',
    ])

    board.setGateProbe(allPassProbe)
    expect(await board.gate(item.id, 'done')).toEqual([])

    // Clearing restores the standalone refusal rather than leaving a stale pass.
    board.setGateProbe(undefined)
    expect((await board.gate(item.id, 'done')).map((gap) => gap.key)).toEqual([
      'run-merged',
      'audit-on-record',
    ])
  })

  it('setGateProbe adjudicates without moving the card', async () => {
    const item = await toDev((await create()).id)
    await board.associate(item.id, { type: 'run', refId: 'task-1' })
    const before = await board.queryEvents({ type: 'advance' })

    board.setGateProbe(allPassProbe)

    expect((await board.get(item.id))!.stage).toBe('dev')
    expect(await board.queryEvents({ type: 'advance' })).toHaveLength(before.length)
  })

  it('archives once a run is merged and the audit record is on file', async () => {
    const item = await toDev((await create()).id)
    await board.associate(item.id, { type: 'run', refId: 'task-1', label: 'fleet run' })

    const result = await board.advance(item.id, { gateProbe: allPassProbe })
    expect(result.gaps).toEqual([])
    expect(result.item.stage).toBe('done')

    const migrations = await board.queryEvents({ type: 'advance', itemId: item.id })
    expect(migrations.at(-1)!.payload).toMatchObject({ from: 'dev', to: 'done', runs: ['task-1'] })
  })

  it('short-circuits on zero runs without consulting the probe', async () => {
    const item = await toDev((await create()).id)
    let asked = 0
    const probe: GateProbe = {
      hasMergedRun: () => {
        asked += 1
        return true
      },
      hasAuditOnRecord: () => true,
    }

    const result = await board.advance(item.id, { gateProbe: probe })
    expect(result.gaps.map((gap) => gap.key)).toEqual(['run-merged'])
    expect(asked).toBe(0)
  })

  it('fails closed when the probe throws and surfaces the reason', async () => {
    const item = await toDev((await create()).id)
    await board.associate(item.id, { type: 'run', refId: 'task-1' })
    const probe: GateProbe = {
      hasMergedRun: () => {
        throw new Error('orchestrator offline')
      },
      hasAuditOnRecord: () => true,
    }

    const result = await board.advance(item.id, { gateProbe: probe })
    expect(result.item.stage).toBe('dev')
    expect(result.gaps[0]!.label).toContain('orchestrator offline')
  })

  it('uses the configured probe when the call overrides none', async () => {
    const configured = new BoardServiceImpl({ rootDir: join(dir, 'probe'), gateProbe: allPassProbe })
    const item = await configured.create({ title: 'x', repoScope: { baseRepo: 'R' } })
    await configured.advance(item.id)
    await configured.setGates(item.id, { specFinalized: true })
    await configured.advance(item.id)
    await configured.associate(item.id, { type: 'run', refId: 'task-9' })

    expect((await configured.advance(item.id)).item.stage).toBe('done')
  })
})

describe('board: conflict-domain WIP', () => {
  it('lets the same repo run different modules in parallel', async () => {
    const x = await create({ title: 'X' })
    const y = await create({ title: 'Y' })
    expect((await toDev(x.id, 'a')).scope).toEqual({ module: 'a' })
    expect((await toDev(y.id, 'b')).scope).toEqual({ module: 'b' })

    expect((await board.get(y.id))!.stage).toBe('dev')
    expect((await board.wip()).map((status) => status.domain)).toEqual(['R:a', 'R:b'])
    expect((await board.wip()).every((status) => status.running === 1 && status.limit === 1)).toBe(true)
  })

  it('refuses a second card in the same module domain, naming the domain key', async () => {
    const x = await create({ title: 'X' })
    const y = await create({ title: 'Y' })
    await toDev(x.id, 'a')

    // Y reaches dev with the same declared module.
    await toSpec(y.id)
    await board.setGates(y.id, { specFinalized: true })
    const result = await board.advance(y.id, { scope: { module: 'a' } })

    expect(result.gaps).toHaveLength(1)
    expect(result.gaps[0]!.key).toBe('wip-limit')
    expect(result.gaps[0]!.label).toContain('R:a')
    expect(result.gaps[0]!.label).toContain('1/1')
    expect(result.item.stage).toBe('spec')
    expect(result.item.scope).toBeUndefined() // a refused advance changes nothing

    // Re-declaring module=b passes (spec scenario: 卡片可改声明 module=b 后重试).
    const retry = await board.advance(y.id, { scope: { module: 'b' } })
    expect(retry.gaps).toEqual([])
    expect(retry.item.stage).toBe('dev')
  })

  it('falls back to the whole-repo domain with its higher ceiling', async () => {
    const cards = [await create({ title: '1' }), await create({ title: '2' }), await create({ title: '3' })]
    await toDev(cards[0]!.id)
    await toDev(cards[1]!.id)

    const third = await board.get(cards[2]!.id)
    expect(third!.stage).toBe('requirements')
    await board.advance(cards[2]!.id, { to: 'spec', allowSkip: true })
    await board.setGates(cards[2]!.id, { specFinalized: true })
    const result = await board.advance(cards[2]!.id)

    expect(result.gaps.map((gap) => gap.key)).toEqual(['wip-limit'])
    expect(result.gaps[0]!.label).toContain('R:*')
    expect(result.gaps[0]!.label).toContain('2/2')
    expect(result.item.stage).toBe('spec')
  })

  it('honours configured ceilings', async () => {
    const wide = new BoardServiceImpl({ rootDir: join(dir, 'wide'), wipLimits: { module: 2, repo: 3 } })
    const a = await wide.create({ title: 'a', repoScope: { baseRepo: 'R' } })
    const b = await wide.create({ title: 'b', repoScope: { baseRepo: 'R' } })
    for (const card of [a, b]) {
      await wide.advance(card.id, { to: 'spec', allowSkip: true })
      await wide.setGates(card.id, { specFinalized: true })
      expect((await wide.advance(card.id, { scope: { module: 'a' } })).gaps).toEqual([])
    }
    expect(wide.wipLimits).toEqual({ module: 2, repo: 3 })

    // Falls back to the defaults when a limit is unusable.
    const bogus = new BoardServiceImpl({ rootDir: join(dir, 'bogus'), wipLimits: { module: 0, repo: -3 } })
    expect(bogus.wipLimits).toEqual({ module: 1, repo: 2 })
  })

  it('evaluates WIP synchronously for any client', async () => {
    const x = await create({ title: 'X' })
    await toDev(x.id, 'a')

    const free = board.evaluateWip({ baseRepo: 'R' }, { module: 'b' })
    expect(free).toMatchObject({ domain: 'R:b', key: 'R:b', allowed: true, running: 0, limit: 1 })

    const busy = board.evaluateWip({ baseRepo: 'R' }, { module: 'a' })
    expect(busy.domain).toBe('R:a')
    expect(busy.allowed).toBe(false)
    expect(busy.reason).toContain('R:a')
    expect(busy.reason).toContain('1/1')
    expect(busy.queueingReason).toBe(busy.reason)
    // Distinct repos never share a domain.
    expect(board.evaluateWip({ baseRepo: 'R2' }, { module: 'a' }).allowed).toBe(true)
  })

  it('exposes running/limit plus the queue for each domain', async () => {
    const running = await create({ title: 'running' })
    const waiting = await create({ title: 'waiting' })
    await toDev(running.id, 'a')
    await toSpec(waiting.id) // one step short of dev, same domain
    await board.update(waiting.id, { scope: { module: 'a' } })

    const status = (await board.wip()).find((entry) => entry.domain === 'R:a')
    expect(status).toMatchObject({
      domain: 'R:a',
      key: 'R:a',
      repo: 'R',
      module: 'a',
      running: 1,
      limit: 1,
      queueing: [waiting.id],
      itemIds: [running.id],
    })
  })
})

describe('board: associations', () => {
  it('stores a reference with a label snapshot and an unverified note', async () => {
    const item = await create()
    const updated = await board.associate(item.id, {
      type: 'doc',
      refId: 'drafts/prd.md',
      label: 'PRD 草稿',
    })

    expect(updated.associations).toHaveLength(1)
    expect(updated.associations[0]).toMatchObject({ type: 'doc', refId: 'drafts/prd.md', label: 'PRD 草稿' })
    expect(updated.associations[0]!.at).toBeGreaterThan(0)
    // References only: no content copy of the pointed-at document.
    expect(Object.keys(updated.associations[0]!).sort()).toEqual(['at', 'label', 'refId', 'type'])

    const [event] = await board.queryEvents({ type: 'associate' })
    expect(event!.payload).toMatchObject({ type: 'doc', refId: 'drafts/prd.md', verified: false })
  })

  it('keeps runs[] in sync for run references and is idempotent', async () => {
    const item = await create()
    const first = await board.associate(item.id, { type: 'run', refId: 'task-1' })
    const second = await board.associate(item.id, { type: 'run', refId: 'task-1' })

    expect(first.runs).toEqual([{ taskId: 'task-1', startedAt: first.runs[0]!.startedAt }])
    expect(second.runs).toHaveLength(1)
    expect(second.associations).toHaveLength(1)
    expect(await board.queryEvents({ type: 'associate' })).toHaveLength(1)

    // A second, distinct run is referenced independently (spec: 卡片关联多次执行).
    const third = await board.associate(item.id, { type: 'run', refId: 'task-2' })
    expect(third.runs.map((run) => run.taskId)).toEqual(['task-1', 'task-2'])
  })

  it('disassociates a target and drops its run reference', async () => {
    const item = await create()
    await board.associate(item.id, { type: 'run', refId: 'task-1' })
    const removed = await board.disassociate(item.id, { type: 'run', refId: 'task-1' })

    expect(removed.associations).toEqual([])
    expect(removed.runs).toEqual([])
    const events = await board.queryEvents()
    expect(events.map((event) => event.type)).toEqual(['create', 'associate', 'disassociate'])

    // Removing something that is not there is a no-op.
    const again = await board.disassociate(item.id, { type: 'run', refId: 'task-1' })
    expect(again.updatedAt).toBe(removed.updatedAt)
    expect(await board.queryEvents({ type: 'disassociate' })).toHaveLength(1)
  })

  it('rejects an unresolvable target when an ExistenceProbe is wired', async () => {
    const probing = new BoardServiceImpl({
      rootDir: join(dir, 'probe'),
      existenceProbe: { exists: ({ refId }) => refId !== 'missing' },
    })
    const item = await probing.create({ title: 'x', repoScope: { baseRepo: 'R' } })

    await expect(probing.associate(item.id, { type: 'doc', refId: 'missing' })).rejects.toMatchObject({
      code: 'TARGET_NOT_FOUND',
      details: { type: 'doc', refId: 'missing' },
    })
    expect((await probing.get(item.id))!.associations).toEqual([])

    const ok = await probing.associate(item.id, { type: 'doc', refId: 'drafts/prd.md' })
    expect(ok.associations).toHaveLength(1)
    expect((await probing.queryEvents({ type: 'associate' }))[0]!.payload.verified).toBe(true)
  })

  it('tolerates a dangling reference and fails closed when the probe throws', async () => {
    const item = await create()
    const dangling = await board.associate(item.id, { type: 'artifact', refId: 'sha256:deadbeef' })
    expect(dangling.associations[0]!.refId).toBe('sha256:deadbeef')

    const failing = new BoardServiceImpl({
      rootDir: join(dir, 'failing'),
      existenceProbe: {
        exists: () => {
          throw new Error('vault unavailable')
        },
      } satisfies ExistenceProbe,
    })
    const other = await failing.create({ title: 'x', repoScope: { baseRepo: 'R' } })
    await expect(failing.associate(other.id, { type: 'doc', refId: 'a.md' })).rejects.toMatchObject({
      code: 'TARGET_NOT_FOUND',
    })
  })

  it('rejects unknown association types and blank refIds', async () => {
    const item = await create()
    await expect(
      board.associate(item.id, { type: 'dsh' as unknown as 'doc', refId: 'x' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(board.associate(item.id, { type: 'doc', refId: '   ' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
    await expect(board.disassociate(item.id, { type: 'doc', refId: '' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
  })
})

describe('board: summary', () => {
  it('stores a generated summary and preserves metadata on manual edit', async () => {
    const item = await create({ summary: { text: '自动摘要', generatedBy: 'model', source: 'dsh:session-7' } })
    expect(item.summary).toMatchObject({ text: '自动摘要', generatedBy: 'model', source: 'dsh:session-7' })

    const edited = await board.setSummary(item.id, { text: '用户手改的摘要', generatedBy: 'manual' })
    expect(edited.summary.text).toBe('用户手改的摘要')
    expect(edited.summary.generatedBy).toBe('manual')
    expect(edited.summary.source).toBe('dsh:session-7') // metadata survives the edit
    expect(edited.summary.at).toBeGreaterThanOrEqual(item.summary.at)
    expect(edited.updatedAt).toBe(edited.summary.at)

    const regenerated = await board.setSummary(item.id, {
      text: '重新生成的摘要',
      generatedBy: 'model',
      source: 'dsh:session-8',
    })
    expect(regenerated.summary).toMatchObject({ generatedBy: 'model', source: 'dsh:session-8' })
  })

  it('rejects an unknown generatedBy and treats repetition as a no-op', async () => {
    const item = await create({ summary: { text: 'x', generatedBy: 'manual' } })
    await expect(
      board.setSummary(item.id, { text: 'x', generatedBy: 'llm' as unknown as 'model' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })

    const before = await board.queryEvents({ type: 'summary' })
    const same = await board.setSummary(item.id, { text: 'x', generatedBy: 'manual' })
    expect(same.updatedAt).toBe(item.updatedAt)
    expect(await board.queryEvents({ type: 'summary' })).toHaveLength(before.length)
  })

  it('records summary shape in the event stream, never the prose', async () => {
    const secret = '用户提到了一个敏感的密钥 sk-do-not-log'
    const item = await create({ summary: { text: secret, generatedBy: 'model', source: 'dsh:s1' } })

    const raw = await readFile(join(rootDir, 'events.jsonl'), 'utf8')
    expect(raw).not.toContain('sk-do-not-log')

    const [event] = await board.queryEvents({ type: 'create' })
    expect(event!.payload.summary).toEqual({ generatedBy: 'model', source: 'dsh:s1', chars: secret.length })
    expect((event!.payload.summary as { chars: number }).chars).toBeGreaterThan(0)
  })
})

describe('board: lifecycle events', () => {
  it('appends every event kind in order with strictly increasing ts', async () => {
    const item = await create()
    await board.update(item.id, { title: 'renamed' })
    await toSpec(item.id)
    await board.associate(item.id, { type: 'doc', refId: 'a.md' })
    await board.setSummary(item.id, { text: 's', generatedBy: 'manual' })
    await board.disassociate(item.id, { type: 'doc', refId: 'a.md' })

    const events = await board.queryEvents()
    expect(events.map((event) => event.type)).toEqual([
      'create',
      'update',
      'advance',
      'associate',
      'summary',
      'disassociate',
    ])
    for (let i = 1; i < events.length; i += 1) {
      expect(events[i]!.ts).toBeGreaterThan(events[i - 1]!.ts)
    }
    expect(events.every((event) => event.itemId === item.id && event.v === 1)).toBe(true)
  })

  it('filters by type, itemId and since', async () => {
    const a = await create({ title: 'a' })
    const b = await create({ title: 'b' })
    await board.advance(a.id)

    expect((await board.queryEvents({ itemId: b.id })).map((event) => event.type)).toEqual(['create'])
    expect((await board.queryEvents({ type: 'advance' })).map((event) => event.itemId)).toEqual([a.id])

    const all = await board.queryEvents()
    const cut = all[1]!.ts
    const tail = await board.queryEvents({ since: cut })
    expect(tail.map((event) => event.ts)).toEqual([all[1]!.ts, all[2]!.ts])
  })
})

describe('board: persistence', () => {
  it('restores cards, stages, associations and recent migrations after a restart', async () => {
    const item = await create({ title: '跨重启', scope: { module: 'a' } })
    await toSpec(item.id)
    await board.associate(item.id, { type: 'doc', refId: 'drafts/prd.md', label: 'PRD' })
    await board.setSummary(item.id, { text: '摘要', generatedBy: 'model', source: 'dsh:s1' })

    const revived = new BoardServiceImpl({ rootDir })
    const restored = await revived.get(item.id)
    expect(restored).toMatchObject({ title: '跨重启', stage: 'spec', scope: { module: 'a' } })
    expect(restored!.associations).toEqual([{ type: 'doc', refId: 'drafts/prd.md', label: 'PRD', at: expect.any(Number) }])
    expect(restored!.summary.text).toBe('摘要')

    const events = await revived.queryEvents({ itemId: item.id })
    expect(events.map((event) => event.type)).toEqual(['create', 'advance', 'associate', 'summary'])
    const [migration] = await revived.queryEvents({ itemId: item.id, type: 'advance' })
    expect(migration!.payload).toMatchObject({ from: 'requirements', to: 'spec' })

    // The board keeps working after the restart.
    expect((await revived.advance(item.id, { to: 'dev' })).gaps.map((gap) => gap.key)).toEqual(['spec-finalized'])
  })

  it('writes items.json atomically with a schemaVersion', async () => {
    const item = await create()
    const parsed = JSON.parse(await readFile(join(rootDir, 'items.json'), 'utf8')) as {
      schemaVersion: number
      items: WorkItem[]
    }
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.items).toHaveLength(1)
    expect(parsed.items[0]!.id).toBe(item.id)
    // tmp+rename: no partial file is ever visible.
    expect((await readdir(rootDir)).sort()).toEqual(['events.jsonl', 'items.json'])
  })

  it('reports a corrupt items.json and refuses to overwrite it', async () => {
    const garbage = '{"schemaVersion":1,"items":[{"id":"wi_x"'
    await mkdir(rootDir, { recursive: true })
    await writeFile(join(rootDir, 'items.json'), garbage, 'utf8')

    const broken = new BoardServiceImpl({ rootDir })
    expect(broken.warmUp()?.code).toBe('STORE_CORRUPT')
    await expect(broken.list()).rejects.toMatchObject({ code: 'STORE_CORRUPT' })
    await expect(broken.create({ title: 'x', repoScope: { baseRepo: 'R' } })).rejects.toMatchObject({
      code: 'STORE_CORRUPT',
    })
    await expect(broken.advance('wi_x')).rejects.toMatchObject({ code: 'STORE_CORRUPT' })

    expect(await readFile(join(rootDir, 'items.json'), 'utf8')).toBe(garbage)
    expect((await readdir(rootDir)).sort()).toEqual(['items.json'])
  })

  it('errors on an unwritable state directory without corrupting existing files', async () => {
    const item = await create()
    const before = await readFile(join(rootDir, 'items.json'), 'utf8')

    // An ancestor that is a file makes every mkdir fail: the write path errors
    // while the previous snapshot stays intact.
    const blocker = join(dir, 'blocker')
    await writeFile(blocker, 'file', 'utf8')
    const unwritable = new BoardServiceImpl({ rootDir: join(blocker, 'board') })
    await expect(unwritable.create({ title: 'x', repoScope: { baseRepo: 'R' } })).rejects.toMatchObject({
      code: 'STORE_WRITE_FAILED',
    })

    expect(await readFile(join(rootDir, 'items.json'), 'utf8')).toBe(before)
    expect((await board.get(item.id))!.title).toBe('需求卡片')
  })

  it('leaves a card untouched by reads', async () => {
    const item = await create()
    await board.list()
    await board.get(item.id)
    expect((await board.get(item.id))!.stage).toBe('requirements')
  })
})
