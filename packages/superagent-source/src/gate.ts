/**
 * 依赖门控（change `adopt-superagent-openspec-source`, task 4）。
 *
 * 这是纯函数：输入是任务表 + 每个待办的 Ticket 终态，输出"可以投递"与"还在等"。
 * 判定依据必须是 **Ticket 的终态事实**，不能用 `tasks.jsonl` 的行——`reply` 既可能是
 * 结果也可能是提问，用它判完成会把提问误判成完成（审查 CRIT-14）。
 *
 * `stopped` / `dropped` 与众不同：它们表示"这件事不会完成了"，下游不该自动放行，
 * 而应停在等待并让人处理（spec: 依赖门控属于 Source）。
 */

export type TaskGateStatus = 'completed' | 'merged' | 'closed' | 'dropped' | 'stopped'

export interface GateTask {
  id: string
  dependsOn: readonly string[]
  assigned: boolean
  abandoned: boolean
  /**
   * 待办所属仓库。门控本身**不看**它（依赖门控语义单一，design D3）；它随 `ready`
   * 一起带出去，供 `scanOnce` 按实例 `repos` 过滤。
   */
  repo: string
}

export interface GateInput<T extends GateTask> {
  tasks: readonly T[]
  /** 该待办的 Ticket 终态；`undefined` 表示还没有 Ticket（或还没产生）。 */
  terminalOf: (taskId: string) => TaskGateStatus | undefined
}

export interface GateReady<T extends GateTask> {
  task: T
}

export interface GateWaiting<T extends GateTask> {
  task: T
  /** 依赖里还有 Ticket 在跑的（按 id 列出）。 */
  pending: string[]
  /** 依赖里被 stopped/dropped 的，永远等不到。 */
  dead: string[]
  /** 依赖里根本不存在的 id。 */
  missing: string[]
}

export interface GateResult<T extends GateTask> {
  ready: T[]
  waiting: GateWaiting<T>[]
  /** 依赖图里的环；有环时整张表都不会放行。 */
  cycles: string[][]
}

const isSatisfied = (status: TaskGateStatus | undefined): boolean =>
  status === 'completed' || status === 'merged' || status === 'closed'

/**
 * 计算本轮的投递候选。
 *
 * 规则：
 * - `abandoned` 永不投递；
 * - 未 `assigned` 不投递（人还没决定要做）；
 * - `dependsOn` 的每个前置都必须有"已完成"的 Ticket 终态；
 * - 前置不存在 → `missing`；前置没有 Ticket → `pending`；前置 stopped/dropped → `dead`；
 * - 环会被检测出来，避免整表永久静默。
 */
export function evaluateGate<T extends GateTask>(input: GateInput<T>): GateResult<T> {
  const byId = new Map(input.tasks.map((task) => [task.id, task]))
  const ready: T[] = []
  const waiting: GateWaiting<T>[] = []

  for (const task of input.tasks) {
    if (task.abandoned || !task.assigned) continue
    const pending: string[] = []
    const dead: string[] = []
    const missing: string[] = []
    for (const dependency of task.dependsOn) {
      if (!byId.has(dependency)) {
        missing.push(dependency)
        continue
      }
      const status = input.terminalOf(dependency)
      if (status === undefined) pending.push(dependency)
      else if (!isSatisfied(status)) dead.push(dependency)
    }
    if (pending.length > 0 || dead.length > 0 || missing.length > 0) {
      waiting.push({ task, pending, dead, missing })
      continue
    }
    ready.push(task)
  }

  return { ready, waiting, cycles: findCycles(input.tasks) }
}

/**
 * 本轮实际要投递的待办：按 P0 > P1 > P2 → createdAt → id 排序后截断到 `maxPerScan`。
 * `priority`/`createdAt` 由调用方传入，保持本函数与任务存储形状解耦。
 */
export function selectForScan<T extends GateTask>(
  ready: readonly T[],
  options: {
    maxPerScan: number
    priorityOf: (task: T) => string
    createdAtOf: (task: T) => string
  },
): T[] {
  const rank = (priority: string): number => (priority === 'P0' ? 0 : priority === 'P1' ? 1 : 2)
  const sorted = [...ready].sort((left, right) => {
    const byPriority = rank(options.priorityOf(left)) - rank(options.priorityOf(right))
    if (byPriority !== 0) return byPriority
    const byTime = options.createdAtOf(left).localeCompare(options.createdAtOf(right))
    if (byTime !== 0) return byTime
    return left.id.localeCompare(right.id)
  })
  return sorted.slice(0, Math.max(0, options.maxPerScan))
}

/** 找出依赖图里的环（只报简单环，够用于健康提示）。 */
export function findCycles<T extends GateTask>(tasks: readonly T[]): string[][] {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const cycles: string[][] = []
  const visited = new Set<string>()
  const stack: string[] = []
  const onStack = new Set<string>()

  const walk = (id: string): void => {
    if (onStack.has(id)) {
      const start = stack.indexOf(id)
      if (start >= 0) cycles.push([...stack.slice(start), id])
      return
    }
    if (visited.has(id)) return
    visited.add(id)
    stack.push(id)
    onStack.add(id)
    const task = byId.get(id)
    for (const dependency of task?.dependsOn ?? []) {
      if (byId.has(dependency)) walk(dependency)
    }
    stack.pop()
    onStack.delete(id)
  }

  for (const task of tasks) walk(task.id)
  return cycles
}
