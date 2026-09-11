/**
 * ConfirmationGate — code-level two-phase gate for destructive fleet
 * operations (design D1). A sensitive operation may only execute when it is
 * called with a confirmation token that was explicitly issued for that
 * operation + canonical scope key by a human (or headless caller) decision.
 *
 * Flow: `request(op, scope)` → `decide(approvalId, approve)` → the engine calls
 * `consume(op, scope, token)` immediately before the protected side effect.
 *
 * The gate is intentionally NOT the policy: it never decides whether an
 * operation needs confirmation — the engine consults `ConfirmationPolicy` and
 * only invokes `consume` for operations that are `confirm-required`. This keeps
 * every injectable piece small and unit-testable.
 *
 * Tokens are single-use (consumed or TTL-expired), bound to their canonical
 * scope key (replay/scope-swap are refused), and carry the source of the
 * original request so audit records can attribute the decision to 'ui'|'tool'.
 */
import { randomBytes } from 'node:crypto'
import type { ConfirmationPolicy } from './policy.ts'
import type { GateOp } from './policy.ts'

export type AuditSource = 'ui' | 'tool'

export interface PendingApproval {
  approvalId: string
  op: GateOp
  /** Canonical scope key the token will be bound to (see core `scopeKey`). */
  scope: string
  source: AuditSource
  /** Task id the request is scoped to (present on task-scoped requests). */
  taskId?: string
  requestedAt: number
  expiresAt: number
}

export interface TokenInfo {
  token: string
  op: GateOp
  scope: string
  source: AuditSource
  taskId?: string
  issuedAt: number
  expiresAt: number
}

/**
 * Outcome of a phase-2 decision. When a pending request was found and settled,
 * the resolved approval metadata (op/scope/source/taskId) is carried back so
 * callers can journal the decision without a second lookup. `not-found` means
 * no pending request existed for the id (expired or already settled).
 */
export type DecideResult =
  | { granted: true; token: string; expiresAt: number; approvalId: string; op: GateOp; scope: string; source: AuditSource; taskId?: string }
  | { granted: false; reason: 'denied'; approvalId: string; op: GateOp; scope: string; source: AuditSource; taskId?: string }
  | { granted: false; reason: 'not-found' }

/** Failure used when the gate refuses an execution attempt. */
export class GateDeniedError extends Error {
  readonly code = 'gate-denied'
  constructor(
    readonly op: GateOp,
    readonly scope: string,
    readonly reason: 'missing-token' | 'unknown-token' | 'expired' | 'scope-mismatch' | 'consumed',
  ) {
    super(`gate-denied: ${op} requires confirmation for scope ${scope} (${reason})`)
    this.name = 'GateDeniedError'
  }
}

export interface ConfirmationGateOptions {
  policy: ConfirmationPolicy
  now?: () => number
}

function approvalId(): string {
  return `ap-${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`
}

function tokenHex(): string {
  return randomBytes(16).toString('hex')
}

export class ConfirmationGate {
  private readonly policy: ConfirmationPolicy
  private readonly now: () => number
  private readonly pending = new Map<string, PendingApproval>()
  private readonly issued = new Map<string, TokenInfo>()

  constructor(opts: ConfirmationGateOptions) {
    this.policy = opts.policy
    this.now = opts.now ?? (() => Date.now())
  }

  /** Removes approvals/tokens whose TTL elapsed (cheap, called on each entry). */
  private pruneExpired(): void {
    const now = this.now()
    for (const [id, approval] of this.pending) {
      if (approval.expiresAt <= now) this.pending.delete(id)
    }
    for (const [token, info] of this.issued) {
      if (info.expiresAt <= now) this.issued.delete(token)
    }
  }

  /**
   * Records a pending confirmation request bound to a canonical scope key.
   * Returns the pending approval (callers surface `approvalId` to the user).
   */
  request(op: GateOp, scope: string, source: AuditSource = 'ui', taskId?: string): PendingApproval {
    this.pruneExpired()
    const t = this.now()
    const approval: PendingApproval = {
      approvalId: approvalId(),
      op,
      scope,
      source,
      ...(taskId !== undefined ? { taskId } : {}),
      requestedAt: t,
      expiresAt: t + this.policy.tokenTtlMs(),
    }
    this.pending.set(approval.approvalId, approval)
    return approval
  }

  /**
   * Approve or deny a pending request. Approving mints a one-time, scoped,
   * TTL-bound confirmation token; denying closes the request. Unknown or
   * already-expired approval ids resolve to `{ granted: false, reason:
   * 'not-found' }`. Settled decisions carry the request's metadata back for
   * audit journaling.
   */
  decide(approvalIdRaw: string, approve: boolean): DecideResult {
    this.pruneExpired()
    const approval = this.pending.get(approvalIdRaw)
    if (!approval) return { granted: false, reason: 'not-found' }
    // Drop the pending request either way — a decision is final.
    this.pending.delete(approvalIdRaw)
    const meta = {
      approvalId: approval.approvalId,
      op: approval.op,
      scope: approval.scope,
      source: approval.source,
      ...(approval.taskId !== undefined ? { taskId: approval.taskId } : {}),
    }
    if (!approve) return { granted: false, reason: 'denied', ...meta }
    const t = this.now()
    const token: TokenInfo = {
      token: tokenHex(),
      op: approval.op,
      scope: approval.scope,
      source: approval.source,
      ...(approval.taskId !== undefined ? { taskId: approval.taskId } : {}),
      issuedAt: t,
      expiresAt: t + this.policy.tokenTtlMs(),
    }
    this.issued.set(token.token, token)
    return { granted: true, token: token.token, expiresAt: token.expiresAt, ...meta }
  }

  /**
   * Validates + consumes a confirmation token for `(op, scope)`. Any mismatch
   * (wrong op, wrong scope, expired, already used, absent) throws
   * `GateDeniedError` and no side effect runs. Returns the token metadata the
   * caller uses for audit attribution.
   */
  consume(op: GateOp, scope: string, token: string): TokenInfo {
    // Checked before pruning so an expired-but-present token reports `expired`
    // rather than the less helpful `unknown-token`.
    const direct = this.issued.get(token)
    if (direct && direct.expiresAt <= this.now()) {
      this.issued.delete(token)
      throw new GateDeniedError(op, scope, 'expired')
    }
    this.pruneExpired()
    const info = this.issued.get(token)
    if (!info) {
      throw new GateDeniedError(op, scope, 'unknown-token')
    }
    this.issued.delete(token) // single-use regardless of outcome below
    if (info.op !== op) throw new GateDeniedError(op, scope, 'scope-mismatch')
    if (info.scope !== scope) throw new GateDeniedError(op, scope, 'scope-mismatch')
    return info
  }

  /** Live pending requests (expired ones cleared), newest first. */
  listPending(): PendingApproval[] {
    this.pruneExpired()
    return [...this.pending.values()].sort((a, b) => b.requestedAt - a.requestedAt)
  }
}

export type { ConfirmationPolicy, GateOp }
