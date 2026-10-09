/**
 * Worktree lifecycle manager (change add-lifecycle-worktree-wiki, design D3).
 * Creation performs the four mandatory steps — serialized `git worktree add`
 * (an in-process mutex: WorkMate is a single host process, so `.git/config`
 * contention only comes from our own concurrent calls), port injection into
 * `.env` (append, never overwrite), copyFiles replication, package-manager
 * install (skipped when the worktree has no package.json). Removal confirms
 * the branch is merged before releasing anything.
 */
import { appendFile, copyFile, mkdir, readFile, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { gitExec, isMergedInto } from './git.ts'
import { PortAllocator } from './port-allocator.ts'

/** Generic (non-git) command runner for package-manager installs. */
function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      cmd,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, ...(signal !== undefined ? { signal } : {}) },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr?.trim() || error.message))
        else resolvePromise(stdout)
      },
    )
  })
}

export interface WorktreeCreateResult {
  worktreePath: string
  featureBranch: string
  portRange: number[]
  copied: string[]
  install: 'installed' | 'skipped' | 'failed'
  installNote?: string
}

export interface ManagerOptions {
  homeRoot?: string
  subdir: string
  basePort: number
  portStep: number
  copyFiles: string[]
  packageManager: string
  installTimeoutMs?: number
}

export interface CreateInput {
  projectRoot: string
  proposalId: string
  mainBranch?: string
  /** Caller cancellation: forwarded to `git worktree add` and the install. */
  signal?: AbortSignal
}

const WORKMATES_DIR = '.workmates'

/** Idempotently add entries to `<root>/.git/info/exclude` (best effort). */
async function ensureExcludes(projectRoot: string, entries: readonly string[]): Promise<void> {
  const wanted = entries.map((entry) => entry.trim()).filter((entry) => entry !== '')
  if (wanted.length === 0) return
  const excludePath = join(projectRoot, '.git', 'info', 'exclude')
  try {
    const existing = await readFile(excludePath, 'utf8')
    const present = new Set(existing.split('\n').map((line) => line.trim()))
    const missing = wanted.filter((entry) => !present.has(entry))
    if (missing.length === 0) return
    await appendFile(excludePath, `\n# workmate: machine-local, never committed\n${missing.join('\n')}\n`, 'utf8')
  } catch {
    // Not a plain git directory (bare/linked): nothing to exclude.
  }
}

