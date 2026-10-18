import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PortAllocator } from './port-allocator.ts'
import { WorktreeManager } from './manager.ts'

let home: string
let project: string

function git(args: string[], cwd: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', args, { cwd }, (error, _stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message))
      else resolvePromise()
    })
  })
}

const gitish = (args: string[], cwd: string): Promise<string> =>
  new Promise((resolvePromise, reject) => {
    execFile('git', args, { cwd }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message))
      else resolvePromise(stdout)
    })
  })

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wm-wt-home-'))
  project = await mkdtemp(join(tmpdir(), 'wm-wt-proj-'))
  await git(['init', '-b', 'main'], project)
  await git(['config', 'user.email', 't@t'], project)
  await git(['config', 'user.name', 't'], project)
  await writeFile(join(project, 'package.json'), '{"name":"demo","private":true}', 'utf8')
  await writeFile(join(project, '.env'), 'EXISTING=1\n', 'utf8')
  await mkdir(join(project, 'config'), { recursive: true })
  await writeFile(join(project, 'config', 'cert.pem'), 'cert', 'utf8')
  await git(['add', '-A'], project)
  await git(['commit', '-m', 'init', '-q'], project)
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
})

function makeManager(): WorktreeManager {
  return new WorktreeManager({
    homeRoot: home,
    subdir: 'workmate',
    basePort: 3000,
    portStep: 10,
    copyFiles: ['.env', 'config/cert.pem'],
    packageManager: 'pnpm',
    installTimeoutMs: 60_000,
  })
}

describe('PortAllocator', () => {
  it('hands out disjoint segments across proposals and releases on removal', async () => {
    const allocator = new PortAllocator({ homeRoot: home, subdir: 'workmate' }, 3000, 10)
    const a = await allocator.allocate('p1')
    const b = await allocator.allocate('p2')
    const c = await allocator.allocate('p3')

    expect(a.base).toBe(3000)
    expect(b.base).toBe(3010)
    expect(c.base).toBe(3020)
    expect(new Set([...a.ports, ...b.ports, ...c.ports]).size).toBe(15)

    await allocator.release('p2')
    const d = await allocator.allocate('p4')
    expect(d.base).toBe(3010) // freed index reused
  })
})

