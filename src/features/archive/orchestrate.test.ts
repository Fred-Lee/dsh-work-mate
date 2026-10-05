import { execFile } from 'node:child_process'
import { mkdtemp, rm, chmod, writeFile, readFile, mkdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseTasksMd, orchestrateArchive, orchestrateReopen } from './orchestrate.ts'
import { ProposalStore } from '../proposal/store.ts'
import { ProposalServiceImpl } from '../proposal/service.ts'
import { LifecycleServiceImpl } from './service.ts'
import { WorktreeManager } from '../worktree/manager.ts'

let home: string
let binDir: string

function git(args: string[], cwd: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', args, { cwd }, (error, _stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message))
      else resolvePromise()
    })
  })
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'workmate-orch-'))
  binDir = join(home, 'bin')
  await import('node:fs/promises').then((fs) => fs.mkdir(binDir, { recursive: true }))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('parseTasksMd', () => {
  it('counts checkbox lines only', () => {
    const snapshot = parseTasksMd('# Tasks\n\n- [x] 1. done\n- [ ] 2. todo\nnot a task\n- [X] 3. uppercase\n')
    expect(snapshot.total).toBe(3)
    expect(snapshot.done).toBe(2)
  })
})

/** Minimal archiving proposal: the review gate runs before any CLI. */
const archivingProposal = (): {
  id: string
  title: string
  status: 'archiving'
  projects: string[]
  commits: string[]
  openspecChangeId: string
  createdAt: string
  updatedAt: string
} => ({
  id: 'p1',
  title: 't',
  status: 'archiving',
  projects: [],
  commits: [],
  openspecChangeId: 'p1',
  createdAt: '2026-10-05T00:00:00.000Z',
  updatedAt: '2026-10-05T00:00:00.000Z',
})

