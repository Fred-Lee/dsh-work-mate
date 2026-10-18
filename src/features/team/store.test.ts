import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TeamRunStore } from './store.ts'
import { DEFAULT_TEAM_BUDGET, type TeamRun } from './types.ts'
import { StoreCorruptError } from '../proposal/store.ts'

let home: string
let store: TeamRunStore

const run = (id: string): TeamRun => ({
  id,
  proposalId: 'p1',
  template: 'requirement-full',
  status: 'planned',
  tasks: [],
  budget: DEFAULT_TEAM_BUDGET,
  createdAt: '2026-10-19T00:00:00.000Z',
  updatedAt: '2026-10-19T00:00:00.000Z',
})

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wm-team-store-'))
  store = new TeamRunStore({ homeRoot: home, subdir: 'workmate' })
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('TeamRunStore', () => {
  it('reads a missing file as no runs', async () => {
    await expect(store.list()).resolves.toEqual([])
    await expect(store.get('ghost')).resolves.toBeUndefined()
  })

  it('round-trips upsert / get / patch and preserves createdAt', async () => {
    const first = await store.upsert(run('r1'))
    expect(first.createdAt).toBe('2026-10-19T00:00:00.000Z')

    const later = new Date('2026-10-19T01:00:00.000Z')
    const patched = await store.patch('r1', { status: 'running' }, () => later)
    expect(patched.status).toBe('running')
    expect(patched.createdAt).toBe(first.createdAt)
    expect(patched.updatedAt).toBe(later.toISOString())

    const again = await store.upsert({ ...run('r1'), status: 'succeeded' }, () => later)
    expect(again.createdAt).toBe(first.createdAt)
    await expect(store.list()).resolves.toHaveLength(1)
  })

  it('fills a missing budget from the default', async () => {
    const { budget: _budget, ...withoutBudget } = run('r2')
    const runs = [withoutBudget as unknown as TeamRun]
    await store.save(runs)
    await expect(store.get('r2')).resolves.toMatchObject({ budget: DEFAULT_TEAM_BUDGET })
  })

  it('fails closed on a corrupt file and never overwrites it', async () => {
    const { file } = store.paths()
    await mkdir(join(home, 'workmate'), { recursive: true })
    const corrupt = '[{"id":"r1"'
    await writeFile(file, corrupt, 'utf8')

    await expect(store.list()).rejects.toBeInstanceOf(StoreCorruptError)
    await expect(store.upsert(run('r1'))).rejects.toBeInstanceOf(StoreCorruptError)
    await expect(store.patch('r1', { status: 'running' })).rejects.toBeInstanceOf(StoreCorruptError)
  })
})
