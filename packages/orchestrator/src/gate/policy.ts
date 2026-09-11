/**
 * Confirmation policy — drives which destructive fleet operations require an
 * explicit confirmation token before the engine will execute them.
 *
 * Policy lives in a small JSON file at `~/.helmsman/policy.json`
 * (override the base directory with HELMSMAN_HOME):
 *
 *   {
 *     "operations": {
 *       "merge": "confirm-required",
 *       "discard": "confirm-required",
 *       "cancel": "auto-grant",
 *       "worktree-cleanup": "confirm-required",
 *       "topology-delete": "confirm-required"
 *     },
 *     "tokenTtlSec": 300
 *   }
 *
 * A missing file yields the defaults above (design D2): merge/discard/
 * worktree-cleanup/topology-delete stay confirm-required — which preserves the
 * pre-policy "ask before a destructive change" UI behaviour — while cancel
 * (reversible, frequent during development) is auto-granted but still
 * journaled. Read-only operations never consult the policy.
 *
 * The engine is framework-free and injectable: the plugin entry constructs a
 * `FilePolicy` for real hosts, while engine unit tests use `allowAllPolicy` so
 * pre-existing behaviour (no token required) is preserved.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type PolicyMode = 'confirm-required' | 'auto-grant'

export type GateOp =
  | 'merge'
  | 'discard'
  | 'cancel'
  | 'worktree-cleanup'
  | 'topology-delete'

export const GATE_OPS: readonly GateOp[] = ['merge', 'discard', 'cancel', 'worktree-cleanup', 'topology-delete']

/** On-disk shape. `tokenTtlSec` optional for forward-compatible files. */
export interface PolicyFile {
  operations: Record<GateOp, PolicyMode>
  tokenTtlSec?: number
}

/** Default mode per operation (design D2) — used when the file is absent. */
export const DEFAULT_POLICY_MODES: Record<GateOp, PolicyMode> = {
  merge: 'confirm-required',
  discard: 'confirm-required',
  cancel: 'auto-grant',
  'worktree-cleanup': 'confirm-required',
  'topology-delete': 'confirm-required',
}

export const DEFAULT_TOKEN_TTL_SEC = 300

/** Default full policy object (immutable). */
export const DEFAULT_POLICY: Readonly<PolicyFile> = Object.freeze({
  operations: Object.freeze({ ...DEFAULT_POLICY_MODES }),
  tokenTtlSec: DEFAULT_TOKEN_TTL_SEC,
})

/** Interface the gate/engine consult — injectable so tests never read disk. */
export interface ConfirmationPolicy {
  modeFor(op: GateOp): PolicyMode
  /** Token time-to-live in milliseconds. */
  tokenTtlMs(): number
}

/** HELMSMAN_HOME-aware default policy file path. */
export function defaultPolicyPath(): string {
  const base = process.env.HELMSMAN_HOME ?? join(homedir(), '.helmsman')
  return join(base, 'policy.json')
}

function assertMode(value: unknown): PolicyMode {
  if (value === 'confirm-required' || value === 'auto-grant') return value
  throw new Error(`invalid policy mode ${JSON.stringify(value)} (expected "confirm-required" | "auto-grant")`)
}

/**
 * Parses + validates the raw policy object. Unknown top-level keys and unknown
 * operation keys are rejected so a typo can never silently relax the gate
 * (fail-closed by construction).
 */
export function normalizePolicyFile(raw: unknown): PolicyFile {
  if (typeof raw !== 'object' || raw === null) throw new Error('policy.json must contain a JSON object')
  const file = raw as Record<string, unknown>
  const operationsRaw = file['operations']
  if (typeof operationsRaw !== 'object' || operationsRaw === null) {
    throw new Error('policy.json is missing the "operations" object')
  }
  for (const key of Object.keys(operationsRaw)) {
    if (!(GATE_OPS as readonly string[]).includes(key)) {
      throw new Error(`policy.json: unknown operation ${JSON.stringify(key)}`)
    }
  }
  const operations = {} as Record<GateOp, PolicyMode>
  for (const op of GATE_OPS) {
    const value = (operationsRaw as Record<string, unknown>)[op]
    operations[op] = value === undefined ? DEFAULT_POLICY_MODES[op] : assertMode(value)
  }
  const tokenTtlSec = file['tokenTtlSec'] === undefined ? DEFAULT_TOKEN_TTL_SEC : file['tokenTtlSec']
  if (typeof tokenTtlSec !== 'number' || !Number.isInteger(tokenTtlSec) || tokenTtlSec <= 0) {
    throw new Error('policy.json: tokenTtlSec must be a positive integer (seconds)')
  }
  for (const key of Object.keys(file)) {
    if (key !== 'operations' && key !== 'tokenTtlSec') {
      throw new Error(`policy.json: unknown key ${JSON.stringify(key)}`)
    }
  }
  return { operations, tokenTtlSec }
}

/** Loads the policy file from disk; a missing/corrupt file falls back to defaults. */
export function loadPolicyFileSync(path = defaultPolicyPath()): FilePolicy {
  if (!existsSync(path)) return new FilePolicy(DEFAULT_POLICY)
  try {
    return new FilePolicy(normalizePolicyFile(JSON.parse(readFileSync(path, 'utf8'))))
  } catch (err) {
    // Invalid JSON or schema: never silently widen the gate — fall back to the
    // strictest sensible posture for unreadable policy (defaults are strict).
    console.error(`[helmsman/gate] policy load failed (${path}), using defaults: ${err instanceof Error ? err.message : String(err)}`)
    return new FilePolicy(DEFAULT_POLICY)
  }
}

/** Runtime wrapper around a parsed policy file. */
export class FilePolicy implements ConfirmationPolicy {
  private readonly file: PolicyFile
  constructor(file: PolicyFile) {
    this.file = file
  }
  modeFor(op: GateOp): PolicyMode {
    return this.file.operations[op]
  }
  tokenTtlMs(): number {
    return (this.file.tokenTtlSec ?? DEFAULT_TOKEN_TTL_SEC) * 1000
  }
}

/** Test seam: every operation auto-grants (engine unit tests keep old shape). */
export const allowAllPolicy: ConfirmationPolicy = Object.freeze({
  modeFor: () => 'auto-grant' as const,
  tokenTtlMs: () => DEFAULT_TOKEN_TTL_SEC * 1000,
})

/** Test seam: every operation is confirm-required. */
export const confirmAllPolicy: ConfirmationPolicy = Object.freeze({
  modeFor: () => 'confirm-required' as const,
  tokenTtlMs: () => DEFAULT_TOKEN_TTL_SEC * 1000,
})
