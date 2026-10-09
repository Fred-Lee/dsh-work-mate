import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SwarmManager } from './manager.ts'
import { ProposalStore } from '../proposal/store.ts'
import { ProposalServiceImpl } from '../proposal/service.ts'
import { WorktreeManager } from '../worktree/manager.ts'

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
let worktrees: WorktreeManager
let swarm: SwarmManager

const NOW = new Date('2026-10-05T12:00:00.000Z')

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wm-swarm-home-'))
  project = await mkdtemp(join(tmpdir(), 'wm-swarm-proj-'))
  await git(['init', '-b', 'main'], project)
  await git(['config', 'user.email', 't@t'], project)
  await git(['config', 'user.name', 't'], project)
  // No package.json: the worktree manager then skips dependency installation.
  await writeFile(join(project, 'app.txt'), 'line one\n', 'utf8')
  await git(['add', '-A'], project)
  await git(['commit', '-m', 'init', '-q'], project)

  const store = new ProposalStore({ homeRoot: home, subdir: 'workmate' })
  proposals = new ProposalServiceImpl(store, () => NOW)
  await proposals.upsert({ id: 'p1', title: '并行提案' })
  worktrees = new WorktreeManager({
    homeRoot: home,
    subdir: 'workmate',
    basePort: 3000,
    portStep: 10,
    copyFiles: [],
    packageManager: 'pnpm',
  })
  swarm = new SwarmManager({ proposals, worktrees, now: () => NOW, repoRoot: () => project })
  // The proposal-level carrier the merges run inside.
  await worktrees.create({ projectRoot: project, proposalId: 'p1' })
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
})

const tasks = [
  { id: 't1', title: '改 app.txt 第一部分', writes: ['app.txt'] },
  { id: 't2', title: '改 app.txt 第二部分', writes: ['app.txt'] },
]

describe('SwarmManager', () => {
  it('plans tasks, starts a carrier, and merges a task branch back', async () => {
    const planned = await swarm.plan('p1', tasks, { maxParallel: 2 })
    expect(planned.tasks.map((task) => task.status)).toEqual(['planned', 'planned'])
    // Both tasks write the same file, so they never share a batch.
    expect(planned.plan.batches.map((batch) => batch.tasks)).toEqual([['t1'], ['t2']])

    const started = await swarm.start('p1', 't1', { projectRoot: project })
    expect(started.status).toBe('running')
    expect(started.branch).toBe('feature/p1--t1')
    expect(started.worktreePath).toBe(join(project, '.workmates', 'p1--t1'))

    await writeFile(join(started.worktreePath ?? '', 'app.txt'), 'line one\nline two from t1\n', 'utf8')
    await git(['add', '-A'], started.worktreePath ?? '')
    await git(['commit', '-m', 'wip [proposal:p1]', '-q'], started.worktreePath ?? '')

    const merged = await swarm.merge('p1', 't1', { projectRoot: project })
    expect(merged.merged).toBe(true)
    expect(merged.record.status).toBe('merged')
    expect(merged.record.commit).toBeTruthy()
    expect(merged.conflicts).toEqual([])

    // The merge actually landed on the proposal branch.
    const log = await git(['log', '--oneline', '-1', 'feature/p1'], project)
    expect(log).toContain('merge t1 into feature/p1')
    expect((await swarm.list('p1')).find((task) => task.id === 't1')?.status).toBe('merged')
  })

  it('reports merge conflicts, aborts cleanly, and allows a retry', async () => {
    await swarm.plan('p1', tasks)
    const first = await swarm.start('p1', 't1', { projectRoot: project })
    const second = await swarm.start('p1', 't2', { projectRoot: project })

    for (const [task, body] of [
      [first, 't1 version\n'],
      [second, 't2 version\n'],
    ] as const) {
      await writeFile(join(task.worktreePath ?? '', 'app.txt'), body, 'utf8')
      await git(['add', '-A'], task.worktreePath ?? '')
      await git(['commit', '-m', `wip ${task.id} [proposal:p1]`, '-q'], task.worktreePath ?? '')
    }

    const clean = await swarm.merge('p1', 't1', { projectRoot: project })
    expect(clean.merged).toBe(true)

    const conflicted = await swarm.merge('p1', 't2', { projectRoot: project })
    expect(conflicted.merged).toBe(false)
    expect(conflicted.conflicts).toEqual(['app.txt'])
    expect(conflicted.record.status).toBe('failed')
    expect(conflicted.record.note).toContain('merge conflict')

    // The proposal worktree is left clean: the agent can adjudicate and retry.
    const status = await git(['status', '--porcelain'], join(project, '.workmates', 'p1'))
    expect(status.trim()).toBe('')
    expect((await swarm.list('p1')).find((task) => task.id === 't2')?.status).toBe('failed')

    // Adjudication: pull the carrier's state into the task branch, resolve there,
    // commit, then retry the merge into the implementation branch.
    await git(['merge', 'feature/p1'], second.worktreePath ?? '').catch(() => '')
    await writeFile(join(second.worktreePath ?? '', 'app.txt'), 't1 version\nt2 version\n', 'utf8')
    await git(['add', '-A'], second.worktreePath ?? '')
    await git(['commit', '-m', 'resolve t2 [proposal:p1]', '-q'], second.worktreePath ?? '')
    const retried = await swarm.merge('p1', 't2', { projectRoot: project })
    expect(retried.merged).toBe(true)
    expect(retried.record.status).toBe('merged')
  })

  it('refuses to start a merged task and to merge a task with no carrier', async () => {
    await swarm.plan('p1', tasks)
    await swarm.start('p1', 't1', { projectRoot: project })
    await writeFile(join(project, '.workmates', 'p1--t1', 'app.txt'), 'x\n', 'utf8')

    await expect(swarm.merge('p1', 't2', { projectRoot: project })).rejects.toThrow(/start it first/)
    await expect(swarm.start('p1', 'nope', { projectRoot: project })).rejects.toThrow(/unknown swarm task/)
  })

  it('keeps the status of tasks that survive a replan', async () => {
    await swarm.plan('p1', tasks)
    await swarm.start('p1', 't1', { projectRoot: project })

    const replanned = await swarm.plan('p1', [{ id: 't1', title: '改名后的任务', writes: ['app.txt'] }])

    expect(replanned.tasks[0]?.status).toBe('running')
    expect(replanned.tasks[0]?.branch).toBe('feature/p1--t1')
    expect(replanned.tasks[0]?.title).toBe('改名后的任务')
  })
})

