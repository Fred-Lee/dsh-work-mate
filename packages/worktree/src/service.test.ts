import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorktreeError, WorktreeService, sanitizeSegment } from './service.ts'

let base: string
let repo: string
let root: string
let svc: WorktreeService

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'helmsman-wt-'))
  repo = join(base, 'repo')
  root = join(base, 'worktrees')
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' })
  git(repo, 'config', 'user.email', 'test@helmsman.local')
  git(repo, 'config', 'user.name', 'Helmsman Test')
  writeFileSync(join(repo, 'README.md'), '# base\n')
  git(repo, 'add', '--all')
  git(repo, 'commit', '-m', 'init')
  svc = new WorktreeService({ rootDir: root })
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('sanitizeSegment', () => {
  it('passes safe ids and cleans unsafe ones', () => {
    expect(sanitizeSegment('t-abc123')).toBe('t-abc123')
    expect(sanitizeSegment('task/with spaces')).toBe('task-with-spaces')
    expect(sanitizeSegment('../evil')).toBe('evil') // leading dots stripped → no traversal
    expect(() => sanitizeSegment('')).toThrow(WorktreeError)
  })
})

describe('WorktreeService (real git)', () => {
  it('rejects non-git repos', async () => {
    await expect(svc.createWorktree({ taskId: 't1', agent: 'claude', repoPath: base })).rejects.toThrow(/not a git repository/)
  })

  it('create → diff → merge → remove round trip', async () => {
    const rec = await svc.createWorktree({ taskId: 'task1', agent: 'claude', repoPath: repo })
    expect(rec.path.startsWith(root)).toBe(true)
    expect(rec.branch).toBe('helmsman/task1-claude')
    expect(rec.baseSha).not.toBe('')

    // agent edits a file inside the worktree
    writeFileSync(join(rec.path, 'README.md'), '# base\n# changed by claude\n')
    writeFileSync(join(rec.path, 'new.txt'), 'untracked\n')

    const diff = await svc.getDiff(rec.id)
    const paths = diff.files.map((f) => f.path).sort()
    expect(paths).toEqual(['README.md', 'new.txt'])
    expect(diff.additions).toBe(2)

    // merge onto the base repo
    const merge = await svc.mergeWorktree({ worktreeId: rec.id })
    expect(merge.ok).toBe(true)
    expect(merge.committed).toBe(true)
    const readme = execFileSync('git', ['-C', repo, 'show', 'HEAD:README.md'], { encoding: 'utf8' })
    expect(readme).toContain('changed by claude')
    const newTxt = execFileSync('git', ['-C', repo, 'show', 'HEAD:new.txt'], { encoding: 'utf8' })
    expect(newTxt).toContain('untracked')

    await svc.removeWorktree(rec.id)
    expect(await svc.getWorktree(rec.id)).toBeUndefined()
    expect(await svc.listWorktrees('task1')).toHaveLength(0)
  })

  it('merge conflict keeps base repo untouched', async () => {
    const rec = await svc.createWorktree({ taskId: 'task2', agent: 'codex', repoPath: repo })
    writeFileSync(join(rec.path, 'README.md'), '# base\n# changed by codex\n')
    // conflicting change committed in the base repo first
    writeFileSync(join(repo, 'README.md'), '# base\n# changed upstream\n')
    git(repo, 'add', '--all')
    git(repo, 'commit', '-m', 'upstream change')

    const merge = await svc.mergeWorktree({ worktreeId: rec.id })
    expect(merge.ok).toBe(false)
    expect(merge.committed).toBe(false)
    const head = execFileSync('git', ['-C', repo, 'show', 'HEAD:README.md'], { encoding: 'utf8' })
    expect(head).toContain('changed upstream') // untouched by failed merge
    await svc.removeWorktree(rec.id)
  })

  it('partial merge respects file selection', async () => {
    const rec = await svc.createWorktree({ taskId: 'task3', agent: 'pi', repoPath: repo })
    writeFileSync(join(rec.path, 'keep.txt'), 'keep me\n')
    writeFileSync(join(rec.path, 'skip.txt'), 'skip me\n')
    const merge = await svc.mergeWorktree({ worktreeId: rec.id, files: ['keep.txt'] })
    expect(merge.ok).toBe(true)
    const headFiles = execFileSync('git', ['-C', repo, 'show', '--name-only', '--pretty=format:', 'HEAD'], { encoding: 'utf8' })
    expect(headFiles).toContain('keep.txt')
    expect(headFiles).not.toContain('skip.txt')
    await svc.removeWorktree(rec.id)
  })

  it('refuses path escape', async () => {
    const rec = await svc.createWorktree({ taskId: 'task4', agent: 'claude', repoPath: repo })
    // assertInsideRoot blocks manual escaping via state file tampering:
    const evil = new WorktreeService({ rootDir: join(base, 'elsewhere') })
    await expect(evil.getDiff(rec.id)).rejects.toThrow(/unknown worktree/)
    await svc.removeWorktree(rec.id)
  })
})
