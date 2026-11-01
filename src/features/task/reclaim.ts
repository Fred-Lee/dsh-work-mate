/**
 * worktree 回收与遗留目录（change `adopt-superagent-openspec-source`, task 14）。
 *
 * 执行交给 Super-agent 后，目录由它的 `prepare` 创建、且**从不删除**（唯一的删除是
 * prepare 失败时清理空目录）。所以回收完全落在 WorkMate 这边，并且要能满足两个前提：
 *
 *   1. 对应 Ticket 已结束（否则删的是正在跑的 worker 的 cwd）；
 *   2. 分支已合并进该 target 的基线（否则丢掉未合并的工作）。
 *
 * 路径来自 `tasks.jsonl` 里带 `ticketId` 的送达记录与任务记录缓存的目录；
 * 两者都没有时不猜——留给人确认，避免误删别人的目录。
 */
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { gitExec, isMergedInto } from '../worktree/git.ts'
import type { PortAllocator } from '../worktree/port-allocator.ts'
import { releaseLegacyPorts, releaseTaskPorts } from './plan.ts'
import type { TaskRecord } from './files.ts'

export interface ReclaimDeps {
  worktreeRoots: (repo: string) => Promise<string | undefined>
  ports?: PortAllocator
  /** 只读探测：Ticket 是否还活着（由 superagent 客户端提供）。 */
  ticketAlive: (ticketId: string) => Promise<boolean | undefined>
  branchPrefix?: string
}

export interface ReclaimTarget {
  task: TaskRecord
  /** 由 Ticket 投影或送达记录得到的目录名（末段）。 */
  directory: string
  ticketId?: string
}

export interface ReclaimOutcome {
  taskId: string
  repo: string
  directory: string
  removed: boolean
  /** 未回收的原因（拒绝时必填）。 */
  reason?: string
  portsReleased: boolean
}

export interface LeftoverEntry {
  taskId: string
  repo: string
  directory: string
  ticketId?: string
  /** 目录是否仍在磁盘上（只做 stat，不读内容）。 */
  present: boolean
}

const branchOf = (directory: string, prefix: string): string => `${prefix}${basename(directory)}`

/**
 * 回收一个 target：前置不满足就拒绝并给原因，**不静默跳过**。
 * `force` 只用于"分支未合并但人已确认"的场景；Ticket 还活着时永远拒绝。
 */
export async function reclaimOne(
  deps: ReclaimDeps,
  target: ReclaimTarget,
  options: { force?: boolean } = {},
): Promise<ReclaimOutcome> {
  const prefix = deps.branchPrefix ?? 'workmate/'
  const base = { taskId: target.task.id, repo: target.task.repo, directory: target.directory, portsReleased: false }

  if (target.ticketId !== undefined) {
    const alive = await deps.ticketAlive(target.ticketId)
    if (alive === true) {
      return { ...base, removed: false, reason: `Ticket ${target.ticketId} 仍在执行 — 先停止再回收` }
    }
  }

  const root = await deps.worktreeRoots(target.task.repo)
  if (root === undefined) {
    return { ...base, removed: false, reason: `仓库 ${target.task.repo} 未注册 — 无法定位 worktree` }
  }

  const branch = branchOf(target.directory, prefix)
  if (options.force !== true) {
    const merged = await isMergedInto(root, branch, target.task.baseBranch)
    if (!merged) {
      return {
        ...base,
        removed: false,
        reason: `分支 ${branch} 尚未合并进 ${target.task.baseBranch} — 确认后再回收`,
      }
    }
  }

  const path = join(root, '.workmates', basename(target.directory))
  const removed = await gitExec(['worktree', 'remove', '--force', path], root, 15_000)
    .then(() => true)
    .catch(() => false)
  if (!removed) {
    return { ...base, removed: false, reason: `git worktree remove 失败：${path}` }
  }

  // 分支删除失败不算回收失败：目录已经没了，分支留着无害。
  await gitExec(['branch', '-D', branch], root, 10_000).catch(() => undefined)

  const portsReleased =
    deps.ports === undefined
      ? false
      : (await releaseTaskPorts(deps.ports, {
          ...(target.task.proposalId !== undefined ? { proposalId: target.task.proposalId } : {}),
          project: target.task.repo,
          taskId: target.task.id,
        })) ||
        (target.task.proposalId !== undefined
          ? await releaseLegacyPorts(deps.ports, { proposalId: target.task.proposalId, project: target.task.repo })
          : false)

  return { ...base, removed: true, portsReleased }
}

/** 逐个回收；单个失败只记原因，不影响其余（与既有归档纪律一致）。 */
export async function reclaimAll(
  deps: ReclaimDeps,
  targets: ReadonlyArray<ReclaimTarget>,
  options: { force?: boolean } = {},
): Promise<ReclaimOutcome[]> {
  const outcomes: ReclaimOutcome[] = []
  for (const target of targets) outcomes.push(await reclaimOne(deps, target, options))
  return outcomes
}

/** 从 `tasks.jsonl` 的送达记录里取"任务 → Ticket"的映射（最新一条为准）。 */
export async function ticketIdsFromResults(file: string): Promise<Record<string, string>> {
  const raw = await readFile(file, 'utf8').catch(() => '')
  const map: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const text = line.trim()
    if (text === '') continue
    try {
      const parsed = JSON.parse(text) as { taskId?: unknown; ticketId?: unknown }
      if (typeof parsed.taskId === 'string' && typeof parsed.ticketId === 'string' && parsed.ticketId !== '') {
        map[parsed.taskId] = parsed.ticketId
      }
    } catch {
      // 撕裂尾行：忽略
    }
  }
  return map
}

/**
 * 遗留目录：Ticket 已结束但仍存在的目录。
 * `present` 只做存在性判断（外部注入，避免测试依赖真实磁盘）。
 */
export function leftoversOf(
  targets: ReadonlyArray<ReclaimTarget>,
  presence: (directory: string) => boolean,
): LeftoverEntry[] {
  return targets
    .filter((target) => target.ticketId !== undefined)
    .map((target) => ({
      taskId: target.task.id,
      repo: target.task.repo,
      directory: target.directory,
      ...(target.ticketId !== undefined ? { ticketId: target.ticketId } : {}),
      present: presence(target.directory),
    }))
    .filter((entry) => entry.present)
}
