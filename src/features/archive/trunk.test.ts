/**
 * `Config.lifecycleMainBranch` (change `add-systemone-decision-provider`, task 9).
 *
 * The lifecycle git gates hard-coded `'main'`. In this repository the integration
 * trunk is `feat/workmate` (`main` holds the archived Helmsman line), so the literal
 * made `archiving` unreachable and cut the `implementing` worktree from a stale
 * `main`. These are real-git tests: a mocked git would prove nothing about which
 * branch a gate actually compared.
 */
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventLog } from '../proposal/events.ts'
import { ProposalServiceImpl } from '../proposal/service.ts'
import { ProposalStore } from '../proposal/store.ts'
import { WorktreeManager } from '../worktree/manager.ts'
import { LifecycleServiceImpl } from './service.ts'

const git = (args: string[], cwd: string): Promise<string> =>
  new Promise((resolvePromise, reject) => {
    execFile('git', args, { cwd }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message))
      else resolvePromise(stdout)
    })
  })

let home: string
let project: string
let proposals: ProposalServiceImpl

function lifecycleFor(mainBranch?: string): LifecycleServiceImpl {
  return new LifecycleServiceImpl({
    proposals,
    worktree: new WorktreeManager({
      homeRoot: home,
      subdir: 'workmate',
      basePort: 3000,
      portStep: 10,
    }),
    openspecRoot: 'openspec',
    // Omitted for the "unconfigured keeps the old default" case.
    ...(mainBranch !== undefined ? { mainBranch } : {}),
    resolveProjectRoots: async () => [{ project: 'demo', root: project }],
    approvalsRequired: [],
    orchestrate: async () => ({ ok: true, steps: [] }),
  })
}

/** Leaves `feature/p1` merged into `trunk` only — proves which branch the gate read. */
async function seedFeatureBranchMergedInto(trunk: string): Promise<void> {
  await git(['checkout', '-b', 'feature/p1', 'main'], project)
  await writeFile(join(project, 'impl.txt'), 'done\n', 'utf8')
  await git(['add', '-A'], project)
  await git(['commit', '-m', 'feat: impl [proposal:p1]', '-q'], project)
  await git(['checkout', trunk], project)
  await git(['merge', 'feature/p1', '-q', '--no-edit'], project)
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wm-trunk-home-'))
  project = await mkdtemp(join(tmpdir(), 'wm-trunk-proj-'))
  await git(['init', '-b', 'main'], project)
  await git(['config', 'user.email', 't@t'], project)
  await git(['config', 'user.name', 't'], project)
  // `main` is the archived line and stays behind the integration trunk. The change
  // directory exists on BOTH lines (the archiving side effect writes wiki.md there).
  await mkdir(join(project, 'openspec', 'changes', 'p1'), { recursive: true })
  await writeFile(join(project, 'openspec', 'changes', 'p1', 'proposal.md'), '# p1\n', 'utf8')
  await writeFile(join(project, 'README.md'), '# archived helmsman\n', 'utf8')
  await git(['add', '-A'], project)
  await git(['commit', '-m', 'chore: archived line', '-q'], project)
  await git(['checkout', '-b', 'feat/workmate'], project)
  await writeFile(join(project, 'openspec', 'changes', 'p1', 'tasks.md'), '- [x] 1. impl\n', 'utf8')
  await git(['add', '-A'], project)
  await git(['commit', '-m', 'docs: plan p1 [proposal:p1]', '-q'], project)

  proposals = new ProposalServiceImpl(
    new ProposalStore({ homeRoot: home, subdir: 'workmate' }),
    undefined,
    new EventLog({ homeRoot: home, subdir: 'workmate' }),
  )
  await proposals.upsert({ id: 'p1', title: 'trunk demo', openspecChangeId: 'p1' })
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
})

describe('archiving gate reads the configured trunk', () => {
  it('blocks a feature branch merged into main but not into the configured trunk', async () => {
    await seedFeatureBranchMergedInto('main')
    await proposals.patchFields('p1', { featureBranch: 'feature/p1' })
    await proposals.setStatus('p1', 'merging', { actor: 'human' })

    await expect(lifecycleFor('feat/workmate').transition('p1', 'archiving')).rejects.toThrow(
      /feat\/workmate/,
    )
    expect((await proposals.get('p1'))?.status).toBe('merging')
  })

  it('passes once the feature branch is merged into the configured trunk', async () => {
    await seedFeatureBranchMergedInto('feat/workmate')
    await proposals.patchFields('p1', { featureBranch: 'feature/p1' })
    await proposals.setStatus('p1', 'merging', { actor: 'human' })

    const outcome = await lifecycleFor('feat/workmate').transition('p1', 'archiving')
    expect(outcome.proposal.status).toBe('archiving')
  })

  it('keeps "main" as the default when the trunk is not configured', async () => {
    await seedFeatureBranchMergedInto('main')
    await proposals.patchFields('p1', { featureBranch: 'feature/p1' })
    await proposals.setStatus('p1', 'merging', { actor: 'human' })

    const outcome = await lifecycleFor().transition('p1', 'archiving')
    expect(outcome.proposal.status).toBe('archiving')
  })
})
