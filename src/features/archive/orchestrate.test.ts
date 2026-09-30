import { execFile } from 'node:child_process'
import { mkdtemp, rm, chmod, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseTasksMd, orchestrateArchive } from './orchestrate.ts'
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

describe('orchestrateArchive (fake CLIs)', () => {
  async function seedProject(): Promise<string> {
    const project = join(home, 'proj')
    await import('node:fs/promises').then(async (fs) => {
      await fs.mkdir(join(project, 'openspec', 'changes', 'p1'), { recursive: true })
      await fs.writeFile(join(project, 'openspec', 'changes', 'p1', 'tasks.md'), '- [x] 1. a\n- [ ] 2. b\n', 'utf8')
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
      expect(result.tasks).toEqual({ done: 1, total: 2, lines: ['- [x] 1. a', '- [ ] 2. b'] })
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
})
