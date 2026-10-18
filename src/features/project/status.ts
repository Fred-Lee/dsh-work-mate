/** Lightweight git status for the project tree (change `multiproject-branch-workbench`, 6.2). */
import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'

export interface ProjectGitStatus {
  branch: string
  headShort: string
  dirtyCount: number
  isWorktree: boolean
}

const git = (args: string[], root: string): Promise<string | undefined> =>
  new Promise((resolvePromise) => {
    execFile('git', args, { cwd: root }, (error, stdout) => resolvePromise(error ? undefined : stdout.trim()))
  })

export async function getProjectGitStatus(root: string): Promise<ProjectGitStatus | undefined> {
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], root)
  const headShort = await git(['rev-parse', '--short', 'HEAD'], root)
  if (branch === undefined || headShort === undefined) return undefined
  const status = await git(['status', '--porcelain'], root)
  const dirtyCount = status === undefined ? 0 : status.split('\n').filter((line) => line.trim() !== '').length
  const worktree = await git(['rev-parse', '--show-toplevel'], root)
  const [realRoot, realTop] = await Promise.all([
    realpath(root).catch(() => root),
    worktree === undefined ? Promise.resolve(undefined) : realpath(worktree).catch(() => worktree),
  ])
  return {
    branch,
    headShort,
    dirtyCount,
    isWorktree: realTop !== undefined && realTop !== realRoot,
  }
}
