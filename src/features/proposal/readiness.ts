/**
 * Proposal readiness (change `multiproject-branch-workbench`, task 8.1).
 *
 * One explainable assessment for the panel/API: are the artifacts complete, is
 * the current planHash approved, and are targets declared? `ready` is true only
 * when no check failed — warnings stay visible.
 *
 * Change `remove-team-executor`：这里不再看团队 Run。执行状态由 Ticket 投影提供，
 * 与"提案是否可以进入下一态"是两件事——把执行进度混进 readiness 会让每个提案在
 * Super-agent 离线时都显示红色。
 */
import { computePlanFingerprint } from './plan.ts'
import type { Proposal } from './store.ts'

export type ReadinessStatus = 'ok' | 'warn' | 'fail'

export interface ReadinessCheck {
  id: 'artifacts' | 'plan-approval' | 'targets' | 'lifecycle'
  status: ReadinessStatus
  detail: string
}

export interface ProposalReadiness {
  ready: boolean
  checks: ReadinessCheck[]
}

export interface ReadinessInput {
  projectRoot?: string
  openspecRoot: string
}

export async function assessReadiness(proposal: Proposal, input: ReadinessInput): Promise<ProposalReadiness> {
  const checks: ReadinessCheck[] = []

  if (input.projectRoot === undefined) {
    checks.push({ id: 'artifacts', status: 'warn', detail: '未关联项目根，无法读取工件' })
  } else {
    const fingerprint = await computePlanFingerprint(input.projectRoot, input.openspecRoot, proposal.openspecChangeId, proposal.targets)
    checks.push(
      fingerprint.hash === undefined
        ? { id: 'artifacts', status: 'fail', detail: `工件不完整：缺 ${fingerprint.missing.join(', ')}` }
        : { id: 'artifacts', status: 'ok', detail: `planHash ${fingerprint.hash.slice(0, 12)}…（${fingerprint.files.length} 个文件）` },
    )
    const approvals = (proposal.approvals ?? []).filter((approval) => approval.gate === 'ready')
    const latest = approvals[approvals.length - 1]
    const approved =
      fingerprint.hash !== undefined && latest?.decision === 'approve' && latest.planHash === fingerprint.hash
    checks.push(
      approved
        ? { id: 'plan-approval', status: 'ok', detail: '当前 planHash 已获 G2 批准' }
        : {
            id: 'plan-approval',
            status: proposal.status === 'draft' || proposal.status === 'proposing' || proposal.status === 'reviewing' ? 'warn' : 'fail',
            detail: latest?.decision === 'reject' ? '最近一次 G2 决定是拒绝' : '当前 planHash 未获 G2 批准',
          },
    )
  }

  const targets = proposal.targets ?? []
  checks.push(
    targets.length > 0
      ? {
          id: 'targets',
          status: targets.every((target) => target.baseBranch.trim() !== '') ? 'ok' : 'fail',
          detail:
            targets.length === 1
              ? `${targets[0]?.project} @ ${targets[0]?.baseBranch}`
              : `${targets.length} 个目标：${targets.map((target) => `${target.project}@${target.baseBranch}`).join(', ')}`,
        }
      : { id: 'targets', status: 'warn', detail: '未声明 targets（旧提案按标量项目兼容）' },
  )

  checks.push({
    id: 'lifecycle',
    status:
      proposal.status === 'merging' || proposal.status === 'archiving' || proposal.status === 'archived'
        ? 'ok'
        : proposal.status === 'implementing'
          ? 'warn'
          : 'warn',
    detail: `当前状态 ${proposal.status}`,
  })

  return { ready: checks.every((check) => check.status !== 'fail'), checks }
}
