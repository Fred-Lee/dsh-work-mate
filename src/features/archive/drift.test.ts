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
