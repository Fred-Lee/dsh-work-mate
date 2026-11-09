/**
 * 扫描与投递（change `adopt-superagent-openspec-source`, task 6；
 * 多实例与按仓库过滤见 change `support-multi-repo-executors`, task 3）。
 *
 * 一轮扫描做三件事：
 *   1. 读三份文件，算依赖门控（`gate.ts`），再按实例的 `repos` 过滤掉别人负责的仓库（design D3）；
 *   2. 把**人的回答**优先投递（不受 `maxPerScan` 限制）；
 *   3. 把经门控与仓库筛出的待办按上限投递。
 *
 * 这里不碰文件系统之外的东西：`receive`、`terminals`、`state` 都由调用方注入，
 * 所以整轮逻辑可以在测试里逐条断言。
 */
import { normalize } from 'node:path'
import type { Trigger } from './contract.ts'
import { SOURCE, channelRef, inputTriggerId, threadRef, triggerId } from './contract.ts'
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
  /**
   * 实例 id：派生 Trigger `source`、Thread ref、Channel ref 与确定性 ID 前缀。
   * 运行期对没传的 JS 调用点（`scripts/verify-superagent-offline.mjs` 的演练）回落到默认实例。
   */
  source: string
  /**
   * 本实例负责的仓库绝对路径；空数组 = 不限制（旧行为）。
   * 运行期对没传的 JS 调用点按空数组处理。
   */
  repos: readonly string[]
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
  /** 本轮因仓库不属于本实例而跳过的待办数量（design D3）。 */
  skippedByRepo: number
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

/**
 * 仓库路径规范化：只做**位置不变**的整理（去首尾空白、合并重复分隔符、消解 `.`/`..`、
 * 去掉末尾 `/`）。
 *
 * 刻意**不**做两件事：
 *   - 不 resolve 相对路径：`repos` 约定是绝对路径，把相对路径拼到当前工作目录上会得到
 *     一个和部署无关的假相等；
 *   - 不按 basename 比较：两个仓库可能同名不同路径（`/srv/a/svc` 与 `/srv/b/svc`），
 *     按名字猜会把待办投给错误的执行器。宁可跳过（会计入 `skippedByRepo`）也不猜。
 */
export function normalizeRepoPath(value: string): string {
  const trimmed = value.trim()
  // `normalize('')` 会返回 '.'，空路径必须先短路。
  if (trimmed === '') return ''
  const normalized = normalize(trimmed)
  // normalize 对绝对路径会保留结尾分隔符之外的尾斜杠差异；这里统一去掉「根以外」的尾斜杠。
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized
}

/** 某条待办是否归本实例负责；`repos` 为空表示不限制（旧部署行为）。 */
export function repoMatches(taskRepo: string, repos: readonly string[]): boolean {
  if (repos.length === 0) return true
  const candidate = normalizeRepoPath(taskRepo)
  // 待办没写仓库：无法归属到任何实例，跳过而不是猜（会体现在 skippedByRepo 里）。
  if (candidate === '') return false
  return repos.some((repo) => normalizeRepoPath(repo) === candidate)
}

