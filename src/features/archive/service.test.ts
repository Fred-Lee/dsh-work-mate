import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProposalStore } from '../proposal/store.ts'
import { ProposalServiceImpl } from '../proposal/service.ts'
import { ArchiveServiceImpl, InvalidTransitionError } from './service.ts'

let home: string
let store: ProposalStore
let proposals: ProposalServiceImpl
let archive: ArchiveServiceImpl

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'workmate-archive-'))
  store = new ProposalStore({ homeRoot: home, subdir: 'workmate' })
  proposals = new ProposalServiceImpl(store)
  archive = new ArchiveServiceImpl({ proposals })
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('archive state machine', () => {
  it('moves draft → executing → archived', async () => {
    await proposals.upsert({ id: 'p1', title: 't' })

    const executing = await archive.start('p1')
    expect(executing.status).toBe('executing')

    const archived = await archive.archive('p1', { openspecRoot: 'openspec' })
    expect(archived.status).toBe('archived')

    const stored = await proposals.get('p1')
    expect(stored?.status).toBe('archived')
  })

  it('refuses archiving a draft directly', async () => {
    await proposals.upsert({ id: 'p2', title: 't' })
    await expect(archive.archive('p2', { openspecRoot: 'openspec' })).rejects.toBeInstanceOf(
      InvalidTransitionError,
    )
    expect((await proposals.get('p2'))?.status).toBe('draft')
  })

  it('refuses archiving when the openspec change dir is missing (unless forced)', async () => {
    await proposals.upsert({ id: 'p3', title: 't' })
    await archive.start('p3')

    const strict = new ArchiveServiceImpl({
      proposals,
      async changeDirExists() {
        return false
      },
    })
    await expect(
      strict.archive('p3', { openspecRoot: 'openspec', projectRoot: '/proj' }),
    ).rejects.toThrow('not found')

    const forced = await strict.archive('p3', {
      openspecRoot: 'openspec',
      projectRoot: '/proj',
      force: true,
    })
    expect(forced.status).toBe('archived')
  })

  it('accepts the transition when the change dir exists', async () => {
    await proposals.upsert({ id: 'p4', title: 't' })
    await archive.start('p4')

    const lenient = new ArchiveServiceImpl({
      proposals,
      async changeDirExists() {
        return true
      },
    })
    await expect(
      lenient.archive('p4', { openspecRoot: 'openspec', projectRoot: '/proj' }),
    ).resolves.toMatchObject({ status: 'archived' })
  })

  it('archives without a projectRoot (headless proposals) with no probe', async () => {
    await proposals.upsert({ id: 'p5', title: 't' })
    await archive.start('p5')
    // no changeDirExists wired at all — absence of a root skips the probe
    await expect(archive.archive('p5', { openspecRoot: 'openspec' })).resolves.toMatchObject({
      status: 'archived',
    })
  })
})
