import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LifecycleServiceImpl } from './service.ts'
import { ProposalServiceImpl } from '../proposal/service.ts'
import { ProposalStore } from '../proposal/store.ts'

const exec = promisify(execFile)

let home: string
let proposals: ProposalServiceImpl
let repoA: string
let repoB: string

const git = async (args: string[], cwd: string): Promise<string> => (await exec('git', args, { cwd })).stdout

async function seedRepo(branch: string): Promise<string> {
  const root = await mkdtemp(join(home, `repo-${branch}-`))
  await git(['init', '-q', '-b', branch], root)
  await git(['config', 'user.email', 't@t'], root)
  await git(['config', 'user.name', 't'], root)
  await writeFile(join(root, 'README.md'), '# r\n', 'utf8')
  await git(['add', '-A'], root)
  await git(['commit', '-q', '-m', 'init'], root)
  return root
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wm-multitarget-'))
  proposals = new ProposalServiceImpl(new ProposalStore({ homeRoot: home, subdir: 'workmate' }))
  repoA = await seedRepo('main')
  repoB = await seedRepo('master')
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

const lifecycleWith = (
  roles: { project: string; root: string }[],
  worktree: {
    createTarget?: (input: unknown) => Promise<unknown>
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
    resolveProjectRoots: async () => roles,
    orchestrate: async () => ({ ok: true, steps: [] }),
    onImplementing: async () => ({ created: [], existing: [] }),
  })

describe('ready → implementing 只校验基线，不建目录', () => {
  it('keeps every target and creates no worktree', async () => {
    await proposals.upsert({
      id: 'p1',
      title: 'multi',
      targets: [
        { project: 'a', baseBranch: 'main' },
        { project: 'b', baseBranch: 'master' },
      ],
    })
    await proposals.setStatus('p1', 'ready')

    const created: unknown[] = []
    const lifecycle = lifecycleWith(
      [
        { project: 'a', root: repoA },
        { project: 'b', root: repoB },
      ],
      {
        // 不应被调用：目录归 Super-agent 的 prepare（design D10b）。
        createTarget: async (input) => {
          created.push(input)
          throw new Error('must not create a worktree')
        },
        remove: async () => ({ removed: true, summary: 'removed' }),
      },
    )

    const outcome = await lifecycle.transition('p1', 'implementing')
    expect(created).toEqual([])
    expect(outcome.worktree?.targets).toHaveLength(2)
    expect(outcome.worktree?.worktreePath).toBe('')

    const stored = await proposals.get('p1')
    expect(stored?.status).toBe('implementing')
    expect(stored?.targets?.map((target) => [target.project, target.baseBranch])).toEqual([
      ['a', 'main'],
      ['b', 'master'],
    ])
    // 没有 worktree 就没有 featureBranch/worktreePath 可写。
    expect(stored?.targets?.every((target) => target.worktreePath === undefined && target.featureBranch === undefined)).toBe(true)
    expect(stored?.worktreePath).toBeUndefined()
  })

  it('refuses the transition and stays ready when a base branch is missing', async () => {
    await proposals.upsert({
      id: 'p2',
      title: 'missing base',
      targets: [
        { project: 'a', baseBranch: 'main' },
        { project: 'b', baseBranch: 'no-such-branch' },
      ],
    })
    await proposals.setStatus('p2', 'ready')

    const lifecycle = lifecycleWith(
      [
        { project: 'a', root: repoA },
        { project: 'b', root: repoB },
      ],
      { remove: async () => ({ removed: true, summary: 'removed' }) },
    )

    await expect(lifecycle.transition('p2', 'implementing')).rejects.toThrow(/基线分支不存在/)
    const stored = await proposals.get('p2')
    expect(stored?.status).toBe('ready')
    expect(stored?.targets).toEqual([
      { project: 'a', baseBranch: 'main' },
      { project: 'b', baseBranch: 'no-such-branch' },
    ])
  })
})

describe('archiving 仍逐 target 回收遗留 worktree', () => {
  it('cleans up every target worktree on archive', async () => {
    await proposals.upsert({
      id: 'p3',
      title: 'multi archive',
      targets: [
        { project: 'a', baseBranch: 'main', featureBranch: 'feature/p3', worktreePath: '/wt/a' },
        { project: 'b', baseBranch: 'master', featureBranch: 'feature/p3', worktreePath: '/wt/b' },
      ],
    })
    await proposals.setStatus('p3', 'archiving')

    const removed: Array<{ projectRoot: string; project?: string; baseBranch?: string }> = []
    const lifecycle = lifecycleWith(
      [
        { project: 'a', root: repoA },
        { project: 'b', root: repoB },
      ],
      {
        remove: async (input) => {
          removed.push({
            projectRoot: input.projectRoot,
            ...(input.project !== undefined ? { project: input.project } : {}),
          })
          return { removed: true, summary: 'removed' }
        },
      },
    )

    const outcome = await lifecycle.runArchive('p3')

    expect(outcome.proposal.status).toBe('archived')
    expect(removed).toEqual([
      { projectRoot: repoA, project: 'a' },
      { projectRoot: repoB, project: 'b' },
    ])
  })
})
