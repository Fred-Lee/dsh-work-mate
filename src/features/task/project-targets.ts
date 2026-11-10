/**
 * target 的分支与基线回写（change `adopt-superagent-openspec-source`, design D10c / task 20）。
 *
 * `ready→implementing` 不再创建 worktree 后，`targets[].featureBranch` 与 `baseCommit`
 * 失去了唯一的写入点；而归档前置（`archive/service.ts`）与 G5 合并都要读它。
 * 所以在**观察到 Ticket 之后**由 WorkMate 回写：
 *
 *   目录 `<repo>/.workmates/workmate-<ticketId前12位>` → 分支 `workmate/<末段>`（与 prepare 一致）
 *
 * 回写是幂等的；已存在且不同的值视为冲突并**不覆盖**——那说明两套规则打架，
 * 静默改写会让归档门校验一个没人创建的分支。
 */
import { basename, join } from 'node:path'
import { gitExec } from '../worktree/git.ts'
import type { ProposalService } from '../proposal/service.ts'
import type { Proposal } from '../proposal/store.ts'
import type { TaskRecord } from './files.ts'
import type { TicketView } from '../superagent/project.ts'
import type { ProjectRegistry } from '../project/registry.ts'

export interface WritebackDeps {
  proposals: ProposalService
  registry: ProjectRegistry
  /** 分支前缀；与 prepare 模板里的 `workmate/` 必须一致。 */
  branchPrefix?: string
}

export interface WritebackResult {
  /** 本次真正写入的 target（`proposalId/project`）。 */
  updated: string[]
  /** 已存在且不同的分支：不覆盖，只上报。 */
  conflicts: string[]
  /** 找不到提案或 target 的条目。 */
  missing: string[]
}

/** 由 Ticket 目录推分支名：目录末段与 prepare 创建的分支一致。 */
export function branchOf(directory: string, prefix = 'workmate/'): string {
  return `${prefix}${basename(directory)}`
}

/**
 * 把待办的 `repo` 归一成提案 target 用的**项目名**。
 *
 * `task.repo` 存绝对路径（`5f03447` 起，Source 与执行器按路径比对），而
 * `ProposalTarget.project` 存注册表里的项目名。直接 `===` 比较永远不相等，
 * `featureBranch` 就永远不会回写，归档前置必然报「缺少实现分支」（实测 2026-11-10）。
 *
 * 归一顺序：注册表按 root 反查 → 路径末段 → 原样返回（已经是项目名时）。
 */
export async function projectOfRepo(registry: ProjectRegistry, repo: string): Promise<string> {
  const trimmed = repo.trim()
  if (trimmed === '') return trimmed
  // 不含路径分隔符 = 已经是项目名，省一次注册表查询。
  if (!trimmed.includes('/') && !trimmed.includes('\\')) return trimmed
  const registered = await registry.list().catch(() => [] as Awaited<ReturnType<ProjectRegistry['list']>>)
  return registered.find((entry) => entry.root === trimmed)?.name ?? basename(trimmed)
}

/**
 * 把一条观察到的 Ticket 回写到它对应的提案 target。
 * 只写 `featureBranch` / `baseCommit`，其余字段保持原样。
 */
export async function writeBackTarget(
  deps: WritebackDeps,
  task: TaskRecord,
  ticket: TicketView,
): Promise<'updated' | 'conflict' | 'missing' | 'skipped'> {
  if (task.proposalId === undefined || ticket.directory === undefined) return 'skipped'
  const proposal = await deps.proposals.get(task.proposalId)
  if (proposal === undefined) return 'missing'
  const targets = proposal.targets ?? []
  // repo 可能是绝对路径（新的写入方）或项目名（历史记录）：两者都归一后再比。
  const project = await projectOfRepo(deps.registry, task.repo)
  const index = targets.findIndex((target) => target.project === project || target.project === task.repo)
  if (index === -1) return 'missing'
  const target = targets[index]
  if (target === undefined) return 'missing'

  const branch = branchOf(ticket.directory, deps.branchPrefix ?? 'workmate/')
  if (target.featureBranch !== undefined && target.featureBranch !== '') {
    return target.featureBranch === branch ? 'skipped' : 'conflict'
  }

  let baseCommit: string | undefined
  const registered = await deps.registry.get(task.repo)
  if (registered !== undefined) {
    baseCommit = await gitExec(['rev-parse', '--verify', `${target.baseBranch}^{commit}`], registered.root, 5_000)
      .then((value) => value.trim() || undefined)
      .catch(() => undefined)
  }

  const next = [...targets]
  next[index] = {
    ...target,
    featureBranch: branch,
    ...(baseCommit !== undefined ? { baseCommit } : {}),
  }
  // 有 targets 时只写 targets；不要回填旧标量投影（多 target 语义）。
  await deps.proposals.patchFields(proposal.id, { targets: next })
  return 'updated'
}

/**
 * 批量回写：遍历"有提案、有 Ticket 目录"的任务。
 * 返回逐项结果，供面板显示冲突（冲突不能静默）。
 */
export async function writeBackTargets(
  deps: WritebackDeps,
  observed: ReadonlyArray<{ task: TaskRecord; ticket: TicketView }>,
): Promise<WritebackResult> {
  const result: WritebackResult = { updated: [], conflicts: [], missing: [] }
  for (const entry of observed) {
    const key = `${entry.task.proposalId ?? '?'}/${entry.task.repo}`
    const outcome = await writeBackTarget(deps, entry.task, entry.ticket)
    if (outcome === 'updated') result.updated.push(key)
    else if (outcome === 'conflict') result.conflicts.push(key)
    else if (outcome === 'missing') result.missing.push(key)
  }
  return result
}

/** 回收时需要一个稳定的 worktree 路径；目录名约定集中在这里，便于回滚脚本复用。 */
export function expectedWorktreePath(repoRoot: string, ticketDirectory: string): string {
  return join(repoRoot, '.workmates', basename(ticketDirectory))
}

/** 供测试与面板使用：确认一个分支名是否属于本来源。 */
export function isWorkmateBranch(branch: string, prefix = 'workmate/'): boolean {
  return branch.startsWith(prefix)
}

/** 类型别名：让调用方不必同时导入 Proposal。 */
export type ProposalLike = Pick<Proposal, 'id' | 'targets' | 'projects'>
