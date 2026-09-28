/**
 * Proposal ↔ Git-commit association, pull mode (design D3): status queries run
 * `git log --all --fixed-strings --grep '[proposal:<id>]'` in the project root.
 * No host Git-event API is involved — that surface is unverified, and a read-only
 * log scan is idempotent. Subprocess discipline: execFile + argv array, no shell.
 */
import { execFile } from 'node:child_process'
import { validateProjectRoot } from './openspec.ts'

export interface AssociatedCommit {
  hash: string
  short: string
  subject: string
}

export interface GitScanResult {
  commits: AssociatedCommit[]
  /** Present when the scan could not run (not a repo, git missing). */
  note?: string
}

function execGit(args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', args, { cwd, timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        const message = stderr?.trim() || error.message
        reject(new Error(message))
      } else {
        resolvePromise(stdout)
      }
    })
  })
}

export async function listProposalCommits(
  projectRoot: string,
  proposalId: string,
): Promise<GitScanResult> {
  const root = validateProjectRoot(projectRoot)
  const marker = `[proposal:${proposalId}]`
  const format = '%H%x09%h%x09%s'
  let stdout: string
  try {
    stdout = await execGit(
      ['log', '--all', '--fixed-strings', `--grep=${marker}`, `--format=${format}`],
      root,
      10_000,
    )
  } catch (error) {
    return { commits: [], note: `git scan unavailable: ${error instanceof Error ? error.message : String(error)}` }
  }

  const commits: AssociatedCommit[] = []
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    const [hash, short, subject] = line.split('\t')
    if (!hash || !short) continue
    commits.push({ hash, short, subject: subject ?? '' })
  }
  return { commits }
}

/** Resolve a bare short hash to the full hash (archive orchestration, M4). */
export async function verifyCommitExists(projectRoot: string, hash: string): Promise<boolean> {
  const root = validateProjectRoot(projectRoot)
  try {
    await execGit(['cat-file', '-e', `${hash}^{commit}`], root, 5_000)
    return true
  } catch {
    return false
  }
}
