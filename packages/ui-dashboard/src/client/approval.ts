/**
 * Two-phase approval flow helper for the dashboard SPA (design D1/D4).
 *
 * A destructive UI action runs through `runGatedAction`: when the policy marks
 * the operation `confirm-required` the helper (1) records a pending approval
 * request, (2) shows the operator a native confirm dialog, (3) decides the
 * request (approve mints a one-time scope-bound token, deny closes it), and
 * (4) executes with the token. When the operator relaxed the operation to
 * `auto-grant` the action runs directly with no prompt and no token.
 *
 * Returns `true` when the action was executed and `false` when the operator
 * declined the confirmation dialog.
 */
import { api, type AuditEntryPayload } from './api'

export interface GatedScope {
  taskId?: string
  group?: string
}

export async function runGatedAction(
  op: string,
  scope: GatedScope,
  message: string,
  run: (token: string | undefined) => Promise<unknown>,
): Promise<boolean> {
  let confirmRequired = true
  try {
    const policy = await api.approvalPolicy(op)
    confirmRequired = policy.confirmRequired
  } catch {
    // Unknown/unreachable policy endpoint → fail safe: require confirmation.
    confirmRequired = true
  }
  if (!confirmRequired) {
    await run(undefined)
    return true
  }
  const approval = await api.requestApproval({ op, ...scope })
  const confirmed = window.confirm(message)
  const decision = await api.decideApproval(approval.approvalId, confirmed)
  if (!confirmed) return false
  if (!decision.granted) {
    if (decision.reason === 'not-found') throw new Error('确认请求已过期或不存在，请重试')
    throw new Error('该确认已被拒绝')
  }
  await run(decision.token)
  return true
}

export type { AuditEntryPayload }
