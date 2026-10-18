import { execFile } from 'node:child_process'
import { mkdtemp, rm, chmod, writeFile, readFile, mkdir, readdir, stat } from 'node:fs/promises'
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
const archivingProposal = (
  swarmTasks?: Array<{ id: string; status: 'planned' | 'running' | 'merged' | 'failed' }>,
): {
  id: string
  title: string
  status: 'archiving'
  projects: string[]
  commits: string[]
  openspecChangeId: string
  createdAt: string
  updatedAt: string
  swarmTasks?: Array<{ id: string; status: 'planned' | 'running' | 'merged' | 'failed' }>
} => ({
  id: 'p1',
  title: 't',
  status: 'archiving',
  projects: [],
  commits: [],
  openspecChangeId: 'p1',
  createdAt: '2026-10-05T00:00:00.000Z',
  updatedAt: '2026-10-05T00:00:00.000Z',
  ...(swarmTasks !== undefined ? { swarmTasks } : {}),
})

describe('orchestrateArchive (fake CLIs)', () => {
  async function seedProject(): Promise<string> {
    const project = join(home, 'proj')
    await import('node:fs/promises').then(async (fs) => {
      await mkdir(join(project, 'openspec', 'changes', 'p1'), { recursive: true })
      await writeFile(join(project, 'openspec', 'changes', 'p1', 'tasks.md'), '- [x] 1. a\n- [x] 2. b\n', 'utf8')
      await writeFile(
        join(project, 'openspec', 'changes', 'p1', 'review.md'),
        '## CRITICAL 问题\n\n- [x] CRIT-1 已解决\n',
        'utf8',
      )
    })
    return project
  }

  /**
   * Fake `openspec archive <id> --yes` that behaves like the real CLI on success:
   * it MOVES `changes/<id>/` into `changes/archive/<date>-<id>/`. The pipeline
   * verifies that product fact rather than the exit code (change
   * `harden-openspec-archive-step`), so a fake that only prints would be a lie —
   * and every "archive succeeded" assertion below would be testing the lie.
   * cwd is the target root, so relative paths are the project's.
   */
  async function installFakeOpenspec(): Promise<void> {
    const path = join(binDir, 'openspec')
    await writeFile(
      path,
      [
        '#!/bin/sh',
        'set -e',
        'mkdir -p "openspec/changes/archive/2026-01-01-$2"',
        'mv "openspec/changes/$2" "openspec/changes/archive/2026-01-01-$2"',
        'echo "Change \'$2\' archived as \'2026-01-01-$2\'."',
        '',
      ].join('\n'),
      'utf8',
    )
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
        ['swarm', 'ok'],   // 无 swarm 任务时如实报告，而非含糊的 not wired
        ['review-gate', 'ok'],
        ['openspec-archive', 'ok'],
        ['gitnexus-analyze', 'ok'],
        ['status', 'ok'],
      ])
      // The change directory really moved: judge the product fact, not the fake's echo.
      const archivedDir = join(project, 'openspec', 'changes', 'archive', '2026-01-01-p1')
      await expect(stat(archivedDir)).resolves.toBeTruthy()
      await expect(stat(join(project, 'openspec', 'changes', 'p1'))).rejects.toThrow()
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


  it('blocks an unresolved CRITICAL in TEAM-REVIEW.md', async () => {
    const project = await seedProject()
    await writeFile(
      join(project, 'openspec', 'changes', 'p1', 'TEAM-REVIEW.md'),
      '## CRITICAL 问题\n\n- [ ] CRIT-1 未解决\n',
      'utf8',
    )
    const result = await orchestrateArchive(archivingProposal(), [{ project: 'demo', root: project }], {
      openspecRoot: 'openspec',
      gitnexusAnalyzeEnabled: false,
    })
    expect(result.ok).toBe(false)
    expect(result.steps.find((step) => step.step === 'team-review')?.status).toBe('failed')
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

  it('judges reviewer independence, and only blocks on what it can prove', async () => {
    const seed = async (reviewer: string): Promise<string> => {
      const project = await mkdtemp(join(tmpdir(), 'wm-indep-'))
      await mkdir(join(project, 'openspec', 'changes', 'p1'), { recursive: true })
      await writeFile(
        join(project, 'openspec', 'changes', 'p1', 'review.md'),
        `${reviewer}\n\n## 确认项\n\n- [x] 已核对\n`,
      )
      await writeFile(join(project, 'openspec', 'changes', 'p1', 'tasks.md'), '- [x] 1. done\n')
      return project
    }
    const executors = [{ name: 'fred', email: 'fred@example.com' }]
    const stepOf = (steps: Awaited<ReturnType<typeof orchestrateArchive>>['steps']): string =>
      steps.find((step) => step.step === 'review-independent')?.summary ?? ''

    // warn (default downstream value): an independent reviewer passes
    const independent = await seed('<!-- reviewer: auditor@1.2 -->')
    const warned = await orchestrateArchive(
      archivingProposal(),
      [{ project: 'demo', root: independent }],
      { openspecRoot: 'openspec', gitnexusAnalyzeEnabled: false, reviewerIndependence: 'warn', executorIdentities: executors },
    )
    expect(warned.ok).toBe(true)
    expect(stepOf(warned.steps)).toContain('不在执行者身份集合内')

    // block: the author reviewing their own change stops the archive
    const selfReview = await seed('<!-- reviewer: fred -->')
    const blocked = await orchestrateArchive(
      archivingProposal(),
      [{ project: 'demo', root: selfReview }],
      { openspecRoot: 'openspec', gitnexusAnalyzeEnabled: false, reviewerIndependence: 'block', executorIdentities: executors },
    )
    expect(blocked.ok).toBe(false)
    expect(blocked.steps.find((step) => step.step === 'review-independent')?.status).toBe('failed')
    expect(stepOf(blocked.steps)).toContain('fred@example.com')

    // block with no git facts: warn, never a false accusation
    const noFacts = await seed('<!-- reviewer: fred -->')
    const undetermined = await orchestrateArchive(
      archivingProposal(),
      [{ project: 'demo', root: noFacts }],
      { openspecRoot: 'openspec', gitnexusAnalyzeEnabled: false, reviewerIndependence: 'block', executorIdentities: [] },
    )
    expect(undetermined.ok).toBe(true)
    expect(undetermined.steps.find((step) => step.step === 'review-independent')?.status).toBe('skipped')
    expect(stepOf(undetermined.steps)).toContain('无法判定')

    // off: no step at all
    const off = await seed('<!-- reviewer: fred -->')
    const skipped = await orchestrateArchive(
      archivingProposal(),
      [{ project: 'demo', root: off }],
      { openspecRoot: 'openspec', gitnexusAnalyzeEnabled: false, reviewerIndependence: 'off', executorIdentities: executors },
    )
    expect(skipped.steps.some((step) => step.step === 'review-independent')).toBe(false)

    for (const project of [independent, selfReview, noFacts, off]) await rm(project, { recursive: true, force: true })
  })

  it('collects executor identities from the marker commits when the caller passes none', async () => {
    // End-to-end proof of the D2 identity path: no injected identity list — the
    // archive layer must read the commit authors itself.
    const project = await mkdtemp(join(tmpdir(), 'wm-ident-git-'))
    await mkdir(join(project, 'openspec', 'changes', 'p1'), { recursive: true })
    await writeFile(join(project, 'openspec', 'changes', 'p1', 'tasks.md'), '- [x] 1. done\n')
    await writeFile(join(project, 'openspec', 'changes', 'p1', 'review.md'), '<!-- reviewer: fred -->\n\n## 确认项\n\n- [x] 已核对\n')
    await git(['init', '-q'], project)
    await git(['config', 'user.name', 'fred'], project)
    await git(['config', 'user.email', 'fred@example.com'], project)
    await git(['add', '-A'], project)
    await git(['commit', '-q', '-m', 'feat: seed [proposal:p1]'], project)

    const result = await orchestrateArchive(archivingProposal(), [{ project: 'demo', root: project }], {
      openspecRoot: 'openspec',
      gitnexusAnalyzeEnabled: false,
      reviewerIndependence: 'block',
    })
    const step = result.steps.find((entry) => entry.step === 'review-independent')
    expect(step?.status).toBe('failed')
    expect(step?.summary).toContain('同一身份')

    await rm(project, { recursive: true, force: true })
  })

  it('probes review citations, blocking only on files that do not exist', async () => {
    const seed = async (line: string): Promise<string> => {
      const project = await mkdtemp(join(tmpdir(), 'wm-cite-'))
      await mkdir(join(project, 'openspec', 'changes', 'p1'), { recursive: true })
      await writeFile(join(project, 'real.ts'), 'a\nb\nc\n')
      await writeFile(
        join(project, 'openspec', 'changes', 'p1', 'review.md'),
        `## 确认项\n\n- [x] ${line}\n`,
      )
      await writeFile(join(project, 'openspec', 'changes', 'p1', 'tasks.md'), '- [x] 1. done\n')
      return project
    }

    const good = await seed('见 `real.ts:2`')
    const ok = await orchestrateArchive(archivingProposal(), [{ project: 'demo', root: good }], {
      openspecRoot: 'openspec',
      gitnexusAnalyzeEnabled: false,
      reviewEvidenceGate: 'warn',
    })
    expect(ok.ok).toBe(true)
    expect(ok.steps.find((step) => step.step === 'review-evidence')?.status).toBe('ok')

    // A missing file blocks in `block` mode; an out-of-range line does not.
    const missing = await seed('见 `does-not-exist.ts:3`')
    const blocked = await orchestrateArchive(archivingProposal(), [{ project: 'demo', root: missing }], {
      openspecRoot: 'openspec',
      gitnexusAnalyzeEnabled: false,
      reviewEvidenceGate: 'block',
    })
    expect(blocked.ok).toBe(false)
    expect(blocked.steps.find((step) => step.step === 'review-evidence')?.status).toBe('failed')

    const outOfRange = await seed('见 `real.ts:999`')
    const tolerated = await orchestrateArchive(archivingProposal(), [{ project: 'demo', root: outOfRange }], {
      openspecRoot: 'openspec',
      gitnexusAnalyzeEnabled: false,
      reviewEvidenceGate: 'block',
    })
    expect(tolerated.ok).toBe(true)
    const evidence = tolerated.steps.find((step) => step.step === 'review-evidence')
    expect(evidence?.status).toBe('skipped')
    expect(evidence?.summary).toContain('行号越界 1')

    // GitNexus conclusions are reported as uncheckable, not "verified".
    const gitnexus = await seed('结论：`impact(ArchiveGate)` 无上游影响')
    const uncheckable = await orchestrateArchive(archivingProposal(), [{ project: 'demo', root: gitnexus }], {
      openspecRoot: 'openspec',
      gitnexusAnalyzeEnabled: false,
      reviewEvidenceGate: 'block',
    })
    expect(uncheckable.ok).toBe(true)
    expect(uncheckable.steps.find((step) => step.step === 'review-evidence')?.summary).toContain('不可机检 1 条')

    for (const project of [good, missing, outOfRange, gitnexus]) await rm(project, { recursive: true, force: true })
  })

  it('blocks archiving while a swarm task is unmerged', async () => {
    const project = await mkdtemp(join(tmpdir(), 'wm-swarm-gate-'))
    await mkdir(join(project, 'openspec', 'changes', 'p1'), { recursive: true })
    await writeFile(join(project, 'openspec', 'changes', 'p1', 'tasks.md'), '- [x] 1. done\n', 'utf8')

    const result = await orchestrateArchive(
      archivingProposal([{ id: 't1', status: 'running' }, { id: 't2', status: 'merged' }]),
      [{ project: 'demo', root: project }],
      { openspecRoot: 'openspec', gitnexusAnalyzeEnabled: false },
    )

    expect(result.ok).toBe(false)
    const gate = result.steps.find((step) => step.step === 'tasks')
    expect(gate?.status).toBe('failed')
    expect(gate?.summary).toContain('[t1] running')
    expect(gate?.summary).not.toContain('[t2]')

    const forced = await orchestrateArchive(
      archivingProposal([{ id: 't1', status: 'running' }]),
      [{ project: 'demo', root: project }],
      { openspecRoot: 'openspec', gitnexusAnalyzeEnabled: false, tasksGate: false, reviewGate: false },
    )
    expect(forced.steps.find((step) => step.step === 'tasks')?.status).toBe('ok')
    await rm(project, { recursive: true, force: true })
  })

  it('requires an independent check per merged swarm task when the gate is on', async () => {
    const project = await mkdtemp(join(tmpdir(), 'wm-swarm-review-'))
    await mkdir(join(project, 'openspec', 'changes', 'p1'), { recursive: true })
    await writeFile(join(project, 'openspec', 'changes', 'p1', 'tasks.md'), '- [x] 1. done\n', 'utf8')
    const verification = {
      reviewer: 'auditor@2',
      verdict: 'verified' as const,
      independence: 'independent' as const,
      note: '不在执行者身份集合内',
      at: '2026-10-05T12:00:00.000Z',
    }
    const merged = [
      { id: 't1', status: 'merged' as const, verification },
      { id: 't2', status: 'merged' as const },
    ]

    // gate off (default): merging alone still reaches the swarm step as ok
    const permissive = await orchestrateArchive(archivingProposal(merged), [{ project: 'demo', root: project }], {
      openspecRoot: 'openspec',
      gitnexusAnalyzeEnabled: false,
      reviewGate: false,
    })
    expect(permissive.steps.find((step) => step.step === 'swarm')?.status).toBe('ok')

    // gate on: the unverified task blocks, naming it
    const strict = await orchestrateArchive(archivingProposal(merged), [{ project: 'demo', root: project }], {
      openspecRoot: 'openspec',
      gitnexusAnalyzeEnabled: false,
      reviewGate: false,
      swarmReviewRequired: true,
    })
    expect(strict.ok).toBe(false)
    const swarmStep = strict.steps.find((step) => step.step === 'swarm')
    expect(swarmStep?.status).toBe('failed')
    expect(swarmStep?.summary).toContain('t2(未核验)')
    expect(swarmStep?.summary).not.toContain('t1(')

    // a self-check does not count as verification
    const selfChecked = [
      { id: 't1', status: 'merged' as const, verification: { ...verification, independence: 'same-as-author' as const } },
    ]
    const blockedBySelf = await orchestrateArchive(archivingProposal(selfChecked), [{ project: 'demo', root: project }], {
      openspecRoot: 'openspec',
      gitnexusAnalyzeEnabled: false,
      reviewGate: false,
      swarmReviewRequired: true,
    })
    expect(blockedBySelf.ok).toBe(false)
    expect(blockedBySelf.steps.find((step) => step.step === 'swarm')?.summary).toContain('同一身份')

    // `undetermined` counts as unverified too (specs/swarm-verification: SHALL 视同未核验).
    // Without this branch the gate would silently pass exactly when the git facts are
    // unreachable — the misconfiguration `undetermined` stands for.
    const undecidable = [
      { id: 't1', status: 'merged' as const, verification: { ...verification, independence: 'undetermined' as const } },
    ]
    const blockedByUndetermined = await orchestrateArchive(archivingProposal(undecidable), [{ project: 'demo', root: project }], {
      openspecRoot: 'openspec',
      gitnexusAnalyzeEnabled: false,
      reviewGate: false,
      swarmReviewRequired: true,
    })
    expect(blockedByUndetermined.ok).toBe(false)
    const undeterminedStep = blockedByUndetermined.steps.find((step) => step.step === 'swarm')
    expect(undeterminedStep?.status).toBe('failed')
    expect(undeterminedStep?.summary).toContain('无法判定')

    // everything verified: the step says so
    const allVerified = [
      { id: 't1', status: 'merged' as const, verification },
      { id: 't2', status: 'merged' as const, verification: { ...verification, reviewer: 'auditor@3' } },
    ]
    const allChecked = await orchestrateArchive(archivingProposal(allVerified), [{ project: 'demo', root: project }], {
      openspecRoot: 'openspec',
      gitnexusAnalyzeEnabled: false,
      reviewGate: false,
      swarmReviewRequired: true,
    })
    const okStep = allChecked.steps.find((step) => step.step === 'swarm')
    expect(okStep?.status).toBe('ok')
    expect(okStep?.summary).toContain('2 个有独立核验记录')

    await rm(project, { recursive: true, force: true })
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
    // The gate that was forced is the REVIEW gate — reaching the archive step at
    // all is what `force` bought. The archive step itself is judged on its own
    // product fact, which the fake above produces for real.
    expect(forced.steps.find((s) => s.step === 'openspec-archive')).toMatchObject({ status: 'ok' })
    expect(forced.ok).toBe(true)
    // The fixture's review.md is missing entirely; force is what let it through.
    expect(forced.forced).toBe(true)
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

describe('archived change dir is still readable (archive-evidence-after-move)', () => {
  it('resolves the active path first, then falls back to changes/archive/<date>-<id>/', async () => {
    const { mkdtemp, mkdir, writeFile, readFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { resolveChangeDir } = await import('./orchestrate.ts')
    const root = await mkdtemp(join(tmpdir(), 'wm-archive-dir-'))

    // 1) Only the archived location exists — the state after a previous archive run.
    const archived = join(root, 'openspec', 'changes', 'archive', '2026-10-07-moved-probe')
    await mkdir(archived, { recursive: true })
    await writeFile(join(archived, 'review.md'), '- [LOW] 低风险\n', 'utf8')
    await writeFile(join(archived, 'tasks.md'), '- [x] 1. done\n', 'utf8')

    const resolved = await resolveChangeDir(root, 'openspec', 'moved-probe')
    expect(resolved).toBe(archived)
    expect(await readFile(join(resolved, 'review.md'), 'utf8')).toContain('LOW')

    // 2) An active dir wins when both exist.
    const active = join(root, 'openspec', 'changes', 'moved-probe')
    await mkdir(active, { recursive: true })
    expect(await resolveChangeDir(root, 'openspec', 'moved-probe')).toBe(active)

    await rm(root, { recursive: true, force: true })
  })
})

describe('swarm step reports what the proposal used (swarm-report-not-wired)', () => {
  const NO_PROJECT = mkdtemp(join(tmpdir(), 'wm-swarm-none-'))
  const MERGED_PROJECT = mkdtemp(join(tmpdir(), 'wm-swarm-merged-'))

  /** Minimal archivable fixture; the swarm step only needs tasks.md and proposal.swarmTasks. */
  async function fixture(project: string): Promise<void> {
    await mkdir(join(project, 'openspec', 'changes', 'p1'), { recursive: true })
    await writeFile(join(project, 'openspec', 'changes', 'p1', 'tasks.md'), '- [x] 1. done\n', 'utf8')
  }

  const baseProposal = (swarmTasks?: unknown[]): unknown => ({
    id: 'p1',
    title: 'swarm 步骤如实报告',
    status: 'archiving',
    projects: ['proj'],
    commits: [],
    openspecChangeId: 'p1',
    ...(swarmTasks !== undefined ? { swarmTasks } : {}),
  })

  it('says the proposal used no task-level parallelism when there are no swarm tasks', async () => {
    const project = await NO_PROJECT
    await fixture(project)
    const result = await orchestrateArchive(
      baseProposal() as never,
      [{ project: 'proj', root: project }],
      { openspecRoot: 'openspec', gitnexusAnalyzeEnabled: false, reviewGate: false } as never,
    )

    const step = result.steps.find((entry) => entry.step === 'swarm')
    expect(step?.status).toBe('ok')
    expect(step?.summary).toContain('无 swarm 任务')
    expect(step?.summary).toContain('D1')
    await rm(project, { recursive: true, force: true })
  })

  it('lists merged swarm tasks and their branches', async () => {
    const project = await MERGED_PROJECT
    await fixture(project)
    const result = await orchestrateArchive(
      baseProposal([
        { id: 't1', title: 'a', writes: [], status: 'merged', branch: 'feature/x--t1' },
        { id: 't2', title: 'b', writes: [], status: 'merged', branch: 'feature/x--t2' },
      ]) as never,
      [{ project: 'proj', root: project }],
      { openspecRoot: 'openspec', gitnexusAnalyzeEnabled: false, reviewGate: false } as never,
    )

    const step = result.steps.find((entry) => entry.step === 'swarm')
    expect(step?.summary).toContain('2 个 swarm 任务全部已合并')
    expect(step?.summary).toContain('feature/x--t1')
    await rm(project, { recursive: true, force: true })
  })
})

describe('auto vault export after archiving (auto-export-vault)', () => {
  async function fixture(): Promise<string> {
    const project = await mkdtemp(join(tmpdir(), 'wm-autovault-'))
    await mkdir(join(project, 'openspec', 'changes', 'p1'), { recursive: true })
    await writeFile(join(project, 'openspec', 'changes', 'p1', 'tasks.md'), '- [x] 1. done\n', 'utf8')
    return project
  }
  const prop = { id: 'p1', title: 't', status: 'archiving', projects: ['proj'], commits: [], openspecChangeId: 'p1' }

  it('calls the hook once the proposal is archived', async () => {
    const project = await fixture()
    const calls: string[] = []
    const result = await orchestrateArchive(prop as never, [{ project: 'proj', root: project }], {
      openspecRoot: 'openspec',
      gitnexusAnalyzeEnabled: false,
      reviewGate: false,
      onArchived: async (proposal, targets) => {
        calls.push(`${proposal.id}@${targets[0]?.project}`)
        return '导出了 3 个模块'
      },
    } as never)

    expect(calls).toEqual(['p1@proj'])
    expect(result.steps.find((step) => step.step === 'vault-export')).toMatchObject({ status: 'ok' })
    await rm(project, { recursive: true, force: true })
  })

  it('records a failing hook without failing the archive', async () => {
    const project = await fixture()
    const result = await orchestrateArchive(prop as never, [{ project: 'proj', root: project }], {
      openspecRoot: 'openspec',
      gitnexusAnalyzeEnabled: false,
      reviewGate: false,
      onArchived: async () => {
        throw new Error('vault 不可写')
      },
    } as never)

    expect(result.ok).toBe(true)
    const step = result.steps.find((entry) => entry.step === 'vault-export')
    expect(step?.status).toBe('failed')
    expect(step?.summary).toContain('不影响归档')
    await rm(project, { recursive: true, force: true })
  })
})

/**
 * False-green regression (change `harden-openspec-archive-step`): `openspec archive`
 * exits 0 while printing "Aborted. No files were changed." when the delta specs do
 * not parse. The pipeline used to call that `ok` and stamp the proposal `archived`
 * while `changes/<id>/` never moved.
 *
 * These cases run the REAL `openspec` CLI — a fake cannot express the bug, because
 * the bug is precisely "the CLI says fine and the directory stays put".
 */
describe('openspec-archive step verifies the product, not the exit code', () => {
  const prop = {
    id: 'p1',
    title: 't',
    status: 'archiving' as const,
    projects: ['demo'],
    commits: [],
    openspecChangeId: 'p1',
  }

  /** Seed a change whose spec section header is the only variable under test. */
  async function seedWithSpec(sectionHeader: string, withSpecs = true): Promise<string> {
    const project = await mkdtemp(join(tmpdir(), 'wm-archive-fact-'))
    const changeDir = join(project, 'openspec', 'changes', 'p1')
    await mkdir(join(changeDir, 'specs', 'cap'), { recursive: true })
    await writeFile(join(changeDir, 'proposal.md'), '# P\n\n## Why\n\n因为。\n\n## What Changes\n\n- 甲\n', 'utf8')
    await writeFile(join(changeDir, 'tasks.md'), '- [x] 1. a\n', 'utf8')
    await writeFile(join(changeDir, 'review.md'), '## CRITICAL 问题\n\n无。\n', 'utf8')
    if (withSpecs) {
      await writeFile(
        join(changeDir, 'specs', 'cap', 'spec.md'),
        [
          '# cap Specification',
          '',
          '## Purpose',
          '',
          '说明。',
          '',
          sectionHeader,
          '',
          '### Requirement: 甲',
          '',
          '系统 SHALL 甲。',
          '',
          '#### Scenario: 甲场景',
          '',
          '- **WHEN** 甲',
          '- **THEN** 甲',
          '',
        ].join('\n'),
        'utf8',
      )
    }
    return project
  }

  async function run(project: string) {
    return orchestrateArchive(prop as never, [{ project: 'demo', root: project }], {
      openspecRoot: 'openspec',
      gitnexusAnalyzeEnabled: false,
    } as never)
  }

  it('fails when the CLI aborts but still exits 0 (delta header missing)', async () => {
    // `## Requirements` is not a delta header: openspec parses no operations,
    // prints "Aborted. No files were changed." — and exits 0.
    const project = await seedWithSpec('## Requirements')

    const result = await run(project)

    const step = result.steps.find((s) => s.step === 'openspec-archive')
    expect(step?.status).toBe('failed')
    expect(result.ok).toBe(false)
    // The CLI's own words survive into the report, and so does the product fact.
    expect(step?.summary).toContain('Aborted. No files were changed.')
    expect(step?.summary).toContain('仍在原地')
    // Nothing advanced behind the failure.
    expect(result.steps.find((s) => s.step === 'status')).toBeUndefined()
    // The directory really is still where it was — that is what made it a failure.
    await expect(stat(join(project, 'openspec', 'changes', 'p1'))).resolves.toBeTruthy()
    expect(await readFile(join(project, 'openspec', 'changes', 'p1', 'tasks.md'), 'utf8')).toContain('- [x] 1. a')

    await rm(project, { recursive: true, force: true })
  })

  it('succeeds when the same fixture only swaps the header to a delta section', async () => {
    // Identical fixture; the single difference is the section header. The case
    // above must be red and this one green, or the verdict is not about the code.
    const project = await seedWithSpec('## ADDED Requirements')

    const result = await run(project)

    expect(result.ok).toBe(true)
    expect(result.steps.find((s) => s.step === 'openspec-archive')?.status).toBe('ok')
    // The archive directory is date-stamped by the CLI, so discover it instead of
    // hardcoding today's date (which would rot the moment the clock rolls over).
    const archiveRoot = join(project, 'openspec', 'changes', 'archive')
    const archived = (await readdir(archiveRoot)).filter((name) => name.endsWith('-p1'))
    expect(archived).toHaveLength(1)
    expect(await readFile(join(archiveRoot, archived[0]!, 'tasks.md'), 'utf8')).toContain('- [x] 1. a')
    await expect(stat(join(project, 'openspec', 'changes', 'p1'))).rejects.toThrow()

    await rm(project, { recursive: true, force: true })
  })

  it('does not misfire on a change that legitimately has no specs directory', async () => {
    // No `specs/` at all: openspec archives it happily (only a proposal.md warning).
    // The verdict keys on where the directory went, not on whether specs exist.
    const project = await seedWithSpec('## ADDED Requirements', false)

    const result = await run(project)

    expect(result.steps.find((s) => s.step === 'openspec-archive')?.status).toBe('ok')
    expect(result.ok).toBe(true)
    await expect(stat(join(project, 'openspec', 'changes', 'p1'))).rejects.toThrow()

    await rm(project, { recursive: true, force: true })
  })

  it('treats a rerun over an already-archived change as a skip, not a failure', async () => {
    const project = await seedWithSpec('## ADDED Requirements')

    const first = await run(project)
    expect(first.steps.find((s) => s.step === 'openspec-archive')?.status).toBe('ok')

    const second = await run(project)
    expect(second.steps.find((s) => s.step === 'openspec-archive')?.status).toBe('skipped')
    expect(second.ok).toBe(true)

    await rm(project, { recursive: true, force: true })
  })
})