describe('orchestrateArchive (fake CLIs)', () => {
  async function seedProject(): Promise<string> {
    const project = join(home, 'proj')
    await import('node:fs/promises').then(async (fs) => {
      await fs.mkdir(join(project, 'openspec', 'changes', 'p1'), { recursive: true })
      await fs.writeFile(join(project, 'openspec', 'changes', 'p1', 'tasks.md'), '- [x] 1. a\n- [x] 2. b\n', 'utf8')
      await fs.writeFile(
        join(project, 'openspec', 'changes', 'p1', 'review.md'),
        '## CRITICAL 问题\n\n- [x] CRIT-1 已解决\n',
        'utf8',
      )
    })
    return project
  }

  async function installFakeOpenspec(): Promise<void> {
    const path = join(binDir, 'openspec')
    await writeFile(path, '#!/bin/sh\necho "archived: $2"\n', 'utf8')
    await chmod(path, 0o755)
  }

  it('runs the full pipeline: snapshot → skip swarm → archive → analyze → archived', async () => {
    const project = await seedProject()
    await installFakeOpenspec()
    // fake gitnexus: write a marker file instead of indexing
    const gitnexusPath = join(binDir, 'gitnexus')
    await writeFile(gitnexusPath, `#!/bin/sh\necho "indexed ${project}"\n`, 'utf8')
    await chmod(gitnexusPath, 0o755)
    const savedPath = process.env['PATH']
    process.env['PATH'] = `${binDir}:${savedPath ?? ''}`

    try {
      const store = new ProposalStore({ homeRoot: home, subdir: 'workmate' })
      const proposals = new ProposalServiceImpl(store)
      await proposals.upsert({ id: 'p1', title: 't' })
      const executing = await proposals.setStatus('p1', 'implementing')

      const result = await orchestrateArchive(
        executing,
        [{ project: 'demo', root: project }],
        { openspecRoot: 'openspec' },
        { openspecBin: join(binDir, 'openspec') },
      )

      expect(result.ok).toBe(true)
      expect(result.tasks).toEqual({ done: 2, total: 2, lines: ['- [x] 1. a', '- [x] 2. b'] })
      expect(result.steps.map((s) => [s.step, s.status])).toEqual([
        ['tasks', 'ok'],
        ['swarm', 'skipped'],
        ['review-gate', 'ok'],
        ['openspec-archive', 'ok'],
        ['gitnexus-analyze', 'ok'],
        ['status', 'ok'],
      ])
      // change directory was moved to archive/ by the real openspec CLI —
      // the fake prints only, so verify the fake captured the id instead
      const fakeOutput = result.steps.find((s) => s.step === 'openspec-archive')?.summary ?? ''
      expect(fakeOutput).toContain('p1')
    } finally {
      if (savedPath !== undefined) process.env['PATH'] = savedPath
    }
  })

  it('halts with state untouched when openspec archive fails', async () => {
    const project = await seedProject()
    const path = join(binDir, 'openspec')
    await writeFile(path, '#!/bin/sh\necho "boom" >&2\nexit 1\n', 'utf8')
    await chmod(path, 0o755)

    const store = new ProposalStore({ homeRoot: home, subdir: 'workmate' })
    const proposals = new ProposalServiceImpl(store)
    await proposals.upsert({ id: 'p1', title: 't' })
    const executing = await proposals.setStatus('p1', 'implementing')

    const result = await orchestrateArchive(
      executing,
      [{ project: 'demo', root: project }],
      { openspecRoot: 'openspec', reviewGate: false },
      { openspecBin: path },
    )

    expect(result.ok).toBe(false)
    expect(result.steps.find((s) => s.step === 'openspec-archive')?.status).toBe('failed')
    expect(result.steps.find((s) => s.step === 'gitnexus-analyze')).toBeUndefined()
    expect((await proposals.get('p1'))?.status).toBe('implementing')
  })

  it('service archive stamps archived only after the pipeline succeeds', async () => {
    const project = await seedProject()
    const path = join(binDir, 'openspec')
    await writeFile(path, '#!/bin/sh\nexit 0\n', 'utf8')
    await chmod(path, 0o755)

    const store = new ProposalStore({ homeRoot: home, subdir: 'workmate' })
    const proposals = new ProposalServiceImpl(store)
    await proposals.upsert({ id: 'p1', title: 't' })
    await proposals.setStatus('p1', 'archiving')

    const okArchive = new LifecycleServiceImpl({
      proposals,
      worktree: new WorktreeManager({ subdir: 'workmate', basePort: 3000, portStep: 10, copyFiles: [], packageManager: 'pnpm' }),
      orchestrate: async () => ({ ok: true, steps: [{ step: 'status', status: 'ok', summary: '' }] }),
    })
    const okResult = (await okArchive.runArchive('p1')) as { proposal: { status: string }; orchestration?: unknown }
    expect(okResult.proposal.status).toBe('archived')
    expect(okResult.orchestration).toBeTruthy()

    await proposals.setStatus('p1', 'archiving')
    const badArchive = new LifecycleServiceImpl({
      proposals,
      worktree: new WorktreeManager({ subdir: 'workmate', basePort: 3000, portStep: 10, copyFiles: [], packageManager: 'pnpm' }),
      orchestrate: async () => ({ ok: false, steps: [{ step: 'openspec-archive', status: 'failed', summary: 'boom' }] }),
    })
    const badResult = (await badArchive.runArchive('p1')) as { proposal: { status: string }; orchestration: { ok: boolean } }
    expect(badResult.proposal.status).toBe('archiving')
    expect(badResult.orchestration.ok).toBe(false)
  })

  it('lets a shadow review through and says so in the summary', async () => {
    const project = await mkdtemp(join(tmpdir(), 'wm-shadow-'))
    await mkdir(join(project, 'openspec', 'changes', 'p1'), { recursive: true })
    await writeFile(
      join(project, 'openspec', 'changes', 'p1', 'review.md'),
      ['<!-- reviewer: auditor@1.0 shadow -->', '', '## CRITICAL 问题', '', '- [ ] CRIT-1 未修复'].join('\n'),
    )
    await writeFile(join(project, 'openspec', 'changes', 'p1', 'tasks.md'), '- [x] 1. done\n')

    const result = await orchestrateArchive(
      archivingProposal(),
      [{ project: 'demo', root: project }],
      { openspecRoot: 'openspec', gitnexusAnalyzeEnabled: false },
    )

    const gate = result.steps.find((step) => step.step === 'review-gate')
    expect(gate?.status).toBe('ok')
    expect(gate?.summary).toContain('shadow')
    expect(gate?.summary).toContain('CRIT 1/1')
    await rm(project, { recursive: true, force: true })
  })

  it('blocks the configured severities beyond CRIT', async () => {
    // A fresh project per run: the archive step may move changes/<id>/ away.
    const seed = async (): Promise<string> => {
      const project = await mkdtemp(join(tmpdir(), 'wm-high-'))
      await mkdir(join(project, 'openspec', 'changes', 'p1'), { recursive: true })
      await writeFile(
        join(project, 'openspec', 'changes', 'p1', 'review.md'),
        ['## 疑问项', '', '- [ ] HIGH-1 缺少回滚演练证据'].join('\n'),
      )
      await writeFile(join(project, 'openspec', 'changes', 'p1', 'tasks.md'), '- [x] 1. done\n')
      return project
    }

    const permissiveProject = await seed()
    const permissive = await orchestrateArchive(
      archivingProposal(),
      [{ project: 'demo', root: permissiveProject }],
      { openspecRoot: 'openspec', gitnexusAnalyzeEnabled: false },
    )
    expect(permissive.steps.find((step) => step.step === 'review-gate')?.status).toBe('ok')

    const strictProject = await seed()
    const strict = await orchestrateArchive(
      archivingProposal(),
      [{ project: 'demo', root: strictProject }],
      { openspecRoot: 'openspec', gitnexusAnalyzeEnabled: false, reviewBlockingSeverities: ['CRIT', 'HIGH'] },
    )
    const gate = strict.steps.find((step) => step.step === 'review-gate')
    expect(strict.ok).toBe(false)
    expect(gate?.status).toBe('failed')
    expect(gate?.summary).toContain('HIGH 1/1')
    expect(gate?.summary).toContain('缺少回滚演练证据')

    await rm(permissiveProject, { recursive: true, force: true })
    await rm(strictProject, { recursive: true, force: true })
  })

  it('stops on unchecked tasks and reports per-project progress', async () => {
    const projectA = await mkdtemp(join(tmpdir(), 'wm-tasks-a-'))
    const projectB = await mkdtemp(join(tmpdir(), 'wm-tasks-b-'))
    for (const [project, body] of [
      [projectA, '- [x] 1. a\n- [ ] 2. b\n'],
      [projectB, '- [x] 1. c\n'],
    ] as const) {
      await mkdir(join(project, 'openspec', 'changes', 'p1'), { recursive: true })
      await writeFile(join(project, 'openspec', 'changes', 'p1', 'tasks.md'), body, 'utf8')
    }

    const result = await orchestrateArchive(
      archivingProposal(),
      [
        { project: 'alpha', root: projectA },
        { project: 'beta', root: projectB },
      ],
      { openspecRoot: 'openspec', gitnexusAnalyzeEnabled: false },
    )

    expect(result.ok).toBe(false)
    const gate = result.steps.find((step) => step.step === 'tasks')
    expect(gate?.status).toBe('failed')
    expect(gate?.summary).toContain('[alpha] 1/2')
    expect(gate?.summary).toContain('force 可跳过')
    expect(result.steps.find((step) => step.step === 'openspec-archive')).toBeUndefined()

    await rm(projectA, { recursive: true, force: true })
    await rm(projectB, { recursive: true, force: true })
  })

  it('lets force pass the acceptance predicate', async () => {
    const project = await mkdtemp(join(tmpdir(), 'wm-tasks-force-'))
    await mkdir(join(project, 'openspec', 'changes', 'p1'), { recursive: true })
    await writeFile(join(project, 'openspec', 'changes', 'p1', 'tasks.md'), '- [ ] 1. a\n', 'utf8')
    await writeFile(join(project, 'openspec', 'changes', 'p1', 'review.md'), '## CRITICAL 问题\n\n- [x] 无\n', 'utf8')

    const result = await orchestrateArchive(
      archivingProposal(),
      [{ project: 'demo', root: project }],
      { openspecRoot: 'openspec', gitnexusAnalyzeEnabled: false, tasksGate: false, reviewGate: false },
    )

    expect(result.steps.find((step) => step.step === 'tasks')?.summary).toContain('验收谓词被 force 跳过')
    await rm(project, { recursive: true, force: true })
  })

  it('collects a delivery manifest for the archived project', async () => {
    const project = await mkdtemp(join(tmpdir(), 'wm-manifest-'))
    await mkdir(join(project, 'openspec', 'changes', 'p1'), { recursive: true })
    await writeFile(join(project, 'openspec', 'changes', 'p1', 'tasks.md'), '- [x] 1. a\n', 'utf8')
    await writeFile(join(project, 'openspec', 'changes', 'p1', 'review.md'), '## CRITICAL 问题\n\n- [x] 无\n', 'utf8')

    const result = await orchestrateArchive(
      archivingProposal(),
      [{ project: 'demo', root: project }],
      { openspecRoot: 'openspec', gitnexusAnalyzeEnabled: false },
    )

    expect(result.ok).toBe(true)
    expect(result.manifest?.projects).toHaveLength(1)
    const entry = result.manifest?.projects[0]
    expect(entry?.project).toBe('demo')
    // Not a git repo: the probes degrade to a note instead of failing the run.
    expect(entry?.commits).toEqual([])
    expect(entry?.note).toContain('git probes unavailable')
    expect(entry?.reindexed).toBe(false)
    await rm(project, { recursive: true, force: true })
  })

  it('force skips the review gate only — missing review.md otherwise blocks', async () => {
    const project = join(home, 'proj-noreview')
    await mkdir(join(project, 'openspec', 'changes', 'p1'), { recursive: true })
    await writeFile(join(project, 'openspec', 'changes', 'p1', 'tasks.md'), '- [ ] 1. a\n', 'utf8')

    const store = new ProposalStore({ homeRoot: home, subdir: 'workmate' })
    const proposals = new ProposalServiceImpl(store)
    await proposals.upsert({ id: 'p1', title: 't' })
    const executing = await proposals.setStatus('p1', 'implementing')
    const targets = [{ project: 'demo', root: project }]

    // Without force the acceptance predicate fires first (the fixture's tasks
    // are unchecked on purpose here); pass it explicitly to reach the review gate.
    const gated = await orchestrateArchive(executing, targets, { openspecRoot: 'openspec', tasksGate: false })
    expect(gated.ok).toBe(false)
    expect(gated.steps.find((s) => s.step === 'review-gate')?.status).toBe('failed')

    await installFakeOpenspec()
    const forced = await orchestrateArchive(
      executing,
      targets,
      { openspecRoot: 'openspec', reviewGate: false, tasksGate: false, gitnexusAnalyzeEnabled: false },
      { openspecBin: join(binDir, 'openspec') },
    )
    expect(forced.steps.find((s) => s.step === 'review-gate')).toMatchObject({ status: 'skipped' })
    expect(forced.steps.find((s) => s.step === 'openspec-archive')).toMatchObject({ status: 'ok' })
    expect(forced.ok).toBe(true)
  })

  it('passes the configured openspecRoot through service preconditions, writer and orchestration', async () => {
    const project = join(home, 'proj-custom-root')
    const changeDir = join(project, 'spec', 'changes', 'p1')
    await mkdir(changeDir, { recursive: true })
    await writeFile(join(changeDir, 'proposal.md'), '# P\n', 'utf8')

    const store = new ProposalStore({ homeRoot: home, subdir: 'workmate' })
    const proposals = new ProposalServiceImpl(store)
    await proposals.upsert({ id: 'p1', title: 't', projects: ['demo'] })

    const seen: Array<{ openspecRoot: string; reviewGate?: boolean }> = []
    const lifecycle = new LifecycleServiceImpl({
      proposals,
      worktree: new WorktreeManager({ subdir: 'workmate', basePort: 3000, portStep: 10, copyFiles: [], packageManager: 'pnpm' }),
      openspecRoot: 'spec',
      resolveProjectRoots: async () => [{ project: 'demo', root: project }],
      orchestrate: async (_proposal, _targets, options) => {
        seen.push({ openspecRoot: options.openspecRoot, ...(options.reviewGate !== undefined ? { reviewGate: options.reviewGate } : {}) })
        return { ok: true, steps: [{ step: 'status' as const, status: 'ok' as const, summary: '' }] }
      },
    })

    // proposing precondition reads <root>/spec/changes/p1/proposal.md — it must pass
    await expect(lifecycle.transition('p1', 'proposing')).resolves.toMatchObject({
      proposal: { status: 'proposing' },
    })

    // archiving (reached from merging: implementing/merging preconditions need
    // real branches, so seed the state directly) writes wiki.md/commits.md
    // under the CONFIGURED root, not the default 'openspec'
    await proposals.setStatus('p1', 'merging')
    await lifecycle.transition('p1', 'archiving')
    await expect(stat(join(changeDir, 'wiki.md'))).resolves.toBeTruthy()
    await expect(stat(join(changeDir, 'commits.md'))).resolves.toBeTruthy()
    await expect(stat(join(project, 'openspec', 'changes', 'p1', 'wiki.md'))).rejects.toThrow()

    await lifecycle.runArchive('p1', { force: true })
    expect(seen).toEqual([{ openspecRoot: 'spec', reviewGate: false }])
  })

  it('archived → archiving moves the change directories back (orchestrateReopen)', async () => {
    const project = join(home, 'proj-reopen')
    const archivedDir = join(project, 'openspec', 'changes', 'archive', '2026-09-28-p1')
    await mkdir(archivedDir, { recursive: true })
    await writeFile(join(archivedDir, 'proposal.md'), '# archived\n', 'utf8')

    const store = new ProposalStore({ homeRoot: home, subdir: 'workmate' })
    const proposals = new ProposalServiceImpl(store)
    await proposals.upsert({ id: 'p1', title: 't', projects: ['demo'] })
    await proposals.setStatus('p1', 'archived')

    const lifecycle = new LifecycleServiceImpl({
      proposals,
      worktree: new WorktreeManager({ subdir: 'workmate', basePort: 3000, portStep: 10, copyFiles: [], packageManager: 'pnpm' }),
      openspecRoot: 'openspec',
      resolveProjectRoots: async () => [{ project: 'demo', root: project }],
      orchestrate: async () => ({ ok: true, steps: [] }),
      reopen: (proposal, targets, options) => orchestrateReopen(proposal, targets, options),
    })

    const result = await lifecycle.transition('p1', 'archiving')
    expect(result.proposal.status).toBe('archiving')
    expect(result.orchestration?.steps).toContainEqual({
      step: 'reopen-dir',
      status: 'ok',
      summary: '[demo] restored 2026-09-28-p1 → changes/p1',
    })
    await expect(stat(join(project, 'openspec', 'changes', 'p1', 'proposal.md'))).resolves.toBeTruthy()
  })

  it('reopen never blocks the state rollback when the directory move fails', async () => {
    const store = new ProposalStore({ homeRoot: home, subdir: 'workmate' })
    const proposals = new ProposalServiceImpl(store)
    await proposals.upsert({ id: 'p1', title: 't' })
    await proposals.setStatus('p1', 'archived')

    const lifecycle = new LifecycleServiceImpl({
      proposals,
      worktree: new WorktreeManager({ subdir: 'workmate', basePort: 3000, portStep: 10, copyFiles: [], packageManager: 'pnpm' }),
      resolveProjectRoots: async () => [{ project: 'demo', root: join(home, 'no-such-project') }],
      orchestrate: async () => ({ ok: true, steps: [] }),
      reopen: (proposal, targets, options) => orchestrateReopen(proposal, targets, options),
    })

    const result = await lifecycle.transition('p1', 'archiving')
    expect(result.proposal.status).toBe('archiving')
    expect(result.orchestration?.steps.some((s) => s.step === 'reopen-dir')).toBe(true)
  })
})
