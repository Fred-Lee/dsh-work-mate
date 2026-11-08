import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
  })
}

/**
 * 目录现在由 Super-agent 的 prepare 创建（design D10b），`WorktreeManager` 只负责回收。
 * 测试自己用 git 建一个同形状的 worktree + 分支，再验证 `remove` 的门槛与释放。
 */
async function placeWorktree(manager: WorktreeManager, proposalId: string): Promise<string> {
  const path = manager.worktreePath(project, proposalId)
  await git(['worktree', 'add', '-b', `feature/${proposalId}`, path], project)
  return path
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
  it('refuses to remove an unmerged branch, then removes after the merge', async () => {
    const manager = makeManager()
    const path = await placeWorktree(manager, 'p1')
    await manager.ports().allocate('p1')
    // commit something on the worktree branch (unmerged)
    await writeFile(join(path, 'x.txt'), 'x', 'utf8')
    await git(['add', '-A'], path)
    await git(['commit', '-m', 'wip [proposal:p1]', '-q'], path)

    const refused = await manager.remove({ projectRoot: project, proposalId: 'p1' })
    expect(refused.removed).toBe(false)
    // 被拒时保留分配：worktree 还在，端口可能仍被占用。
    await expect(manager.ports().get('p1')).resolves.toMatchObject({ base: 3000 })

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
    await placeWorktree(manager, 'rollback-p1')
    await manager.ports().allocate('rollback-p1')

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

  it('reads back per-project allocations without touching the proposal-level key', async () => {
    const manager = makeManager()
    const a = await manager.ports().allocate('p1--a')
    const b = await manager.ports().allocate('p1--b')

    expect([a.base, b.base]).toEqual([3000, 3010])
    await expect(manager.allocationFor('p1', 'a')).resolves.toEqual(a.ports)
    await expect(manager.allocationFor('p1', 'b')).resolves.toEqual(b.ports)
    await expect(manager.ports().get('p1')).resolves.toBeUndefined()
  })

  it('judges a remote merge as merged: local base lags, origin/<base> is ahead', async () => {
    // 场景（harden-archive-reclaim）：MR 在远端合并，本地基线分支没拉取。
    // 先建 origin（bare），推 main；feature 分支提交后在"远端"合并进 main，
    // 本地 main 停留在合并前——修复前 isMergedInto 判 false（假报未合并）。
    const origin = await mkdtemp(join(tmpdir(), 'wm-wt-origin-'))
    try {
      await git(['init', '--bare', '-b', 'main', origin], origin)
      await git(['remote', 'add', 'origin', origin], project)
      await git(['push', '-q', 'origin', 'main'], project)

      const feature = await placeWorktree(makeManager(), 'remote-p1')
      await writeFile(join(feature, 'r.txt'), 'r', 'utf8')
      await git(['add', '-A'], feature)
      await git(['commit', '-m', 'wip [proposal:remote-p1]', '-q'], feature)
      await git(['push', '-q', 'origin', 'feature/remote-p1'], project)

      // "远端合并"：用临时 clone 合并并推回 origin 的 main；本地 main 不动。
      const mirror = await mkdtemp(join(tmpdir(), 'wm-wt-mirror-'))
      await git(['clone', '-q', origin, mirror], mirror)
      await git(['config', 'user.email', 't@t'], mirror)
      await git(['config', 'user.name', 't'], mirror)
      await git(['merge', 'origin/feature/remote-p1', '-q', '--no-edit'], mirror)
      await git(['push', '-q', 'origin', 'main'], mirror)
      await rm(mirror, { recursive: true, force: true })

      // 本地基线落后于 bare 仓库的 main（本地没有 fetch，origin/main 跟踪引用是旧的）：
      // 修复前 isMergedInto 只看本地引用，这里判 false。
      expect(await gitish(['rev-parse', 'main'], project)).not.toBe(await gitish(['rev-parse', 'main'], origin))
      const { isMergedInto } = await import('./git.ts')
      await expect(isMergedInto(project, 'feature/remote-p1', 'main')).resolves.toBe(true)
    } finally {
      await rm(origin, { recursive: true, force: true })
    }
  }, 30_000)
})
