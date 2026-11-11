/**
 * Ticket 阶段 → 面板列的投影（change `adopt-superagent-openspec-source`, task 9）。
 *
 * 关键纪律：**不自己推断阶段**。Super-agent 的管理 API 已经把每个 Ticket 算成
 * `{ stage: 'person'|'working'|'idle'|'ended', action?, ended? }`（`src/core/stage.ts`），
 * 这里只做映射，补上"还没有 Ticket"与"读不到"两种面板态。
 *
 * 顺序与 Super-agent 一致：先看 `ended`。它自己的 `ticketStage` 把 ended 放在第一分支，
 * 漏掉就会把已结束的 Ticket 判成执行中。
 */
export type PanelLane = 'todo' | 'working' | 'attention' | 'done'

/** 面板上的子状态；文案由 UI 决定，这里只给稳定的标识。 */
export type PanelSubstate =
  | 'unassigned' // 待办：人已记录但未指派
  | 'not-scanning' // 已指派但 Source 只读/未扫描
  | 'submitted' // 已投递，等待接受
  | 'queued'
  | 'working'
  | 'waiting-trigger'
  | 'answer'
  | 'review'
  | 'blocked'
  | 'failed'
  | 'delivery'
  | 'completed'
  | 'merged'
  | 'closed'
  | 'dropped'
  | 'stopped'
  | 'unknown'

export interface TicketView {
  id: string
  title: string
  /** Super-agent 自己的阶段名。 */
  stage?: string
  action?: string
  ended?: { outcome?: string; at?: string }
  directory?: string
  attention?: { question?: string }
  summary?: string
  sessionId?: string
  /**
   * 该 Ticket 来自哪个执行器端点（多端点聚合时由 `SuperagentPool` 打标，
   * `action()` 按它路由）；单端点 `SuperagentClient` 不填。
   */
  endpoint?: string
}

export interface ProjectionInput {
  /** 任务表里的记录（未指派/已放弃从这来）。 */
  task: {
    id: string
    assigned: boolean
    abandoned: boolean
    attempt: number
  }
  /** 该任务对应的 Ticket；`undefined` = 还没有，或读不到。 */
  ticket?: TicketView
  /** 是否已投递（attempt > 0 且 Source 写过 ack/或我们乐观认为已投）。 */
  submitted: boolean
  /** 读 Ticket 失败的原因；给了就是 `unknown`。 */
  failure?: string
}

export interface Projection {
  lane: PanelLane
  substate: PanelSubstate
  /** 给 UI 的一句话解释（读不到、被忽略等）。 */
  note?: string
}

const ENDED_SUBSTATE: Record<string, PanelSubstate> = {
  completed: 'completed',
  merged: 'merged',
  closed: 'closed',
  dropped: 'dropped',
  stopped: 'stopped',
}

const PERSON_SUBSTATE: Record<string, PanelSubstate> = {
  answer: 'answer',
  review: 'review',
  blocked: 'blocked',
  failed: 'failed',
  delivery: 'delivery',
}

/**
 * 把一个任务投影到四列之一。判定顺序：
 *   1. 读不到 Ticket 且已投递 → `unknown`（不猜）
 *   2. Ticket 已结束 → 已完成（五值全覆盖）
 *   3. Ticket 在 person/* → 需要我
 *   4. Ticket 在 working/idle → 执行中
 *   5. 已指派但还没有 Ticket → 执行中·已投递
 *   6. 已停止（abandoned，无 Ticket）→ 待办·已停止（可重新打开）
 *   7. 未指派 → 待办·未指派
 *
 * 「待办」优先于「已完成」：只有确实有结束的 Ticket 才归已完成（审查 CRIT-19）。
 * 停止（abandoned）但没有 Ticket 的任务留在待办列、标 `stopped`，主按钮是「重新打开」；
 * 它有 Ticket 且 Ticket 已结束时按上面第 2 条归已完成，与 `stop()` 只写本地标记一致。
 */
export function projectTask(input: ProjectionInput): Projection {
  const { task, ticket, submitted, failure } = input

  if (ticket !== undefined) {
    if (ticket.ended !== undefined) {
      const outcome = ticket.ended.outcome ?? ''
      return { lane: 'done', substate: ENDED_SUBSTATE[outcome] ?? 'completed' }
    }
    if (ticket.stage === 'person') {
      const substate = PERSON_SUBSTATE[ticket.action ?? ''] ?? 'answer'
      return {
        lane: 'attention',
        substate,
        ...(ticket.attention?.question !== undefined ? { note: ticket.attention.question } : {}),
      }
    }
    if (ticket.stage === 'idle') return { lane: 'working', substate: 'waiting-trigger' }
    if (ticket.stage === 'working') {
      return { lane: 'working', substate: ticket.action === 'queued' ? 'queued' : 'working' }
    }
    // 阶段名是未知值：对方升级了 stage 枚举。如实标 unknown，不猜。
    return { lane: 'working', substate: 'unknown', note: `未知阶段：${ticket.stage ?? '(空)'}` }
  }

  if (failure !== undefined) {
    return { lane: submitted ? 'working' : 'todo', substate: 'unknown', note: failure }
  }

  if (task.abandoned) {
    // 本地点了停止但没有 Ticket（Ticket 若有结束记录，上面已归已完成）。留在待办列并标
    // stopped：它和「从未指派」是两种事实，合并成 unassigned 会让卡片同时说「未指派」
    // 和「重新打开」（整体体检 #5）。
    return { lane: 'todo', substate: 'stopped' }
  }

  if (!task.assigned) {
    return { lane: 'todo', substate: 'unassigned' }
  }

  if (!submitted) {
    return { lane: 'working', substate: 'not-scanning', note: '已记录，等待执行器扫描' }
  }

  return { lane: 'working', substate: 'submitted', note: '已投递，等待接受' }
}

/** 四个列的固定顺序与标题（UI 与测试共用同一份定义）。 */
export const LANES: ReadonlyArray<{ key: PanelLane; label: string; hint: string }> = [
  { key: 'todo', label: '待办', hint: '未指派 / 已停止' },
  { key: 'working', label: '执行中', hint: '执行器在跑' },
  { key: 'attention', label: '需要我', hint: '等你决定' },
  // done 列只按「Ticket 有结束记录」判定（上面 projectTask 的第 2 条），没有时间窗：
  // 加 24 小时过滤会让卡「过期」后凭空变空，而完成判定是 lane==='done'
  // （advance-scan 的 implementationComplete）——卡被过滤掉，已实现完的提案就永远推不动。
  // done 同时含 completed/merged/closed/dropped/stopped，唯一共性是 Ticket 已结束。
  { key: 'done', label: '已完成', hint: 'Ticket 已结束' },
]

/** 子状态的中文文案；UI 直接取，避免各视图各写一套。 */
export const SUBSTATE_LABEL: Record<PanelSubstate, string> = {
  unassigned: '未指派',
  'not-scanning': '待扫描',
  submitted: '待接受',
  queued: '排队中',
  working: '执行中',
  'waiting-trigger': '等待触发',
  answer: '待回答',
  review: '待验收',
  blocked: '受阻',
  failed: '失败',
  delivery: '投递失败',
  completed: '已完成',
  merged: '已合并',
  closed: '已关闭',
  dropped: '无需处理',
  // 已停止：Ticket 以 stopped 结束，或本地点了停止（abandoned）且没有 Ticket。
  stopped: '已停止',
  unknown: '未知',
}