describe('task verification (wire-swarm-independent-review)', () => {
  const planOne = async (): Promise<void> => {
    await swarm.plan('p1', [{ id: 't1', title: '任务一', writes: ['app.txt'] }])
    await swarm.start('p1', 't1', { projectRoot: project })
    await swarm.merge('p1', 't1', { projectRoot: project })
  }

  it('refuses to verify a task that has not merged', async () => {
    await swarm.plan('p1', [{ id: 't1', title: '任务一', writes: ['app.txt'] }])
    await expect(
      swarm.verify('p1', 't1', { reviewer: 'auditor', verdict: 'verified' }),
    ).rejects.toThrow(/独立核验只对已合并的任务有意义/)
  })

  it('refuses an unsigned check', async () => {
    await planOne()
    await expect(swarm.verify('p1', 't1', { reviewer: '  ', verdict: 'verified' })).rejects.toThrow(/必须署名/)
  })

  it('records the check and reads the task authors from git', async () => {
    await planOne()
    const result = await swarm.verify('p1', 't1', {
      reviewer: 'auditor@2',
      verdict: 'verified',
      evidence: 'pnpm exec vitest run src/features/swarm',
    })
    expect(result.independence).toBe('independent')
    expect(result.task.verification).toMatchObject({
      reviewer: 'auditor@2',
      verdict: 'verified',
      independence: 'independent',
      at: NOW.toISOString(),
    })
    expect(result.task.verification?.evidence).toContain('vitest')
  })

  it('catches the author checking their own task', async () => {
    await planOne()
    // The commits in this repository are authored by `t <t@t>` (see beforeEach).
    const result = await swarm.verify('p1', 't1', { reviewer: 't', verdict: 'verified' })
    expect(result.independence).toBe('same-as-author')
    expect(result.note).toContain('同一身份')
  })

  it('degrades to undetermined when no repository is configured', async () => {
    const detached = new SwarmManager({ proposals, worktrees, now: () => NOW })
    await planOne()
    const result = await detached.verify('p1', 't1', { reviewer: 'auditor@2', verdict: 'issues' })
    expect(result.independence).toBe('undetermined')
  })

  it('keeps the verification record when the plan is rebuilt', async () => {
    await planOne()
    await swarm.verify('p1', 't1', { reviewer: 'auditor@2', verdict: 'verified' })
    const replanned = await swarm.plan('p1', [{ id: 't1', title: '任务一', writes: ['app.txt'] }])
    expect(replanned.tasks[0]?.verification?.reviewer).toBe('auditor@2')
    expect(replanned.tasks[0]?.status).toBe('merged')
  })
})
