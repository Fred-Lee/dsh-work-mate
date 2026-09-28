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
  home = await mkdtemp(join(tmpdir(), 'workmate-reversible-'))
  store = new ProposalStore({ homeRoot: home, subdir: 'workmate' })
  proposals = new ProposalServiceImpl(store)
  archive = new ArchiveServiceImpl({ proposals })
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('fully reversible lifecycle', () => {
  it('stop moves executing back to draft and refuses other states', async () => {
    await proposals.upsert({ id: 'p1', title: 't' })
    await archive.start('p1')

    const stopped = await archive.stop('p1')
    expect(stopped.status).toBe('draft')

    await expect(archive.stop('p1')).rejects.toBeInstanceOf(InvalidTransitionError)
    await proposals.setStatus('p1', 'archived')
    await expect(archive.stop('p1')).rejects.toThrow('only executing proposals')
  })

  it('full round trip: start → stop → start → archive → reopen → archive', async () => {
    await proposals.upsert({ id: 'p2', title: 't' })
    await archive.start('p2')
    await archive.stop('p2')
    expect((await proposals.get('p2'))?.status).toBe('draft')

    await archive.start('p2')
    const archived = await archive.archive('p2', { openspecRoot: 'openspec' })
    expect(archived.status).toBe('archived')

    const reopened = await archive.reopen('p2', { openspecRoot: 'openspec' })
    expect(reopened.status).toBe('executing')

    const archivedAgain = await archive.archive('p2', { openspecRoot: 'openspec' })
    expect(archivedAgain.status).toBe('archived')
  })

  it('rejects stop on draft and reopen on executing with readable errors', async () => {
    await proposals.upsert({ id: 'p3', title: 't' })
    await expect(archive.reopen('p3', { openspecRoot: 'openspec' })).rejects.toThrow(
      'only archived proposals can reopen',
    )
    await expect(archive.stop('p3')).rejects.toThrow('only executing proposals can stop')
  })
})
