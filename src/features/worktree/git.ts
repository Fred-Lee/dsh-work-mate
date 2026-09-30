/**
 * Shared git helpers for the worktree/lifecycle layer. argv-array execFile
 * only; every probe degrades to a boolean/undefined instead of throwing.
 */
import { execFile } from 'node:child_process'

export function gitExec(args: string[], cwd: string, timeoutMs = 15_000): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', args, { cwd, timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr?.trim() || error.message))
      else resolvePromise(stdout)
    })
  })
}

export async function branchExists(root: string, branch: string): Promise<boolean> {
  try {
    await gitExec(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], root, 5_000)
    return true
  } catch {
    return false
  }
}

/** True when `branch` is an ancestor of `onto` (i.e. its content is merged in). */
export async function isMergedInto(root: string, branch: string, onto: string): Promise<boolean> {
  try {
    await gitExec(['merge-base', '--is-ancestor', branch, onto], root, 10_000)
    return true
  } catch {
    return false
  }
}

export async function currentBranch(root: string): Promise<string> {
  return (await gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], root, 5_000)).trim()
}
