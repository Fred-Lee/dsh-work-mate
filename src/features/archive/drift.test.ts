import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { collectProjectDrift, orchestrateArchive } from './orchestrate.ts'

const git = (args: string[], cwd: string): Promise<string> =>
  new Promise((resolvePromise, reject) => {
    execFile('git', args, { cwd }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message))
      else resolvePromise(stdout)
    })
  })

let project: string

const proposal = (): Parameters<typeof orchestrateArchive>[0] =>
  ({
    id: 'p1',
    title: 'drift demo',
    status: 'archiving',
    projects: [],
    commits: [],
    openspecChangeId: 'p1',
    createdAt: '2026-10-05T00:00:00.000Z',
    updatedAt: '2026-10-05T00:00:00.000Z',
  }) as Parameters<typeof orchestrateArchive>[0]

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'wm-drift-'))
  await git(['init', '-b', 'main'], project)
  await git(['config', 'user.email', 't@t'], project)
  await git(['config', 'user.name', 't'], project)
  await mkdir(join(project, 'openspec', 'changes', 'p1'), { recursive: true })
  // The plan declares src/a/**; the commit below touches src/b.ts.
  await writeFile(
    join(project, 'openspec', 'changes', 'p1', 'tasks.md'),
    '- [x] 1. 改 A <!-- writes: src/a/** -->\n',
    'utf8',
  )
  await writeFile(join(project, 'openspec', 'changes', 'p1', 'review.md'), '## CRITICAL 问题\n\n- [x] 无\n', 'utf8')
  await mkdir(join(project, 'src'), { recursive: true })
  await writeFile(join(project, 'src', 'b.ts'), 'export const b = 1\n', 'utf8')
  await git(['add', '-A'], project)
  await git(['commit', '-m', 'feat: b [proposal:p1]', '-q'], project)
})

afterEach(async () => {
  await rm(project, { recursive: true, force: true })
})

describe('plan drift', () => {
  it('reports the undeclared change and the untouched declaration', async () => {
    const drift = await collectProjectDrift(proposal(), { project: 'demo', root: project }, { openspecRoot: 'openspec' })

    expect(drift?.declared).toEqual(['src/a/**'])
    expect(drift?.actual).toEqual(['src/b.ts'])
    expect(drift?.undeclared).toEqual(['src/b.ts'])
    expect(drift?.missing).toEqual(['src/a/**'])
    expect(drift?.driftRatio).toBe(1)
  })

  it('reports an untouched declaration as a warn step, never as a failure', async () => {
    // Declare what the commit actually touched (so nothing is undeclared) plus one
    // scope nothing touched: the only finding left is the untouched declaration.
    await writeFile(
      join(project, 'openspec', 'changes', 'p1', 'tasks.md'),
      '- [x] 1. 改 B <!-- writes: src/b.ts -->\n- [x] 2. 改 A <!-- writes: src/a/** -->\n',
      'utf8',
    )
    const result = await orchestrateArchive(
      proposal(),
      [{ project: 'demo', root: project }],
      { openspecRoot: 'openspec', gitnexusAnalyzeEnabled: false, reviewGate: false, planDriftGate: true },
    )

    const driftStep = result.steps.find((step) => step.step === 'plan-drift')
    expect(driftStep?.status).toBe('warn')
    expect(driftStep?.summary).toContain('src/a/**')
    // A warn step never blocks; the undeclared failure is what blocks.
    expect(result.ok).toBe(true)
  })

  it('does not count the plan directory itself as an untouched declaration', async () => {
    // Declaring the proposal's own spec file must not become a phantom "missing":
    // the change directory is the plan, not a deliverable.
    await writeFile(
      join(project, 'openspec', 'changes', 'p1', 'tasks.md'),
      '- [x] 1. 改 A <!-- writes: src/a/** -->\n- [x] 2. 规格 <!-- writes: openspec/changes/p1/specs/** -->\n',
      'utf8',
    )

    const drift = await collectProjectDrift(proposal(), { project: 'demo', root: project }, { openspecRoot: 'openspec' })

    expect(drift?.excluded).toEqual(['openspec/changes/p1/specs/**'])
    expect(drift?.missing).toEqual(['src/a/**'])
  })

  it('records the drift in the manifest without blocking by default', async () => {
    const result = await orchestrateArchive(
      proposal(),
      [{ project: 'demo', root: project }],
      { openspecRoot: 'openspec', gitnexusAnalyzeEnabled: false, reviewGate: false },
    )

    expect(result.ok).toBe(true)
    expect(result.steps.find((step) => step.step === 'plan-drift')).toBeUndefined()
    expect(result.manifest?.projects[0]?.drift?.undeclared).toEqual(['src/b.ts'])
    expect(result.manifest?.projects[0]?.artifacts?.length ?? 0).toBeGreaterThan(0)
  })

  it('blocks when the drift gate is on and force skips it', async () => {
    const gated = await orchestrateArchive(
      proposal(),
      [{ project: 'demo', root: project }],
      { openspecRoot: 'openspec', gitnexusAnalyzeEnabled: false, reviewGate: false, planDriftGate: true },
    )

    expect(gated.ok).toBe(false)
    const gate = gated.steps.find((step) => step.step === 'plan-drift')
    expect(gate?.status).toBe('failed')
    expect(gate?.summary).toContain('src/b.ts')

    const forced = await orchestrateArchive(
      proposal(),
      [{ project: 'demo', root: project }],
      { openspecRoot: 'openspec', gitnexusAnalyzeEnabled: false, reviewGate: false, planDriftGate: false },
    )
    expect(forced.ok).toBe(true)
  })
})

