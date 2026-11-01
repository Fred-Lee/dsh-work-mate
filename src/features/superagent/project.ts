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
 *   6. 未指派 / 已放弃 → 待办
 *
 * 「待办」优先于「已放弃」：放弃但没有 Ticket 的待办回到待办列（可重新打开），
 * 只有确实有结束的 Ticket 才归已完成（审查 CRIT-19）。
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

  if (!task.assigned || task.abandoned) {
    return { lane: 'todo', substate: 'unassigned' }
  }

  if (!submitted) {
    return { lane: 'working', substate: 'not-scanning', note: '已记录，等待执行器扫描' }
  }

  return { lane: 'working', substate: 'submitted', note: '已投递，等待接受' }
}

/** 四个列的固定顺序与标题（UI 与测试共用同一份定义）。 */
export const LANES: ReadonlyArray<{ key: PanelLane; label: string; hint: string }> = [
  { key: 'todo', label: '待办', hint: '未指派' },
  { key: 'working', label: '执行中', hint: '执行器在跑' },
  { key: 'attention', label: '需要我', hint: '等你决定' },
  { key: 'done', label: '已完成', hint: '最近 24 小时' },
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
  stopped: '已停止',
  unknown: '未知',
}
