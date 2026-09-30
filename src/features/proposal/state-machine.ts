/**
 * The eight-state proposal lifecycle (change add-lifecycle-worktree-wiki):
 * draft → proposing → reviewing → ready → implementing → merging →
 * archiving → archived. Pure structure: adjacency, next-step, old-status
 * migration and transition validation. Preconditions that need the filesystem
 * or git live in the service layer — this module only knows the shape.
 */

export const PROPOSAL_STATES = [
  'draft',
  'proposing',
  'reviewing',
  'ready',
  'implementing',
  'merging',
  'archiving',
  'archived',
] as const

export type ProposalState = (typeof PROPOSAL_STATES)[number]

/** States that may be reached in ONE transition from the given state (both directions). */
const ADJACENT: Record<ProposalState, ProposalState[]> = {
  draft: ['proposing'],
  proposing: ['draft', 'reviewing'],
  reviewing: ['proposing', 'ready'],
  ready: ['reviewing', 'implementing'],
  implementing: ['ready', 'merging'],
  merging: ['implementing', 'archiving'],
  archiving: ['merging', 'archived'],
  archived: ['archiving'],
}

/** Human-facing meaning of each state, surfaced on the panel as "next action". */
export const STATE_HINTS: Record<ProposalState, string> = {
  draft: '生成 OpenSpec 提案文件（proposal.md）',
  proposing: '提交提案分支（含 [proposal:<id>] 标记的提交）',
  reviewing: '评审提案分支，完成后合并进 main',
  ready: '推进后将自动创建 worktree 并准备环境',
  implementing: '在 worktree 内执行 tasks（声明 wiki 的任务需登记 Wiki 引用）',
  merging: '合并实现分支进 main',
  archiving: '推进后运行归档编排（审查门 → openspec archive → gitnexus → 清理）',
  archived: '已归档（可回退 archiving 重新打开）',
}

const OLD_STATUS_MAP: Record<string, ProposalState> = {
  draft: 'draft',
  reviewing: 'reviewing',
  executing: 'implementing',
  archived: 'archived',
}

/** Map a pre-eight-state status onto the new chain; unknown values pass through. */
export function migrateStatus(status: string): ProposalState {
  const mapped = OLD_STATUS_MAP[status]
  if (mapped !== undefined) return mapped
  return (PROPOSAL_STATES as readonly string[]).includes(status) ? (status as ProposalState) : 'draft'
}

export function isProposalState(value: string): value is ProposalState {
  return (PROPOSAL_STATES as readonly string[]).includes(value)
}

export function nextState(status: ProposalState): ProposalState | undefined {
  const index = PROPOSAL_STATES.indexOf(status)
  return index >= 0 && index < PROPOSAL_STATES.length - 1 ? PROPOSAL_STATES[index + 1] : undefined
}

/** The single adjacent state behind `status` (the only free backward move). */
export function prevState(status: ProposalState): ProposalState | undefined {
  const index = PROPOSAL_STATES.indexOf(status)
  return index > 0 ? PROPOSAL_STATES[index - 1] : undefined
}

export interface TransitionCheck {
  ok: boolean
  /** Readable reason when not ok (non-adjacent, unknown state, …). */
  reason?: string
  direction: 'forward' | 'backward' | 'same'
}

/**
 * Adjacency-only validation (no side effects). Forward transitions still need
 * their preconditions checked by the service before persisting.
 */
export function checkTransition(from: ProposalState, to: ProposalState): TransitionCheck {
  if (!isProposalState(from) || !isProposalState(to)) {
    return { ok: false, reason: `unknown state: ${!isProposalState(from) ? from : to}`, direction: 'same' }
  }
  if (from === to) return { ok: false, reason: `already in ${to}`, direction: 'same' }
  if (!ADJACENT[from].includes(to)) {
    return {
      ok: false,
      reason: `cannot jump from ${from} to ${to} — adjacent states are: ${ADJACENT[from].join(', ')}`,
      direction: 'same',
    }
  }
  const direction = PROPOSAL_STATES.indexOf(to) > PROPOSAL_STATES.indexOf(from) ? 'forward' : 'backward'
  return { ok: true, direction }
}