/** 由待办构造指派 Trigger。`source` 是实例 id（默认实例为 'workmate'）。 */
export function buildTaskTrigger(task: TaskRecord, at: string, source: string = SOURCE): Trigger {
  return {
    id: triggerId(task.id, task.attempt, source),
    source,
    threads: [threadRef(task.id, source)],
    // actor 是**人**的身份命名空间，恒为 'workmate'，不随实例走：见 contract.ts 的 SOURCE 注释。
    actor: { source: SOURCE, id: task.createdBy },
    human: true,
    addressed: 'mention',
    at,
    text: task.intent,
    channel: channelRef(task.id, source),
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
export function buildInputTrigger(row: InputRow, task: TaskRecord, source: string = SOURCE): Trigger {
  return {
    id: inputTriggerId(row.taskId, row.seq, source),
    source,
    threads: [threadRef(row.taskId, source)],
    actor: { source: SOURCE, id: row.by },
    human: true,
    addressed: 'mention',
    at: row.at,
    text: row.text,
    channel: channelRef(row.taskId, source),
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
 *
 * 仓库过滤只作用于**新任务**：人的回答指向的是本实例已经拥有的 Thread，按 repo 过滤
 * 会把回答静默丢掉；而"被跳过的待办不推进任何游标"（游标只服务回答）由代码结构保证——
 * 过滤发生在游标处理之后，且跳过的待办根本不参与投递。
 */
export async function scanOnce(host: WatchHost, input: ScanInput): Promise<ScanOutcome> {
  const source = input.source ?? SOURCE
  const repos = input.repos ?? []
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
    const result = await host.receive(buildInputTrigger(row, task, source))
    if (result.duplicate !== true) replied.push(row.seq)
  }
  if (nextCursor !== cursor) host.writeCursor(nextCursor)

  const gate = evaluateGate({
    tasks: input.tasks.map((task) => ({
      id: task.id,
      dependsOn: task.dependsOn,
      assigned: task.assigned,
      abandoned: task.abandoned,
      repo: task.repo,
    })),
    terminalOf: (taskId) => host.terminalOf(taskId),
  })

  // 过滤放在门控**之后**、`selectForScan` **之前**：先回答"该不该等依赖"，再回答
  // "这个仓库归不归我"——两种等待在健康摘要里才能分开报（design D3）。
  const gated = gate.ready.filter((entry) => repoMatches(entry.repo, repos))
  const skippedByRepo = gate.ready.length - gated.length
  const readyTasks = gated
    .map((entry) => byId.get(entry.id))
    .filter((task): task is TaskRecord => task !== undefined)

  if (!input.interactive) {
    return {
      submitted: [],
      replied,
      duplicates: [],
      deferred: 0,
      skippedByRepo,
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
    const result = await host.receive(buildTaskTrigger(task, at, source))
    if (result.duplicate === true) duplicates.push(task.id)
    else submitted.push(task.id)
  }

  return {
    submitted,
    replied,
    duplicates,
    deferred: Math.max(0, readyTasks.length - selected.length),
    skippedByRepo,
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
  // 跳过数写进每一条摘要：多实例部署时，"我负责的仓库没活"与"整表没活"必须能区分，
  // 否则人会去查为什么另一个仓库的待办不动（它只是不归这个实例）。
  const skipped = outcome.skippedByRepo > 0 ? `跳过 ${outcome.skippedByRepo} 条（非本实例仓库）` : ''
  // 环优先：有环时整表都不会放行，必须让人看到，而不是报"正常，只是没得投"。
  if (outcome.cycles.length > 0) {
    const head = outcome.cycles[0]?.join(' → ') ?? ''
    return { state: 'paused', detail: [`依赖环：${head}`, skipped].filter((part) => part !== '').join('，') }
  }
  if (outcome.readOnly > 0 || (outcome.submitted.length === 0 && outcome.deferred === 0 && outcome.readOnly === 0)) {
    const waiting = outcome.waitingOnDependency.length
    const parts = [`只读：${outcome.readOnly} 条可投递`]
    if (waiting > 0) parts.push(`${waiting} 条等待依赖`)
    if (skipped !== '') parts.push(skipped)
    return { state: 'ready', detail: parts.join('，') }
  }
  const parts = [`投递 ${outcome.submitted.length}`]
  if (outcome.replied.length > 0) parts.push(`回答 ${outcome.replied.length}`)
  if (outcome.deferred > 0) parts.push(`待投递 ${outcome.deferred}`)
  if (outcome.waitingOnDependency.length > 0) parts.push(`等待依赖 ${outcome.waitingOnDependency.length}`)
  if (outcome.blockedByDependency.length > 0) parts.push(`依赖受阻 ${outcome.blockedByDependency.length}`)
  if (skipped !== '') parts.push(skipped)
  if (results.length > 0) parts.push(`记录 ${results.length}`)
  return { state: 'ready', detail: parts.join('，') }
}
