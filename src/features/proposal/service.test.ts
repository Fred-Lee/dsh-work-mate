import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProposalStore } from './store.ts'
import { ProposalServiceImpl } from './service.ts'

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
