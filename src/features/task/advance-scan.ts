/**
 * 实现完成后的自动推进扫描（change `auto-advance-implemented-to-merging`）。
 *
 * **为什么单独成模块**：上一次尝试把这个逻辑放进 `TaskService.board()`，宿主主线程
 * 100% 卡在 `v8::MicrotaskQueue::RunMicrotasks`，HTTP 完全无响应（2026-11-09 事故）。
 * 根因是 `board()` 被面板 5 秒轮询、且被 `/api/worktrees/leftover` 并发调用；
 * 在读路径里发起 `transition` 会与写锁链互相触发。
 *
 * 所以这里只做三件事，且**绝不从任何读路径调用**：
 *   1. 纯判据（无 IO，可单测）；
 *   2. 扫描（单飞由调用方保证：上一轮未结束就跳过）；
 *   3. 逐个推进，失败隔离。
 */
import type { PanelLane, TicketView } from '../superagent/project.ts'
import type { TaskRecord } from './files.ts'

/** 扫描需要的最小提案视图（避免依赖 ProposalStore 的形状）。 */
export interface ScanProposal {
  id: string
  status: string
  autoAdvancedAt?: string
}

/** 扫描需要的最小任务卡视图。 */
export interface ScanCard {
  task: TaskRecord
  lane: PanelLane
  ticket?: TicketView
}

/** 判为"实现完成"的 Ticket 终态。`closed`（关闭未合并）与 `stopped` 不算。 */
const DONE_OUTCOMES = new Set(['completed', 'merged', 'dropped'])

/**
 * 某提案的待办是否都已完成实现。
 *
 * @param cards 任务卡（与 `board()` 的 cards 同形）
 * @param proposalId 提案 id
 * @returns 至少一条待办、全部在 done 列、且终态都是 completed/merged/dropped
 */
export function implementationComplete(cards: ReadonlyArray<ScanCard>, proposalId: string): boolean {
  const mine = cards.filter((card) => card.task.proposalId === proposalId)
  // 没有待办不算完成：空提案不该被自动放行（design D4）。
  if (mine.length === 0) return false
  return mine.every((card) => {
    if (card.lane !== 'done') return false
    const outcome = card.ticket?.ended?.outcome
    return outcome !== undefined && DONE_OUTCOMES.has(outcome)
  })
}

/** 从任务卡里找出所有"实现完成"的提案 id。 */
export function completedProposals(cards: ReadonlyArray<ScanCard>): string[] {
  const ids = new Set<string>()
  for (const card of cards) {
    const id = card.task.proposalId
    if (id !== undefined && id !== '') ids.add(id)
  }
  return [...ids].filter((id) => implementationComplete(cards, id))
}

/** 一轮扫描的结果，供事件流与面板记录。 */
export interface AdvanceScanOutcome {
  /** 本轮实际被推进的提案 id。 */
  advanced: string[]
  /** 尝试过但受阻的提案与原因。 */
  blocked: Array<{ id: string; reason: string }>
  /** 命中"实现完成"但因已有标记/状态不符而跳过。 */
  skipped: string[]
}

export interface AdvanceScanDeps {
  /** 读任务卡（只读；由调用方传进来的 `board()` 结果或等价视图）。 */
  cards: () => Promise<ReadonlyArray<ScanCard>>
  /** 读提案（只需要 id/status/autoAdvancedAt）。 */
  proposals: () => Promise<ReadonlyArray<ScanProposal>>
  /** 推进一个提案到 merging；抛错即视为受阻。 */
  advance: (proposalId: string) => Promise<void>
  /** 写"已自动推进"标记；与 advance 成功后调用。 */
  markAdvanced: (proposalId: string, at: string) => Promise<void>
  now?: () => Date
}

/**
 * 跑一轮扫描。**调用方负责单飞**（上一轮未结束不要调进来）。
 *
 * 推进顺序：只看 `implementing` 且无 `autoAdvancedAt` 的提案；
 * 单个失败不阻断其余（design D5）。
 */
export async function runAdvanceScan(deps: AdvanceScanDeps): Promise<AdvanceScanOutcome> {
  const outcome: AdvanceScanOutcome = { advanced: [], blocked: [], skipped: [] }
  const [cards, proposals] = await Promise.all([deps.cards(), deps.proposals()])
  const eligible = new Set(completedProposals(cards))
  const at = (deps.now?.() ?? new Date()).toISOString()

  for (const proposal of proposals) {
    if (!eligible.has(proposal.id)) continue
    // 已自动推进过：即使又回到 implementing（人回退），也不再自动推进，
    // 避免与人手动操作打架（design D3）。
    if (proposal.autoAdvancedAt !== undefined && proposal.autoAdvancedAt !== '') {
      outcome.skipped.push(proposal.id)
      continue
    }
    if (proposal.status !== 'implementing') {
      outcome.skipped.push(proposal.id)
      continue
    }
    try {
      await deps.advance(proposal.id)
      await deps.markAdvanced(proposal.id, at)
      outcome.advanced.push(proposal.id)
    } catch (error) {
      // 不写标记：下一轮会重试（design D5）。
      outcome.blocked.push({
        id: proposal.id,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return outcome
}

/**
 * 单飞包装：`run` 正在执行时再次调用直接返回 `undefined`。
 *
 * 这是事故的结构性防线——上一次的死锁源于"越积越多"的并发扫描。
 */
export function singleFlight(run: () => Promise<AdvanceScanOutcome>): () => Promise<AdvanceScanOutcome | undefined> {
  let running = false
  return async () => {
    if (running) return undefined
    running = true
    try {
      return await run()
    } finally {
      running = false
    }
  }
}
