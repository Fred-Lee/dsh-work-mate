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
  mainBranch = 'main',
): LifecycleServiceImpl =>
  new LifecycleServiceImpl({
    proposals,
    worktree: worktree as never,
    openspecRoot: 'openspec',
    mainBranch,
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

  it('passes the configured trunk to reclaim for legacy scalar proposals (MED-6)', async () => {
    // legacy 单 target 记录没有显式 targets，回收的 baseBranch 由
    // effectiveTargets 用配置主干生成——主干配置为非 'main' 分支时，
    // remove 收到的必须是配置值而非字面 'main' 兜底（fix-panel-scroll 实测卡死）。
    await proposals.upsert({
      id: 'legacy-p',
      title: 'legacy scalar',
      projects: ['a'],
    })
    await proposals.patchFields('legacy-p', { worktreePath: '/wt/legacy' })
    await proposals.setStatus('legacy-p', 'archiving')

    const removed: Array<{ projectRoot: string; baseBranch?: string; mainBranch?: string }> = []
    const lifecycle = lifecycleWith(
      [{ project: 'a', root: repoA }],
      {
        remove: async (input) => {
          removed.push({
            projectRoot: input.projectRoot,
            baseBranch: (input as { baseBranch?: string }).baseBranch,
            mainBranch: (input as { mainBranch?: string }).mainBranch,
          })
          return { removed: true, summary: 'removed' }
        },
      },
      'master', // 主干不是 'main'，验证透传的是配置值而非兜底字面量
    )

    const outcome = await lifecycle.runArchive('legacy-p')

    expect(outcome.proposal.status).toBe('archived')
    // 守卫用的是 baseBranch（由配置主干生成）；断言它不是字面 'main' 兜底。
    expect(removed).toEqual([{ projectRoot: repoA, baseBranch: 'master' }])
  })
})