export class WorktreeManager {
  private readonly allocator: PortAllocator
  /** Serialization gate: only one `git worktree add` at a time. */
  private createChain: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: ManagerOptions) {
    this.allocator = new PortAllocator(options, options.basePort, options.portStep)
  }

  ports(): PortAllocator {
    return this.allocator
  }

  worktreePath(projectRoot: string, proposalId: string): string {
    return join(projectRoot, WORKMATES_DIR, proposalId)
  }

  /** Serialized wrapper: queue every create behind the previous one. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.createChain.then(task, task)
    this.createChain = run.catch(() => undefined)
    return run
  }

  async create(input: CreateInput): Promise<WorktreeCreateResult> {
    return this.enqueue(() => this.createSerialized(input))
  }

  private async createSerialized(input: CreateInput): Promise<WorktreeCreateResult> {
    const { projectRoot, proposalId } = input
    const worktreePath = this.worktreePath(projectRoot, proposalId)
    const featureBranch = `feature/${proposalId}`
    const existing = await this.allocator.get(proposalId)

    try {
      await stat(join(worktreePath, '.git'))
      // idempotent re-entry: worktree already on disk — reuse its allocation
      const allocation = existing ?? (await this.allocator.allocate(proposalId))
      return {
        worktreePath,
        featureBranch,
        portRange: allocation.ports,
        copied: [],
        install: 'skipped',
        installNote: 'worktree already exists',
      }
    } catch {
      // not there — proceed with creation
    }

    // Machine-local files (the generated .env, sibling worktrees) must never be
    // committed from a worktree: an agent running `git add -A` would otherwise
    // carry them into a branch, and the next merge would then collide with the
    // untracked copy in the carrier. `.git/info/exclude` is per-clone and shared
    // by every worktree — the right place, and nothing user-visible changes.
    await ensureExcludes(projectRoot, ['.env', ...this.options.copyFiles, `${WORKMATES_DIR}/`])

    const allocation = await this.allocator.allocate(proposalId)

    // 1. create (serialized by the mutex) — branch from main
    const mainBranch = input.mainBranch ?? 'main'
    await gitExec(
      ['worktree', 'add', '-b', featureBranch, worktreePath, mainBranch],
      projectRoot,
      15_000,
      input.signal,
    )

    // 3. copy the config whitelist from the main checkout
    const copied: string[] = []
    for (const name of this.options.copyFiles) {
      if (name.trim() === '') continue
      try {
        const from = join(projectRoot, name.trim())
        await stat(from)
        const to = join(worktreePath, name.trim())
        await mkdir(join(to, '..'), { recursive: true })
        await copyFile(from, to)
        copied.push(name.trim())
      } catch {
        // source absent — skip silently, it is a whitelist not a requirement
      }
    }

    // 2. port injection into .env (append; never overwrite existing content)
    const envPath = join(worktreePath, '.env')
    const lines = [
      '',
      `# WorkMate (proposal ${proposalId}) — auto-generated, safe to delete with the worktree`,
      `WORKMATE_PROPOSAL=${proposalId}`,
      `WORKMATE_PORTS=${allocation.ports.join(',')}`,
      `WORKMATE_PORT=${allocation.base}`,
      '',
    ]
    await appendFile(envPath, lines.join('\n'), 'utf8')

    // 4. install dependencies when there is something to install
    let install: WorktreeCreateResult['install'] = 'skipped'
    let installNote: string | undefined
    try {
      await stat(join(worktreePath, 'package.json'))
      install = 'installed'
      try {
        await runCommand(
          this.options.packageManager,
          ['install'],
          worktreePath,
          this.options.installTimeoutMs ?? 300_000,
          input.signal,
        )
      } catch (error) {
        install = 'failed'
        installNote = error instanceof Error ? error.message : String(error)
      }
    } catch {
      installNote = 'no package.json in the worktree'
    }

    // Keep the scratch dir out of git in the main checkout — but only once: each
    // `create` used to append another copy (`fix-panel-scroll` left a doubled block),
    // and a growing .gitignore is noise in every later diff.
    try {
      const ignorePath = join(projectRoot, '.gitignore')
      const existing = await readFile(ignorePath, 'utf8').catch(() => '')
      const already = existing
        .split('\n')
        .map((line) => line.trim())
        .includes(`${WORKMATES_DIR}/`)
      if (!already) await appendFile(ignorePath, `\n${WORKMATES_DIR}/\n`, 'utf8')
    } catch {
      // best effort
    }

    return { worktreePath, featureBranch, portRange: allocation.ports, copied, install, installNote }
  }

  /**
   * Remove the worktree after confirming the feature branch content is merged
   * into main (unless forced). Releases the port segment first so a failed
   * removal never leaks a held range.
   */
  async remove(input: {
    projectRoot: string
    proposalId: string
    mainBranch?: string
    force?: boolean
    signal?: AbortSignal
  }): Promise<{ removed: boolean; summary: string }> {
    const { projectRoot, proposalId } = input
    const mainBranch = input.mainBranch ?? 'main'
    const featureBranch = `feature/${proposalId}`
    const worktreePath = this.worktreePath(projectRoot, proposalId)

    if (input.force !== true) {
      const merged = await isMergedInto(projectRoot, featureBranch, mainBranch)
      if (!merged) {
        return { removed: false, summary: `feature/${proposalId} is not merged into ${mainBranch} — refusing removal (force to override)` }
      }
    }

    await this.allocator.release(proposalId)
    try {
      await gitExec(['worktree', 'remove', '--force', worktreePath], projectRoot, 15_000, input.signal)
      return { removed: true, summary: `worktree ${worktreePath} removed and ports released` }
    } catch (error) {
      // branch may hold unmerged state even under force; report honestly
      try {
        await gitExec(['worktree', 'list'], projectRoot)
      } catch {
        // ignore
      }
      return { removed: false, summary: `git worktree remove failed: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  /** Read back the allocation for panel display. */
  async allocationFor(proposalId: string): Promise<number[] | undefined> {
    return (await this.allocator.get(proposalId))?.ports
  }
}

