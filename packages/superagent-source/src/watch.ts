/**
 * 扫描与投递（change `adopt-superagent-openspec-source`, task 6）。
 *
 * 一轮扫描做三件事：
 *   1. 读三份文件，算依赖门控与待投递集合（`gate.ts`）；
 *   2. 把**人的回答**优先投递（不受 `maxPerScan` 限制）；
 *   3. 把经门控筛出的待办按上限投递。
 *
 * 这里不碰文件系统之外的东西：`receive`、`terminals`、`state` 都由调用方注入，
 * 所以整轮逻辑可以在测试里逐条断言。
 */
import type { Trigger } from './contract.ts'
import { channelRef, inputTriggerId, threadRef, triggerId } from './contract.ts'
import { evaluateGate, selectForScan, findCycles } from './gate.ts'
import type { TaskGateStatus } from './gate.ts'
import { unconsumedInputs, type InputRow, type ResultRow, type TaskRecord } from './files.ts'

/** 本 Source 需要的、来自 `SourceContext` 的最小能力。 */
export interface WatchHost {
  /** 投递一条 Trigger；返回是否新增（`duplicate` 表示已被接收过）。 */
  receive(trigger: Trigger): { stored: boolean; duplicate?: boolean } | Promise<{ stored: boolean; duplicate?: boolean }>
  /** 某待办当前 Ticket 的终态；无 Ticket 时 `undefined`。 */
  terminalOf(taskId: string): TaskGateStatus | undefined
  /** 读取游标（持久化在 Source 自己的 state 里）。 */
  readCursor(): number
  writeCursor(seq: number): void
}

export interface ScanInput {
  tasks: readonly TaskRecord[]
  inputs: readonly InputRow[]
  maxPerScan: number
  /** 只读模式：不产生任何 Trigger，但游标照常推进（避免开启后一次性灌入历史回答）。 */
  interactive: boolean
  now: () => Date
}

export interface ScanOutcome {
  /** 投递成功的待办 id。 */
  submitted: string[]
  /** 投递成功的人消息 seq。 */
  replied: number[]
  /** 已投递但 Super-agent 判为重复的待办 id。 */
  duplicates: string[]
  /** 本轮因上限未投递的数量。 */
  deferred: number
  /** 等待依赖的待办 id。 */
  waitingOnDependency: string[]
  /** 依赖不存在或已死的待办 id（需要人处理）。 */
  blockedByDependency: string[]
  /** 依赖图里的环。 */
  cycles: string[][]
  /** 只读模式下的总数（未投递）。 */
  readOnly: number
}

const taskById = (tasks: readonly TaskRecord[]): Map<string, TaskRecord> =>
  new Map(tasks.map((task) => [task.id, task]))

/** 由待办构造指派 Trigger。 */
export function buildTaskTrigger(task: TaskRecord, at: string): Trigger {
  return {
    id: triggerId(task.id, task.attempt),
    source: 'workmate',
    threads: [threadRef(task.id)],
    actor: { source: 'workmate', id: task.createdBy },
    human: true,
    addressed: 'mention',
    at,
    text: task.intent,
    channel: channelRef(task.id),
    meta: {
      taskId: task.id,
      repo: task.repo,
      baseBranch: task.baseBranch,
      acceptance: task.acceptance,
      priority: task.priority,
      ports: task.ports ?? [],
      ...(task.proposalId !== undefined ? { proposalId: task.proposalId } : {}),
    },
  }
}

/** 由一行人输入构造 Trigger：与指派同 Thread，作为后续消息直通 worker。 */
export function buildInputTrigger(row: InputRow, task: TaskRecord): Trigger {
  return {
    id: inputTriggerId(row.taskId, row.seq),
    source: 'workmate',
    threads: [threadRef(row.taskId)],
    actor: { source: 'workmate', id: row.by },
    human: true,
    addressed: 'mention',
    at: row.at,
    text: row.text,
    channel: channelRef(row.taskId),
    meta: {
      taskId: row.taskId,
      ...(row.replyTo !== undefined ? { replyTo: row.replyTo } : {}),
      ...(task.proposalId !== undefined ? { proposalId: task.proposalId } : {}),
    },
  }
}

/**
 * 跑一轮扫描。顺序固定：先回答、后新任务，这样人在等的事情不会被积压的新任务挤掉。
 * 只读模式推进游标但不投递——否则从只读切到投递时会把历史回答一次性灌进去。
 */
