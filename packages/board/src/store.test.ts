import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, appendFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BOARD_SCHEMA_VERSION, BoardStore, defaultBoardRootDir } from './store.ts'
import { HelmsmanBoardError } from './errors.ts'
import type { WorkItem } from './model.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'helmsman-board-store-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function makeItem(id: string, over: Partial<WorkItem> = {}): WorkItem {
  return {
    id,
    title: `card ${id}`,
    summary: { text: 'summary', generatedBy: 'manual', at: 1 },
    repoScope: { baseRepo: 'R' },
    stage: 'requirements',
    gates: {},
    associations: [],
    runs: [],
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

/** Appends one card through the store's serialized mutation path. */
function put(store: BoardStore, item: WorkItem): Promise<unknown> {
  return store.transact((items) => ({
    result: item.id,
    items: [...items, item],
    events: [{ type: 'create' as const, itemId: item.id, payload: { title: item.title } }],
  }))
}

describe('BoardStore location', () => {
  it('resolves the default root from HELMSMAN_HOME, else ~/.helmsman', () => {
    const home = join(dir, 'hh')
    const previous = process.env.HELMSMAN_HOME
    try {
      process.env.HELMSMAN_HOME = home
      expect(defaultBoardRootDir()).toBe(join(home, 'board'))
      expect(new BoardStore().rootDir).toBe(join(home, 'board'))
      expect(new BoardStore().itemsFile).toBe(join(home, 'board', 'items.json'))
      delete process.env.HELMSMAN_HOME
      expect(defaultBoardRootDir()).toBe(join(homedir(), '.helmsman', 'board'))
    } finally {
      if (previous === undefined) delete process.env.HELMSMAN_HOME
      else process.env.HELMSMAN_HOME = previous
    }
  })

  it('honours an explicit rootDir and reports a healthy empty store', async () => {
    const store = new BoardStore({ rootDir: join(dir, 'board') })
    expect(store.rootDir).toBe(join(dir, 'board'))
    expect(store.warmUp()).toBeNull()
    expect(store.snapshot()).toEqual([])
    expect(await store.events()).toEqual([])
  })
})

describe('BoardStore snapshot write', () => {
  it('writes items.json atomically with a schemaVersion and no tmp leftovers', async () => {
    const store = new BoardStore({ rootDir: join(dir, 'board') })
    await put(store, makeItem('wi_a'))

    const parsed = JSON.parse(await readFile(store.itemsFile, 'utf8')) as {
      schemaVersion: number
      items: WorkItem[]
    }
    expect(parsed.schemaVersion).toBe(BOARD_SCHEMA_VERSION)
    expect(parsed.items.map((item) => item.id)).toEqual(['wi_a'])

    // tmp+rename leaves the directory clean, so a crash window is the only way
    // to see a stray file.
    expect((await readdir(store.rootDir)).sort()).toEqual(['events.jsonl', 'items.json'])
  })

  it('round-trips through a fresh instance (restart survival)', async () => {
    const rootDir = join(dir, 'board')
    await put(new BoardStore({ rootDir }), makeItem('wi_a', { stage: 'dev', gates: { specFinalized: true } }))

    const reopened = new BoardStore({ rootDir })
    const items = reopened.snapshot()
    expect(items).toHaveLength(1)
    expect(items[0]!.stage).toBe('dev')
    expect(items[0]!.gates).toEqual({ specFinalized: true })
    expect((await reopened.events()).map((event) => event.type)).toEqual(['create'])
  })
})

describe('BoardStore event stream', () => {
  it('keeps ts strictly increasing, even across restarts', async () => {
    const rootDir = join(dir, 'board')
    const first = new BoardStore({ rootDir })
    await put(first, makeItem('wi_a'))
    const seeded = await first.events()
    expect(seeded).toHaveLength(1)

    // A brand-new process would seed its clock from the file tail.
    const second = new BoardStore({ rootDir })
    await put(second, makeItem('wi_b'))

    const events = await second.events()
    expect(events.map((event) => event.itemId)).toEqual(['wi_a', 'wi_b'])
    expect(events[1]!.ts).toBeGreaterThan(events[0]!.ts)
  })

  it('ignores a torn trailing line from a crash mid-append', async () => {
    const store = new BoardStore({ rootDir: join(dir, 'board') })
    await put(store, makeItem('wi_a'))
    await appendFile(store.eventsFile, '{"v":1,"ts":1,"type":"advan', 'utf8')

    const events = await store.events()
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('create')
  })

  it('skips rows of an unknown event version or shape', async () => {
    const store = new BoardStore({ rootDir: join(dir, 'board') })
    await mkdir(store.rootDir, { recursive: true })
    await writeFile(
      store.eventsFile,
      [
        JSON.stringify({ v: 2, ts: 1, type: 'create', itemId: 'x', payload: {} }),
        JSON.stringify({ v: 1, ts: 2, type: 'create', itemId: 'y' }),
        JSON.stringify({ v: 1, ts: 3, type: 'advance', itemId: 'z', payload: { from: 'spec' } }),
        '',
      ].join('\n'),
      'utf8',
    )

    const events = await store.events()
    expect(events.map((event) => event.itemId)).toEqual(['z'])
  })

  it('keeps applied state when the event append itself fails', async () => {
    const rootDir = join(dir, 'board')
    const store = new BoardStore({ rootDir })
    await put(store, makeItem('wi_a'))
    // Make events.jsonl unwritable *as a file* by replacing it with a directory.
    await rm(store.eventsFile, { force: true })
    await mkdir(store.eventsFile, { recursive: true })

    await expect(put(store, makeItem('wi_b'))).rejects.toMatchObject({ code: 'EVENT_WRITE_FAILED' })
    // The card snapshot is the source of truth and did land.
    expect(store.snapshot().map((item) => item.id)).toEqual(['wi_a', 'wi_b'])
  })
})

describe('BoardStore failure policy', () => {
  it('reports corrupt JSON and never overwrites the file', async () => {
    const rootDir = join(dir, 'board')
    const store = new BoardStore({ rootDir })
    await mkdir(rootDir, { recursive: true })
    const garbage = '{ "schemaVersion": 1, "items": [ this is not json'
    await writeFile(store.itemsFile, garbage, 'utf8')

    const failure = store.warmUp()
    expect(failure).toBeInstanceOf(HelmsmanBoardError)
    expect(failure!.code).toBe('STORE_CORRUPT')
    expect(failure!.message).toContain('items.json')

    expect(() => store.snapshot()).toThrowError(/corrupt/)
    await expect(put(store, makeItem('wi_a'))).rejects.toMatchObject({ code: 'STORE_CORRUPT' })

    // The user's file is left exactly as found; nothing was rebuilt.
    expect(await readFile(store.itemsFile, 'utf8')).toBe(garbage)
    expect((await readdir(rootDir)).sort()).toEqual(['items.json'])
  })

  it('rejects a structurally invalid snapshot instead of half-reading it', async () => {
    const rootDir = join(dir, 'board')
    const store = new BoardStore({ rootDir })
    await mkdir(rootDir, { recursive: true })

    for (const body of [
      JSON.stringify({ schemaVersion: BOARD_SCHEMA_VERSION, items: 'nope' }),
      JSON.stringify({ schemaVersion: BOARD_SCHEMA_VERSION, items: [{ id: 'wi_a', title: 'x', stage: 'nope' }] }),
      JSON.stringify({ schemaVersion: BOARD_SCHEMA_VERSION, items: [makeItem('wi_a'), makeItem('wi_a')] }),
      JSON.stringify({ items: [] }),
      '[]',
    ]) {
      await writeFile(store.itemsFile, body, 'utf8')
      const fresh = new BoardStore({ rootDir })
      expect(fresh.warmUp()?.code).toBe('STORE_CORRUPT')
    }
  })

  it('reports an unsupported schemaVersion rather than guessing', async () => {
    const rootDir = join(dir, 'board')
    await mkdir(rootDir, { recursive: true })
    const body = JSON.stringify({ schemaVersion: BOARD_SCHEMA_VERSION + 1, items: [] })
    await writeFile(join(rootDir, 'items.json'), body, 'utf8')

    const store = new BoardStore({ rootDir })
    const failure = store.warmUp()
    expect(failure?.code).toBe('SCHEMA_UNSUPPORTED')
    expect(failure?.details.schemaVersion).toBe(BOARD_SCHEMA_VERSION + 1)
    expect(await readFile(store.itemsFile, 'utf8')).toBe(body)
  })

  it('errors on an unwritable root without touching existing files', async () => {
    // An ancestor that is a regular file makes mkdir fail (ENOTDIR).
    const blocker = join(dir, 'not-a-dir')
    await writeFile(blocker, 'keep me', 'utf8')
    const store = new BoardStore({ rootDir: join(blocker, 'board') })

    await expect(put(store, makeItem('wi_a'))).rejects.toMatchObject({ code: 'STORE_WRITE_FAILED' })
    expect(await readFile(blocker, 'utf8')).toBe('keep me')
  })

  it('errors when the snapshot cannot be replaced and cleans up its tmp file', async () => {
    const rootDir = join(dir, 'board')
    const store = new BoardStore({ rootDir })
    await put(store, makeItem('wi_a'))
    // Replace items.json with a DIRECTORY: the write path can create its tmp
    // file but can never rename it into place.
    await rm(store.itemsFile, { force: true })
    await mkdir(store.itemsFile, { recursive: true })

    await expect(put(store, makeItem('wi_b'))).rejects.toMatchObject({ code: 'STORE_WRITE_FAILED' })
    expect((await readdir(rootDir)).sort()).toEqual(['events.jsonl', 'items.json'])
    // The failed attempt left no tmp litter…
    expect(await readdir(store.itemsFile)).toEqual([])
    // …and the in-memory state still matches the last successful write.
    expect(store.snapshot().map((item) => item.id)).toEqual(['wi_a'])
  })
})
