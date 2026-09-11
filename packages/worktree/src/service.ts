/**
 * WorktreeService — creates one isolated git worktree per (task, agent) pair,
 * collects diffs, applies patches back onto the base repo, and cleans up.
 *
 * Security invariants:
 *  - every id/branch/path component is validated against a strict charset;
 *  - all git/fs paths are resolved inside a dedicated rootDir (except the
 *    explicitly user-configured base repo);
 *  - git is always invoked with argv arrays, never a shell.
 */
import { mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { expectOk, runCommand, type CommandRunner, type RunOptions } from './git.ts'
import { changedLineRanges, parseUnifiedDiff } from './diffparse.ts'

export interface WorktreeRecord {
  id: string
  taskId: string
  agent: string
  path: string
  branch: string
  baseRepo: string
  baseSha: string
  createdAt: number
}

export interface FileDiff {
  path: string
  status: 'added' | 'deleted' | 'renamed' | 'modified' | 'binary'
  additions: number
  deletions: number
  diff: string
}

export interface WorktreeDiff {
  worktreeId: string
  files: FileDiff[]
  additions: number
  deletions: number
}

export interface CreateWorktreeParams {
  taskId: string
  agent: string
  repoPath: string
}

export interface MergeResult {
  ok: boolean
  committed: boolean
  message: string
  conflictFiles: string[]
}

export interface MergeSelection {
  worktreeId: string
  /** Paths (repo-relative) to include; omit to include every changed file. */
  files?: string[]
  commitMessage?: string
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/
const STATE_FILE = 'worktrees.json'

export class WorktreeError extends Error {}

export function sanitizeSegment(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '').slice(0, 64)
  if (!ID_RE.test(cleaned)) throw new WorktreeError(`invalid worktree segment: ${JSON.stringify(raw)}`)
  return cleaned
}

export class WorktreeService {
  readonly rootDir: string
  private readonly run: CommandRunner
  private records = new Map<string, WorktreeRecord>()
  private loaded = false

  constructor(opts: { rootDir?: string; run?: CommandRunner } = {}) {
    this.rootDir = resolve(opts.rootDir ?? join(homedir(), '.helmsman', 'worktrees'))
    this.run = opts.run ?? runCommand
  }

  private get statePath(): string {
    return join(this.rootDir, STATE_FILE)
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    await mkdir(this.rootDir, { recursive: true })
    if (existsSync(this.statePath)) {
      try {
        const raw = JSON.parse(await readFile(this.statePath, 'utf8')) as { worktrees?: WorktreeRecord[] }
        for (const rec of raw.worktrees ?? []) this.records.set(rec.id, rec)
      } catch {
        // corrupted state file — start empty, never crash the host
        this.records.clear()
      }
    }
    this.loaded = true
  }

  private async persist(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true })
    await writeFile(this.statePath, JSON.stringify({ version: 1, worktrees: [...this.records.values()] }, null, 2), 'utf8')
  }

  private git(args: string[], opts: RunOptions = {}) {
    return this.run('git', args, opts)
  }

  private assertInsideRoot(path: string): string {
    const abs = resolve(path)
    if (abs !== this.rootDir && !abs.startsWith(this.rootDir + sep)) {
      throw new WorktreeError(`path escapes worktree root: ${abs}`)
    }
    return abs
  }

  async isGitRepo(repoPath: string): Promise<boolean> {
    const r = await this.git(['-C', resolve(repoPath), 'rev-parse', '--is-inside-work-tree'])
    return r.code === 0 && r.stdout.trim() === 'true'
  }

  async createWorktree(params: CreateWorktreeParams): Promise<WorktreeRecord> {
    await this.ensureLoaded()
    const taskId = sanitizeSegment(params.taskId)
    const agent = sanitizeSegment(params.agent)
    const id = sanitizeSegment(`${taskId}-${agent}`)
    const repoPath = resolve(params.repoPath)
    if (!(await this.isGitRepo(repoPath))) {
      throw new WorktreeError(`base repo is not a git repository: ${repoPath}`)
    }
    const sha = await expectOk(this.git(['-C', repoPath, 'rev-parse', 'HEAD']), 'resolve HEAD').then((r) => r.stdout.trim())
    const path = this.assertInsideRoot(join(this.rootDir, id))
    if (existsSync(path)) {
      throw new WorktreeError(`worktree path already exists: ${path}`)
    }
    const branch = `helmsman/${id}`
    const created = await this.git(['-C', repoPath, 'worktree', 'add', '-b', branch, path, sha])
    if (created.code !== 0) {
      // Branch may already exist — retry detached, then branch from scratch.
      const retry = await this.git(['-C', repoPath, 'worktree', 'add', '--detach', path, sha])
      if (retry.code !== 0) {
        throw new WorktreeError(`git worktree add failed: ${created.stderr.trim() || retry.stderr.trim()}`)
      }
    }
    const record: WorktreeRecord = { id, taskId, agent, path, branch, baseRepo: repoPath, baseSha: sha, createdAt: Date.now() }
    this.records.set(id, record)
    await this.persist()
    return record
  }

  async getWorktree(id: string): Promise<WorktreeRecord | undefined> {
    await this.ensureLoaded()
    return this.records.get(id)
  }

  async listWorktrees(taskId?: string): Promise<WorktreeRecord[]> {
    await this.ensureLoaded()
    const all = [...this.records.values()]
    return taskId ? all.filter((r) => r.taskId === taskId) : all
  }

  async removeWorktree(id: string): Promise<void> {
    await this.ensureLoaded()
    const rec = this.records.get(id)
    if (!rec) return
    await this.git(['-C', rec.baseRepo, 'worktree', 'remove', '--force', rec.path])
    await this.git(['-C', rec.baseRepo, 'branch', '-D', rec.branch]) // best-effort
    await rm(rec.path, { recursive: true, force: true })
    this.records.delete(id)
    await this.persist()
  }

  /** Collects the worktree's changes vs its base snapshot. Includes untracked files. */
  async getDiff(id: string): Promise<WorktreeDiff> {
    await this.ensureLoaded()
    const rec = this.records.get(id)
    if (!rec) throw new WorktreeError(`unknown worktree: ${id}`)
    // Intent-to-add makes untracked files visible to `git diff` without staging content.
    await this.git(['-C', rec.path, 'add', '--intent-to-add', '--all'])
    const r = await expectOk(
      this.git(['-C', rec.path, 'diff', '--binary', rec.baseSha, '--']),
      'git diff',
    )
    const parsed = parseUnifiedDiff(r.stdout)
    const files: FileDiff[] = parsed.map((f) => ({
      path: f.path,
      status: f.binary ? 'binary' : f.oldPath ? 'renamed' : additionsOnly(f.diff) ? 'added' : deletionsOnly(f.diff) ? 'deleted' : 'modified',
      additions: f.additions,
      deletions: f.deletions,
      diff: f.diff,
    }))
    return {
      worktreeId: id,
      files,
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
    }
  }

  /**
   * Applies the worktree's changes (optionally restricted to selected files)
   * onto the base repo's current branch via a patch; commits when applied.
   * Conflicts leave the base repo untouched (git apply is atomic per run).
   */
  async mergeWorktree(selection: MergeSelection): Promise<MergeResult> {
    await this.ensureLoaded()
    const rec = this.records.get(selection.worktreeId)
    if (!rec) throw new WorktreeError(`unknown worktree: ${selection.worktreeId}`)
    const diff = await this.getDiff(selection.worktreeId)
    const selected = selection.files
      ? diff.files.filter((f) => selection.files!.includes(f.path))
      : diff.files
    if (selected.length === 0) {
      return { ok: true, committed: false, message: 'no changes to merge', conflictFiles: [] }
    }
    const patch = selected.map((f) => f.diff).join('\n')
    // Patch is delivered via stdin — no temp file, no shell.
    const applyResult = await runWithInput('git', ['-C', rec.baseRepo, 'apply', '--whitespace=nowarn'], patch)
    if (applyResult.code !== 0) {
      const conflictFiles = parseConflictPaths(applyResult.stderr)
      return { ok: false, committed: false, message: `git apply failed: ${applyResult.stderr.trim()}`, conflictFiles }
    }
    const msg = selection.commitMessage ?? `helmsman: merge agent "${rec.agent}" results (task ${rec.taskId})`
    const add = await this.git(['-C', rec.baseRepo, 'add', '--all'])
    if (add.code !== 0) {
      return { ok: false, committed: false, message: `git add failed: ${add.stderr.trim()}`, conflictFiles: [] }
    }
    const commit = await this.git(['-C', rec.baseRepo, 'commit', '-m', msg, '--allow-empty'])
    if (commit.code !== 0) {
      return { ok: false, committed: false, message: `git commit failed: ${commit.stderr.trim()}`, conflictFiles: [] }
    }
    return { ok: true, committed: true, message: `merged ${selected.length} file(s) from ${rec.agent}`, conflictFiles: [] }
  }

  /**
   * Dry-run merge check (design D5 / merge-conflict-resolution): concatenates
   * the selected worktrees' patches and runs `git apply --check` against the
   * base repo — a pure validation that never modifies anything. `ok:false`
   * lists the files whose patch does NOT apply cleanly (real conflicts), which
   * are exactly the files that need per-file user adjudication before a merge.
   */
  async mergeDryRun(selection: { worktrees: Array<{ worktreeId: string; files?: string[] }> }): Promise<{ ok: boolean; conflictFiles: string[] }> {
    await this.ensureLoaded()
    const records: WorktreeRecord[] = []
    for (const sel of selection.worktrees) {
      const rec = this.records.get(sel.worktreeId)
      if (!rec) throw new WorktreeError(`unknown worktree: ${sel.worktreeId}`)
      records.push(rec)
    }
    if (records.length === 0) return { ok: true, conflictFiles: [] }
    const baseRepo = records[0]!.baseRepo
    const patches: string[] = []
    for (let i = 0; i < selection.worktrees.length; i++) {
      const sel = selection.worktrees[i]!
      const diff = await this.getDiff(sel.worktreeId)
      const files = sel.files ? diff.files.filter((f) => sel.files!.includes(f.path)) : diff.files
      patches.push(files.map((f) => f.diff).join('\n'))
    }
    const patch = patches.join('\n')
    if (!patch.trim()) return { ok: true, conflictFiles: [] }
    const result = await runWithInput('git', ['-C', baseRepo, 'apply', '--check', '--whitespace=nowarn'], patch)
    if (result.code === 0) return { ok: true, conflictFiles: [] }
    return { ok: false, conflictFiles: parseConflictPaths(result.stderr) }
  }

  /** Lists changed line ranges per file across a set of worktrees (conflict detection input). */
  async getChangedRanges(id: string): Promise<Map<string, Array<{ start: number; end: number }>>> {
    const diff = await this.getDiff(id)
    const text = diff.files.map((f) => f.diff).join('\n')
    return changedLineRanges(text)
  }

  /** Removes worktrees belonging to a task. */
  async removeTaskWorktrees(taskId: string): Promise<void> {
    for (const rec of await this.listWorktrees(taskId)) {
      await this.removeWorktree(rec.id)
    }
  }

  /** Housekeeping: drop records whose directory vanished. */
  async reconcile(): Promise<void> {
    await this.ensureLoaded()
    for (const rec of [...this.records.values()]) {
      if (!existsSync(rec.path)) {
        this.records.delete(rec.id)
        await this.persist()
      }
    }
  }

  async listRootEntries(): Promise<string[]> {
    await this.ensureLoaded()
    try {
      return await readdir(this.rootDir)
    } catch {
      return []
    }
  }
}

function additionsOnly(diff: string): boolean {
  return !/^-[^-]/m.test(diff)
}
function deletionsOnly(diff: string): boolean {
  return !/^\+[^+]/m.test(diff)
}

function parseConflictPaths(stderr: string): string[] {
  const out = new Set<string>()
  for (const m of stderr.matchAll(/error: patch failed: (.+?):\d+/g)) out.add(m[1]!.trim())
  for (const m of stderr.matchAll(/error: (.+?): (?:patch does not apply|already exists)/g)) out.add(m[1]!.trim())
  return [...out]
}

import { execFile } from 'node:child_process'

function runWithInput(
  bin: string,
  args: string[],
  input: string,
  opts: RunOptions = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = execFile(
      bin,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 60_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (error, out, err) => {
        const code = error ? ((error as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0
        resolve({ code: typeof code === 'number' ? code : 1, stdout: String(out ?? ''), stderr: String(err ?? '') || (error?.message ?? '') })
      },
    )
    proc.stdin?.end(input)
  })
}