export async function scanOnce(host: WatchHost, input: ScanInput): Promise<ScanOutcome> {
  const byId = taskById(input.tasks)
  const cursor = host.readCursor()
  const pending = unconsumedInputs(
    { rows: [...input.inputs], skipped: 0, maxSeq: input.inputs.reduce((max, row) => Math.max(max, row.seq), 0) },
    cursor,
  )

  const replied: number[] = []
  let nextCursor = cursor
  for (const row of pending.rows) {
    nextCursor = Math.max(nextCursor, row.seq)
    if (!input.interactive) continue
    const task = byId.get(row.taskId)
    // 待办已被删除：跳过但仍推进游标，避免永远卡在同一条。
    if (task === undefined) continue
    const result = await host.receive(buildInputTrigger(row, task))
    if (result.duplicate !== true) replied.push(row.seq)
  }
  if (nextCursor !== cursor) host.writeCursor(nextCursor)

  const gate = evaluateGate({
    tasks: input.tasks.map((task) => ({
      id: task.id,
      dependsOn: task.dependsOn,
      assigned: task.assigned,
      abandoned: task.abandoned,
    })),
    terminalOf: (taskId) => host.terminalOf(taskId),
  })

  const readyTasks = gate.ready
    .map((entry) => byId.get(entry.id))
    .filter((task): task is TaskRecord => task !== undefined)

  if (!input.interactive) {
    return {
      submitted: [],
      replied,
      duplicates: [],
      deferred: 0,
      waitingOnDependency: gate.waiting.map((entry) => entry.task.id),
      blockedByDependency: gate.waiting
        .filter((entry) => entry.dead.length > 0 || entry.missing.length > 0)
        .map((entry) => entry.task.id),
      cycles: gate.cycles.length > 0 ? gate.cycles : findCycles(input.tasks),
      readOnly: readyTasks.length,
    }
  }

  const selected = selectForScan(readyTasks, {
    maxPerScan: input.maxPerScan,
    priorityOf: (task) => task.priority,
    createdAtOf: (task) => task.createdAt,
  })
  const submitted: string[] = []
  const duplicates: string[] = []
  const at = input.now().toISOString()
  for (const task of selected) {
    const result = await host.receive(buildTaskTrigger(task, at))
    if (result.duplicate === true) duplicates.push(task.id)
    else submitted.push(task.id)
  }

  return {
    submitted,
    replied,
    duplicates,
    deferred: Math.max(0, readyTasks.length - selected.length),
    waitingOnDependency: gate.waiting.map((entry) => entry.task.id),
    blockedByDependency: gate.waiting
      .filter((entry) => entry.dead.length > 0 || entry.missing.length > 0)
      .map((entry) => entry.task.id),
    cycles: gate.cycles.length > 0 ? gate.cycles : findCycles(input.tasks),
    readOnly: 0,
  }
}

/** 每轮扫描后应写入健康条目的摘要（由入口层转成 `report` 调用）。 */
export function healthSummaryOf(outcome: ScanOutcome, results: readonly ResultRow[]): {
  state: 'ready' | 'paused'
  detail: string
} {
  // 环优先：有环时整表都不会放行，必须让人看到，而不是报"正常，只是没得投"。
  if (outcome.cycles.length > 0) {
    const head = outcome.cycles[0]?.join(' → ') ?? ''
    return { state: 'paused', detail: `依赖环：${head}` }
  }
  if (outcome.readOnly > 0 || (outcome.submitted.length === 0 && outcome.deferred === 0 && outcome.readOnly === 0)) {
    const waiting = outcome.waitingOnDependency.length
    return {
      state: 'ready',
      detail: `只读：${outcome.readOnly} 条可投递` + (waiting > 0 ? `，${waiting} 条等待依赖` : ''),
    }
  }
  const parts = [`投递 ${outcome.submitted.length}`]
  if (outcome.replied.length > 0) parts.push(`回答 ${outcome.replied.length}`)
  if (outcome.deferred > 0) parts.push(`待投递 ${outcome.deferred}`)
  if (outcome.waitingOnDependency.length > 0) parts.push(`等待依赖 ${outcome.waitingOnDependency.length}`)
  if (outcome.blockedByDependency.length > 0) parts.push(`依赖受阻 ${outcome.blockedByDependency.length}`)
  if (results.length > 0) parts.push(`记录 ${results.length}`)
  return { state: 'ready', detail: parts.join('，') }
}
