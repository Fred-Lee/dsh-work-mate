import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LifecycleServiceImpl } from './service.ts'
import { ProposalServiceImpl } from '../proposal/service.ts'
import { ProposalStore } from '../proposal/store.ts'
import { WorktreeManager } from '../worktree/manager.ts'

let home: string
let project: string
let proposals: ProposalServiceImpl
let lifecycle: LifecycleServiceImpl

const git = (args: string[], cwd: string): Promise<string> =>
  new Promise((resolvePromise, reject) => {
    execFile('git', args, { cwd }, (error, stdout, stderr) =>
      error ? reject(new Error(stderr || error.message)) : resolvePromise(stdout.trim()),
    )
  })

const makeLifecycle = (): LifecycleServiceImpl =>
  new LifecycleServiceImpl({
    proposals,
    worktree: new WorktreeManager({
      homeRoot: home,
      subdir: 'workmate',
      basePort: 3000,
      portStep: 10,
    }),
    openspecRoot: 'openspec',
    mainBranch: 'main',
    approvalsRequired: [],
    resolveProjectRoots: async () => [{ project: 'demo', root: project }],
    orchestrate: async () => ({ ok: true, steps: [] }),
  })

const seedTarget = async (id: string, branch: string): Promise<void> => {
  await mkdir(join(project, 'openspec', 'changes', id), { recursive: true })
  await proposals.upsert({
    id,
    title: id,
    targets: [{ project: 'demo', baseBranch: 'main', featureBranch: branch }],
  })
  await proposals.setStatus(id, 'merging')
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wm-merge-'))
  project = await mkdtemp(join(tmpdir(), 'wm-merge-proj-'))
  await git(['init', '-b', 'main'], project)
  await git(['config', 'user.email', 't@t'], project)
  await git(['config', 'user.name', 't'], project)
  await writeFile(join(project, 'a.txt'), 'base\n', 'utf8')
  await git(['add', '-A'], project)
  await git(['commit', '-m', 'init'], project)
  proposals = new ProposalServiceImpl(new ProposalStore({ homeRoot: home, subdir: 'workmate' }))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
})

describe('G5 merge on archiving', () => {
  it('merges the target feature branch into its base before archiving', async () => {
    await git(['checkout', '-b', 'feature/p1'], project)
    await writeFile(join(project, 'a.txt'), 'feature\n', 'utf8')
    await git(['commit', '-am', 'feature'], project)
    await git(['checkout', 'main'], project)
    await seedTarget('p1', 'feature/p1')

    const outcome = await makeLifecycle().transition('p1', 'archiving')
    expect(outcome.proposal.status).toBe('archiving')
    await expect(git(['merge-base', '--is-ancestor', 'feature/p1', 'main'], project)).resolves.toBe('')
  })

  it('aborts on conflict, keeps clean state and stays merging', async () => {
    await git(['checkout', '-b', 'feature/p2'], project)
    await writeFile(join(project, 'a.txt'), 'feature\n', 'utf8')
    await git(['commit', '-am', 'feature'], project)
    await git(['checkout', 'main'], project)
    await writeFile(join(project, 'a.txt'), 'main\n', 'utf8')
    await git(['commit', '-am', 'main'], project)
    await seedTarget('p2', 'feature/p2')

    await expect(makeLifecycle().transition('p2', 'archiving')).rejects.toThrow(/合并/)
    expect((await proposals.get('p2'))?.status).toBe('merging')
    await expect(git(['status', '--porcelain'], project)).resolves.toBe('')
  })
  it('merges every target into its own base branch', async () => {
    const second = await mkdtemp(join(tmpdir(), 'wm-merge-proj2-'))
    try {
      await git(['init', '-b', 'main'], second)
      await git(['config', 'user.email', 't@t'], second)
      await git(['config', 'user.name', 't'], second)
      await writeFile(join(second, 'b.txt'), 'base\n', 'utf8')
      await git(['add', '-A'], second)
      await git(['commit', '-m', 'init'], second)
      await git(['checkout', '-b', 'feature/p3'], second)
      await writeFile(join(second, 'b.txt'), 'feature\n', 'utf8')
      await git(['commit', '-am', 'feature'], second)
      await git(['checkout', 'main'], second)

      await git(['checkout', '-b', 'feature/p3'], project)
      await writeFile(join(project, 'a.txt'), 'feature\n', 'utf8')
      await git(['commit', '-am', 'feature'], project)
      await git(['checkout', 'main'], project)

      const projectLifecycle = new LifecycleServiceImpl({
        proposals,
        worktree: new WorktreeManager({
          homeRoot: home,
          subdir: 'workmate',
          basePort: 3000,
          portStep: 10,
        }),
        openspecRoot: 'openspec',
        mainBranch: 'main',
        approvalsRequired: [],
        resolveProjectRoots: async () => [
          { project: 'demo', root: project },
          { project: 'other', root: second },
        ],
        orchestrate: async () => ({ ok: true, steps: [] }),
      })
      await mkdir(join(project, 'openspec', 'changes', 'p3'), { recursive: true })
      await proposals.upsert({
        id: 'p3',
        title: 'p3',
        targets: [
          { project: 'demo', baseBranch: 'main', featureBranch: 'feature/p3' },
          { project: 'other', baseBranch: 'main', featureBranch: 'feature/p3' },
        ],
      })
      await proposals.setStatus('p3', 'merging')

      await projectLifecycle.transition('p3', 'archiving')
      await expect(git(['merge-base', '--is-ancestor', 'feature/p3', 'main'], project)).resolves.toBe('')
      await expect(git(['merge-base', '--is-ancestor', 'feature/p3', 'main'], second)).resolves.toBe('')
    } finally {
      await rm(second, { recursive: true, force: true })
    }
  })

})
