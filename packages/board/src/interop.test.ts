/**
 * Interop contract with the sibling `@helmsman/ui-board` package.
 *
 * The kanban SPA consumes this service through a STRUCTURAL type (it never
 * imports a sibling implementation), so a few call shapes differ from the
 * canonical `(id, opts)` form. These tests pin the tolerant paths: the object
 * forms, the `specFinalized` update alias, `kind`/`limit` event filters and the
 * `key` aliases on WIP reports. Nothing here relaxes a behavioural rule — a
 * refusal still changes nothing on disk.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BoardServiceImpl, type AdvanceRequest } from './service.ts'
import { HelmsmanBoardError } from './errors.ts'

let dir: string
let rootDir: string
let board: BoardServiceImpl

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'helmsman-board-interop-'))
  rootDir = join(dir, 'board')
  board = new BoardServiceImpl({ rootDir })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function create(over: Partial<Parameters<BoardServiceImpl['create']>[0]> = {}) {
  return board.create({ title: '卡片', repoScope: { baseRepo: 'R' }, ...over })
}

/** The kanban REST layer calls `advance.call(board, { id, to, allowSkip })`. */
function advanceAsRestLayer(input: AdvanceRequest) {
  return board.advance(input)
}

describe('interop: advance object form', () => {
  it('advances from an { id, to } request', async () => {
    const item = await create()
    const result = await advanceAsRestLayer({ id: item.id, to: 'spec' })

    expect(result.ok).toBe(true)
    expect(result.gaps).toEqual([])
    expect(result.item.stage).toBe('spec')
    expect(result.item.id).toBe(item.id)
  })

  it('answers a refused advance with ok:false and a queueing reason', async () => {
    const x = await create({ title: 'X' })
    const y = await create({ title: 'Y' })
    // X occupies conflict domain R:a.
    await board.advance(x.id)
    await board.setGates(x.id, { specFinalized: true })
    expect((await board.advance(x.id, { to: 'dev', scope: { module: 'a' } })).item.stage).toBe('dev')

    // Y is gate-clean but declares the same module.
    await board.advance(y.id)
    await board.setGates(y.id, { specFinalized: true })
    await board.update(y.id, { scope: { module: 'a' } })

    const blocked = await advanceAsRestLayer({ id: y.id, to: 'dev' })
    expect(blocked.ok).toBe(false)
    expect(blocked.item.stage).toBe('spec')
    expect(blocked.queueingReason).toContain('R:a')
    expect(blocked.gaps.map((gap) => gap.key)).toEqual(['wip-limit'])
    expect(blocked.reason).toContain('R:a')
    expect((await board.get(y.id))!.stage).toBe('spec')

    // Re-declaring a free module in the same request gets through.
    const moved = await advanceAsRestLayer({ id: y.id, to: 'dev', scope: { module: 'b' } })
    expect(moved.ok).toBe(true)
    expect(moved.item.stage).toBe('dev')
    expect(moved.queueingReason).toBeUndefined()
  })

  it('carries displayable gaps on a thrown structural refusal', async () => {
    const item = await create()

    // A drag straight to the last column surfaces as a refusal the REST layer
    // can render (gaps on the error), not an opaque 500.
    await expect(advanceAsRestLayer({ id: item.id, to: 'done' })).rejects.toMatchObject({
      code: 'SKIP_NOT_ALLOWED',
      details: {
        from: 'requirements',
        to: 'done',
        missingStages: ['spec', 'dev'],
        gaps: [{ key: 'stage-transition' }],
      },
    })

    const err = await board.advance({ id: item.id, to: 'done' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HelmsmanBoardError)
    expect((err as HelmsmanBoardError).gaps).toHaveLength(1)
    expect((err as HelmsmanBoardError).gaps![0]!.label).toContain('spec')
    expect((err as HelmsmanBoardError).gaps![0]!.action).toBeTruthy()

    // A backward drag refuses the same way.
    await board.advance(item.id)
    const back = await board.advance({ id: item.id, to: 'requirements' }).catch((e: unknown) => e)
    expect((back as HelmsmanBoardError).code).toBe('INVALID_TRANSITION')
    expect((back as HelmsmanBoardError).gaps).toHaveLength(1)
    expect((await board.get(item.id))!.stage).toBe('spec')
  })
})

describe('interop: update aliases', () => {
  it('accepts { specFinalized } and opens the dev gate', async () => {
    const item = await create()
    await board.advance(item.id)
    const patched = await board.update(item.id, { specFinalized: true })
    expect(patched.gates).toEqual({ specFinalized: true })

    const [event] = await board.queryEvents({ type: 'update' })
    expect(event!.payload.changed).toEqual(['gates'])

    // Re-sending the same value is a no-op, not an event storm.
    await board.update(item.id, { specFinalized: true })
    expect(await board.queryEvents({ type: 'update' })).toHaveLength(1)

    const result = await board.advance(item.id, { to: 'dev' })
    expect(result.gaps).toEqual([])
    expect(result.item.stage).toBe('dev')
  })

  it('accepts a title + module + specFinalized patch in one call', async () => {
    const item = await create()
    await board.advance(item.id)
    const patched = await board.update(item.id, {
      title: '改过的标题',
      scope: { module: 'b' },
      specFinalized: true,
    })
    expect(patched).toMatchObject({ title: '改过的标题', scope: { module: 'b' } })
    expect(patched.gates).toEqual({ specFinalized: true })

    const [event] = await board.queryEvents({ type: 'update' })
    expect(event!.payload.changed).toEqual(['title', 'scope', 'gates'])
  })

  it('refuses to let a client write the stage directly', async () => {
    const item = await create()
    await expect(board.update(item.id, { stage: 'dev' })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect((await board.get(item.id))!.stage).toBe('requirements')

    // Echoing the current stage back is tolerated (idempotent round-trips).
    const same = await board.update(item.id, { stage: 'requirements', title: 'ok' })
    expect(same.stage).toBe('requirements')
    expect(await board.queryEvents({ type: 'update' })).toHaveLength(1)
  })

  it('rejects non-boolean gate aliases and junk stages', async () => {
    const item = await create()
    await expect(
      board.update(item.id, { specFinalized: 'yes' as unknown as boolean }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(board.update(item.id, { stage: 'nope' as never })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
  })
})

describe('interop: summary + events + wip shapes', () => {
  it('treats a bare { text } summary as a manual edit', async () => {
    const item = await create()
    const updated = await board.setSummary(item.id, { text: '用户手改' })
    expect(updated.summary).toMatchObject({ text: '用户手改', generatedBy: 'manual' })
  })

  it('supports the kind + limit event filters', async () => {
    const a = await create({ title: 'a' })
    const b = await create({ title: 'b' })
    await board.advance(a.id)

    expect((await board.queryEvents({ kind: 'advance' })).map((event) => event.itemId)).toEqual([a.id])
    expect((await board.queryEvents({ itemId: b.id, kind: 'create' })).map((event) => event.type)).toEqual(['create'])

    const newest = await board.queryEvents({ limit: 2 })
    expect(newest.map((event) => event.type)).toEqual(['create', 'advance'])
    expect(newest[0]!.itemId).toBe(b.id)
    expect(await board.queryEvents({ limit: 0 })).toEqual([])
  })

  it('keys the WIP report the way the kanban derives conflict domains', async () => {
    const item = await create()
    await board.setGates(item.id, { specFinalized: true })
    await board.advance(item.id, { to: 'dev', allowSkip: true, scope: { module: 'a' } })

    const [status] = await board.wip()
    expect(status!.key).toBe('R:a')
    expect(status!.key).toBe(status!.domain)
    expect(status!.running).toBe(1)
    expect(status!.limit).toBe(1)
    // Same key the UI would derive from the card itself.
    const derived = (await board.get(item.id))!.scope!.module
    expect(`R:${derived}`).toBe(status!.key)
  })

  it('accepts the flat { repo, module, excludeId } WIP query', async () => {
    const occupying = await create({ title: 'occupying' })
    await board.setGates(occupying.id, { specFinalized: true })
    await board.advance(occupying.id, { to: 'dev', allowSkip: true, scope: { module: 'a' } })

    const busy = board.evaluateWip({ repo: 'R', module: 'a' })
    expect(busy).toMatchObject({ key: 'R:a', allowed: false, running: 1, limit: 1 })
    expect(board.evaluateWip({ repo: 'R', module: 'b' }).allowed).toBe(true)
    // Still synchronous: a structural client may read it without awaiting.
    expect(typeof board.evaluateWip({ repo: 'R' }).allowed).toBe('boolean')
    expect(board.evaluateWip({ repo: 'R' })).toMatchObject({ key: 'R:*', allowed: true, limit: 2 })
  })

  it('defaults gate() to the next stage and is a no-op at the end', async () => {
    const item = await create()
    expect(await board.gate(item.id)).toEqual([]) // requirements → spec needs nothing

    await board.advance(item.id)
    expect((await board.gate(item.id)).map((gap) => gap.key)).toEqual(['spec-finalized'])

    const done = await create({ stage: 'done' })
    expect(await board.gate(done.id)).toEqual([])
  })

  it('hands the kanban every field its card payload reads', async () => {
    const item = await create({ scope: { module: 'a' }, summary: { text: '摘要', generatedBy: 'model' } })
    const [listed] = await board.list()

    expect(listed).toMatchObject({
      id: item.id,
      title: '卡片',
      stage: 'requirements',
      repoScope: { baseRepo: 'R' },
      scope: { module: 'a' },
      summary: { text: '摘要', generatedBy: 'model', at: expect.any(Number) },
      associations: [],
      runs: [],
      gates: {},
      createdAt: expect.any(Number),
      updatedAt: expect.any(Number),
    })
    expect(listed!.stage).toBeDefined()
  })
})