describe('review grading (decision nodes)', () => {
  /** A review with one untagged question and nothing else. */
  const seedReview = async (): Promise<string> => {
    const project = await mkdtemp(join(tmpdir(), 'wm-grade-'))
    await mkdir(join(project, 'openspec', 'changes', 'p1'), { recursive: true })
    await writeFile(join(project, 'openspec', 'changes', 'p1', 'tasks.md'), '- [x] 1. done\n', 'utf8')
    await writeFile(
      join(project, 'openspec', 'changes', 'p1', 'review.md'),
      ['## 疑问项', '', '- [ ] 消费方是否需要同步改鉴权？'].join('\n'),
      'utf8',
    )
    return project
  }

  const decideReturning = (action: 'act' | 'abstain', choice = 'CRIT') =>
    async (): Promise<{ node: 'review-severity'; action: 'act' | 'abstain'; choice: string; certainty: number; threshold: number; provider: string; latencyMs: number; degraded: boolean }> => ({
      node: 'review-severity',
      action,
      choice,
      certainty: action === 'act' ? 0.9 : 0.4,
      threshold: 0.8,
      provider: 'stub',
      latencyMs: 1,
      degraded: false,
    })

  it('grades an untagged finding and lets it block archiving', async () => {
    const project = await seedReview()
    const result = await orchestrateArchive(
      proposal(),
      [{ project: 'demo', root: project }],
      { openspecRoot: 'openspec', gitnexusAnalyzeEnabled: false },
      { decide: decideReturning('act', 'CRIT') as never },
    )

    expect(result.ok).toBe(false)
    const gate = result.steps.find((step) => step.step === 'review-gate')
    expect(gate?.status).toBe('failed')
    expect(gate?.summary).toContain('判断层归级 1 条')
    expect(gate?.summary).toContain('CRIT 1/1')
    await rm(project, { recursive: true, force: true })
  })

  it('ignores an abstaining judgement and keeps the previous outcome', async () => {
    const project = await seedReview()
    const result = await orchestrateArchive(
      proposal(),
      [{ project: 'demo', root: project }],
      { openspecRoot: 'openspec', gitnexusAnalyzeEnabled: false },
      { decide: decideReturning('abstain') as never },
    )

    expect(result.ok).toBe(true)
    expect(result.steps.find((step) => step.step === 'review-gate')?.summary).not.toContain('判断层归级')
    await rm(project, { recursive: true, force: true })
  })

  it('is a no-op when the hook is absent', async () => {
    const project = await seedReview()
    const result = await orchestrateArchive(
      proposal(),
      [{ project: 'demo', root: project }],
      { openspecRoot: 'openspec', gitnexusAnalyzeEnabled: false },
    )

    expect(result.ok).toBe(true)
    await rm(project, { recursive: true, force: true })
  })
})

describe('task judgement (decision nodes)', () => {
  const seedCheckedTask = async (): Promise<string> => {
    const project = await mkdtemp(join(tmpdir(), 'wm-taskjudge-'))
    await mkdir(join(project, 'openspec', 'changes', 'p1'), { recursive: true })
    await writeFile(
      join(project, 'openspec', 'changes', 'p1', 'tasks.md'),
      '- [x] 1. 给导出加鉴权检查\n- [x] 2. 补文档\n',
      'utf8',
    )
    await writeFile(join(project, 'openspec', 'changes', 'p1', 'review.md'), '## CRITICAL 问题\n\n- [x] 无\n', 'utf8')
    return project
  }

  const decide = (verdict: string, action: 'act' | 'abstain') =>
    async (): Promise<{
      node: 'task-satisfied'
      action: 'act' | 'abstain'
      choice: string
      certainty: number
      threshold: number
      provider: string
      latencyMs: number
      degraded: boolean
    }> => ({
      node: 'task-satisfied',
      action,
      choice: verdict,
      certainty: action === 'act' ? 0.85 : 0.4,
      threshold: 0.8,
      provider: 'stub',
      latencyMs: 1,
      degraded: false,
    })

  it('records the judgement in the manifest without blocking by default', async () => {
    const project = await seedCheckedTask()
    const result = await orchestrateArchive(
      proposal(),
      [{ project: 'demo', root: project }],
      { openspecRoot: 'openspec', gitnexusAnalyzeEnabled: false, reviewGate: false },
      { decide: decide('unsatisfied', 'act') as never },
    )

    expect(result.ok).toBe(true)
    expect(result.manifest?.projects[0]?.taskJudgements?.[0]).toEqual({
      task: '- [x] 1. 给导出加鉴权检查',
      verdict: 'unsatisfied',
      certainty: 0.85,
    })
    await rm(project, { recursive: true, force: true })
  })

  it('blocks when the gate is on, and abstaining never blocks', async () => {
    const gatedProject = await seedCheckedTask()
    const gated = await orchestrateArchive(
      proposal(),
      [{ project: 'demo', root: gatedProject }],
      { openspecRoot: 'openspec', gitnexusAnalyzeEnabled: false, reviewGate: false, taskJudgementGate: true },
      { decide: decide('unsatisfied', 'act') as never },
    )
    expect(gated.ok).toBe(false)
    expect(gated.steps.find((step) => step.step === 'tasks')?.summary).toContain('任务判定未通过')

    const abstainProject = await seedCheckedTask()
    const abstained = await orchestrateArchive(
      proposal(),
      [{ project: 'demo', root: abstainProject }],
      { openspecRoot: 'openspec', gitnexusAnalyzeEnabled: false, reviewGate: false, taskJudgementGate: true },
      { decide: decide('unsatisfied', 'abstain') as never },
    )
    expect(abstained.ok).toBe(true)
    expect(abstained.manifest?.projects[0]?.taskJudgements).toBeUndefined()

    await rm(gatedProject, { recursive: true, force: true })
    await rm(abstainProject, { recursive: true, force: true })
  })
})
