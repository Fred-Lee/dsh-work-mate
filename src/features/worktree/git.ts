/**
 * Shared git helpers for the worktree/lifecycle layer. argv-array execFile
 * only; every probe degrades to a boolean/undefined instead of throwing.
 */
import { execFile } from 'node:child_process'

export function gitExec(
  args: string[],
  cwd: string,
  timeoutMs = 15_000,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      args,
      { cwd, timeout: timeoutMs, ...(signal !== undefined ? { signal } : {}) },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr?.trim() || error.message))
        else resolvePromise(stdout)
      },
    )
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
  // 合并可能发生在远端（GitLab MR / GitHub PR），本地基线分支会落后。
  // 先 best-effort 取回基线引用（只取 onto 一个引用，避免远端已删除的
  // feature 分支让整次 fetch 失败），再按「本地基线或 origin/<基线> 任一可达」判定。
  // 本地-only 仓库 / 离线 / 无该远端引用：fetch 失败静默，行为与不 fetch 时一致。
  const fetched = await gitExec(['fetch', 'origin', onto], root, 15_000)
    .then(() => true)
    .catch(() => false)
  try {
    await gitExec(['merge-base', '--is-ancestor', branch, onto], root, 10_000)
    return true
  } catch {
    if (fetched) {
      try {
        await gitExec(['merge-base', '--is-ancestor', branch, `origin/${onto}`], root, 10_000)
        return true
      } catch {
        // fall through to the local-only verdict
      }
    }
    return false
  }
}

export async function currentBranch(root: string): Promise<string> {
  return (await gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], root, 5_000)).trim()
}

/**
 * Merge `branch` into `baseBranch` in the main checkout. The checkout must be
 * on the base branch and clean; on conflict the merge is aborted so the
 * proposal can stay in merging and a human can resolve it.
 */
export async function mergeBranch(
  root: string,
  branch: string,
  baseBranch: string,
  signal?: AbortSignal,
): Promise<string> {
  const current = await currentBranch(root)
  if (current !== baseBranch) {
    throw new Error(`项目当前在 ${current}，合并前请切到基线分支 ${baseBranch}`)
  }
  const dirtyLines = (await gitExec(['status', '--porcelain'], root, 10_000, signal))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    // Team SUMMARY.md is generated evidence, not implementation: it may be
    // untracked in the main checkout without blocking the G5 merge.
    .filter((line) => !/^\?\? .*\/SUMMARY\.md$/.test(line))
  if (dirtyLines.length > 0) {
    throw new Error(`工作区不干净（${dirtyLines.length} 个改动），先提交或清理再合并`)
  }
  try {
    await gitExec(['merge', '--no-ff', branch, '-m', `merge: ${branch} into ${baseBranch}`], root, 60_000, signal)
    return (await gitExec(['rev-parse', 'HEAD'], root, 5_000, signal)).trim()
  } catch (error) {
    await gitExec(['merge', '--abort'], root, 15_000).catch(() => undefined)
    throw error
  }
}
