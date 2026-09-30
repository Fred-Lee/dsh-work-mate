import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProposalStore, StoreCorruptError, resolveDshHome } from './store.ts'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'workmate-store-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

function makeStore(subdir = 'workmate'): ProposalStore {
  return new ProposalStore({ homeRoot: home, subdir })
}

describe('resolveDshHome', () => {
  it('prefers the explicit value (test injection)', () => {
    expect(resolveDshHome('/explicit')).toBe('/explicit')
  })

  it('falls back to $DSH_HOME then ~/.dsh', () => {
    const previous = process.env['DSH_HOME']
    try {
      process.env['DSH_HOME'] = '/from-env'
      expect(resolveDshHome()).toBe('/from-env')
      delete process.env['DSH_HOME']
      expect(resolveDshHome()).toBe(join(process.env['HOME'] ?? '', '.dsh'))
    } finally {
      if (previous === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = previous
    }
  })
})

describe('ProposalStore', () => {
  it('resolves root and proposals file under the given home', () => {
    const store = makeStore('wm-custom')
    expect(store.paths()).toEqual({
      root: join(home, 'wm-custom'),
      proposals: join(home, 'wm-custom', 'proposals.json'),
    })
  })

  it('reads a missing file as an empty list', async () => {
    await expect(makeStore().load()).resolves.toEqual([])
  })

  it('round-trips proposals through atomic tmp+rename', async () => {
    const store = makeStore()
    const proposal = {
      id: 'batch-grading-v2',
      title: '批量批改 v2.1',
      status: 'draft',
      projects: ['grading-core'],
      commits: [],
      openspecChangeId: 'batch-grading-v2',
      decisions: [],
      blockers: [],
      wikiLinks: [],
      createdAt: '2026-09-28T00:00:00.000Z',
      updatedAt: '2026-09-28T00:00:00.000Z',
    }
    await store.save([proposal])

    // tmp must be gone after the rename
    await expect(readFile(store.paths().proposals + '.tmp', 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await expect(store.load()).resolves.toEqual([proposal])
  })

  it('createRoots the directory on save without a prior ensureRoot', async () => {
    const store = makeStore('deep/nested/wm')
    await store.save([])
    await expect(store.load()).resolves.toEqual([])
  })

  it('fails closed on corrupt content instead of silently resetting it', async () => {
    const store = makeStore()
    await store.ensureRoot()
    await writeFile(store.paths().proposals, '{ not json', 'utf8')

    await expect(store.load()).rejects.toBeInstanceOf(StoreCorruptError)
  })

  it('rejects a non-array payload as corrupt', async () => {
    const store = makeStore()
    await store.ensureRoot()
    await writeFile(store.paths().proposals, '{"id":"x"}', 'utf8')

    await expect(store.load()).rejects.toBeInstanceOf(StoreCorruptError)
  })
})