describe('WorktreeManager (real git)', () => {
  it('create performs the four steps and records the allocation', async () => {
    const manager = makeManager()
    const result = await manager.create({ projectRoot: project, proposalId: 'p1' })

    expect(result.worktreePath).toBe(join(project, '.workmates', 'p1'))
    expect(result.portRange[0]).toBe(3000)
    expect(result.copied).toEqual(['.env', 'config/cert.pem'])
    if (result.install === 'failed') console.error('installNote:', result.installNote)
    expect(result.install).toBe('installed')

    const env = await readFile(join(result.worktreePath, '.env'), 'utf8')
    expect(env).toContain('WORKMATE_PROPOSAL=p1')
    expect(env).toContain('WORKMATE_PORTS=3000,3001,3002,3003,3004')
    expect(env).toContain('EXISTING=1') // copied config coexists with the injected ports
    await expect(readFile(join(result.worktreePath, 'package.json'), 'utf8')).resolves.toContain('demo')

    // recorded on the allocator
    await expect(manager.ports().get('p1')).resolves.toMatchObject({ base: 3000 })

    // `.gitignore` gets exactly one `.workmates/` line, no matter how many creates ran
    const ignore = await readFile(join(project, '.gitignore'), 'utf8')
    expect(ignore.split('\n').filter((line) => line.trim() === '.workmates/')).toHaveLength(1)
    await manager.create({ projectRoot: project, proposalId: 'p2' })
    const again = await readFile(join(project, '.gitignore'), 'utf8')
    expect(again.split('\n').filter((line) => line.trim() === '.workmates/')).toHaveLength(1)
  })

  it('serializes concurrent creates without .git/config contention', async () => {
    const manager = makeManager()
    const results = await Promise.all([
      manager.create({ projectRoot: project, proposalId: 'p1' }),
      manager.create({ projectRoot: project, proposalId: 'p2' }),
      manager.create({ projectRoot: project, proposalId: 'p3' }),
    ])
    const bases = results.map((r) => r.portRange[0]).sort((a, b) => a - b)
    expect(bases).toEqual([3000, 3010, 3020])
  })

  it('remove refuses unmerged branches, cleans up after merge', async () => {
    const manager = makeManager()
    const result = await manager.create({ projectRoot: project, proposalId: 'p1' })
    // commit something on the worktree branch (unmerged)
    await writeFile(join(result.worktreePath, 'x.txt'), 'x', 'utf8')
    await git(['add', '-A'], result.worktreePath)
    await git(['commit', '-m', 'wip [proposal:p1]', '-q'], result.worktreePath)

    const refused = await manager.remove({ projectRoot: project, proposalId: 'p1' })
    expect(refused.removed).toBe(false)

    // merge the feature branch into main → removal proceeds
    await git(['merge', 'feature/p1', '-q', '--no-edit'], project)
    const cleaned = await manager.remove({ projectRoot: project, proposalId: 'p1' })
    expect(cleaned.removed).toBe(true)

    const list = await gitish(['worktree', 'list'], project)
    expect(list).not.toContain('.workmates')
    await expect(manager.ports().get('p1')).resolves.toBeUndefined()
  }, 30_000)

  it('rollback removal deletes the unmerged feature branch and releases its ports', async () => {
    const manager = makeManager()
    await manager.create({ projectRoot: project, proposalId: 'rollback-p1' })
    const removed = await manager.remove({
      projectRoot: project,
      proposalId: 'rollback-p1',
      force: true,
      deleteBranch: true,
    })
    expect(removed.removed).toBe(true)
    await expect(gitish(['rev-parse', '--verify', 'feature/rollback-p1'], project)).rejects.toThrow()
    await expect(manager.ports().get('rollback-p1')).resolves.toBeUndefined()
  }, 30_000)
  it('creates one target worktree per project with disjoint ports', async () => {
    const other = await mkdtemp(join(tmpdir(), 'wm-wt-other-'))
    try {
      await git(['init', '-b', 'main'], other)
      await git(['config', 'user.email', 't@t'], other)
      await git(['config', 'user.name', 't'], other)
      await git(['commit', '--allow-empty', '-m', 'init', '-q'], other)

      const manager = makeManager()
      const a = await manager.createTarget({
        projectRoot: project,
        project: 'a',
        proposalId: 'p1',
        baseBranch: 'main',
      })
      const b = await manager.createTarget({
        projectRoot: other,
        project: 'b',
        proposalId: 'p1',
        baseBranch: 'main',
      })

      expect(a.worktreePath).toBe(join(project, '.workmates', 'p1'))
      expect(b.worktreePath).toBe(join(other, '.workmates', 'p1'))
      expect([a.portRange[0], b.portRange[0]]).toEqual([3000, 3010])
      await expect(manager.ports().get('p1--a')).resolves.toMatchObject({ base: 3000 })
      await expect(manager.ports().get('p1--b')).resolves.toMatchObject({ base: 3010 })
      await expect(manager.ports().get('p1')).resolves.toBeUndefined()
      await expect(manager.allocationFor('p1', 'a')).resolves.toEqual(a.portRange)
      await expect(readFile(join(a.worktreePath, '.env'), 'utf8')).resolves.toContain('WORKMATE_PROJECT=a')

      // idempotent re-entry keeps the same allocation
      const again = await manager.createTarget({
        projectRoot: project,
        project: 'a',
        proposalId: 'p1',
        baseBranch: 'main',
      })
      expect(again.portRange).toEqual(a.portRange)
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  }, 30_000)

})
