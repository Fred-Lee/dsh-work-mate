import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LifecycleServiceImpl } from './service.ts'
import { ProposalServiceImpl } from '../proposal/service.ts'
import { ProposalStore } from '../proposal/store.ts'

let home: string
let proposals: ProposalServiceImpl

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wm-multitarget-'))
  proposals = new ProposalServiceImpl(new ProposalStore({ homeRoot: home, subdir: 'workmate' }))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

interface Created {
  projectRoot: string
  project: string
  baseBranch: string
}

const lifecycleWith = (
  worktree: {
    createTarget: (input: Created & { proposalId: string }) => Promise<{
      worktreePath: string
      featureBranch: string
      portRange: number[]
      copied: string[]
      install: 'installed' | 'skipped' | 'failed'
    }>
    remove: (input: { projectRoot: string; project?: string; proposalId: string; force?: boolean }) => Promise<{
      removed: boolean
      summary: string
    }>
  },
): LifecycleServiceImpl =>
  new LifecycleServiceImpl({
    proposals,
    worktree: worktree as never,
    openspecRoot: 'openspec',
    mainBranch: 'main',
    approvalsRequired: [],
    resolveProjectRoots: async () => [
      { project: 'a', root: '/repo/a' },
      { project: 'b', root: '/repo/b' },
    ],
    orchestrate: async () => ({ ok: true, steps: [] }),
  })

describe('multi-target implementing', () => {
  it('creates one worktree per target and records the matrix', async () => {
    await proposals.upsert({
      id: 'p1',
      title: 'multi',
      targets: [
        { project: 'a', baseBranch: 'main' },
        { project: 'b', baseBranch: 'master' },
      ],
    })
    await proposals.setStatus('p1', 'ready')

    const calls: Array<Created & { proposalId: string }> = []
    const lifecycle = lifecycleWith({
      createTarget: async (input) => {
        calls.push(input)
        return {
          worktreePath: `/wt/${input.project}`,
          featureBranch: 'feature/p1',
          portRange: input.project === 'a' ? [3000, 3001] : [3010, 3011],
          copied: [],
          install: 'skipped',
        }
      },
      remove: async () => ({ removed: true, summary: 'removed' }),
    })

    const outcome = await lifecycle.transition('p1', 'implementing')

    expect(calls.map((call) => [call.project, call.baseBranch])).toEqual([
      ['a', 'main'],
      ['b', 'master'],
    ])
    expect(outcome.worktree?.targets).toHaveLength(2)
    expect(outcome.worktree?.targets?.map((target) => [target.project, target.worktreePath])).toEqual([
      ['a', '/wt/a'],
      ['b', '/wt/b'],
    ])
    const stored = await proposals.get('p1')
    expect(stored?.status).toBe('implementing')
    expect(stored?.targets).toEqual([
      { project: 'a', baseBranch: 'main', featureBranch: 'feature/p1', worktreePath: '/wt/a', portRange: [3000, 3001] },
      { project: 'b', baseBranch: 'master', featureBranch: 'feature/p1', worktreePath: '/wt/b', portRange: [3010, 3011] },
    ])
    // Multi-target does not leave a misleading scalar carrier.
    expect(stored?.worktreePath).toBeUndefined()
    expect(stored?.featureBranch).toBeUndefined()
  })

  it('rolls back created targets and stays ready when a later target fails', async () => {
    await proposals.upsert({
      id: 'p2',
      title: 'multi fail',
      targets: [
        { project: 'a', baseBranch: 'main' },
        { project: 'b', baseBranch: 'main' },
      ],
    })
    await proposals.setStatus('p2', 'ready')

    const removed: Array<{ projectRoot: string; project?: string }> = []
    const lifecycle = lifecycleWith({
      createTarget: async (input) => {
        if (input.project === 'b') throw new Error('boom')
        return {
          worktreePath: `/wt/${input.project}`,
          featureBranch: 'feature/p2',
          portRange: [3000],
          copied: [],
          install: 'skipped',
        }
      },
      remove: async (input) => {
        removed.push({ projectRoot: input.projectRoot, ...(input.project !== undefined ? { project: input.project } : {}) })
        return { removed: true, summary: 'removed' }
      },
    })

    await expect(lifecycle.transition('p2', 'implementing')).rejects.toThrow(/已回滚 1 个/)

    expect(removed).toEqual([{ projectRoot: '/repo/a', project: 'a' }])
    const stored = await proposals.get('p2')
    expect(stored?.status).toBe('ready')
    expect(stored?.targets).toEqual([
      { project: 'a', baseBranch: 'main' },
      { project: 'b', baseBranch: 'main' },
    ])
  })
})
