/**
 * Typed board errors so hosts and tests branch on `code` instead of message
 * text. Codes are stable API; messages are English and human-readable.
 */
import type { GateGap } from './model.ts'

export type BoardErrorCode =
  /** Caller passed something structurally invalid (empty title, bad stage, …). */
  | 'INVALID_INPUT'
  /** No WorkItem with that id. */
  | 'NOT_FOUND'
  /** Nothing to advance to: the card already sits in the final stage. */
  | 'STAGE_TERMINAL'
  /** Backward or same-stage transition. */
  | 'INVALID_TRANSITION'
  /** Forward jump over an intermediate stage while `allowSkip` is off. */
  | 'SKIP_NOT_ALLOWED'
  /** An association target could not be resolved by the wired ExistenceProbe. */
  | 'TARGET_NOT_FOUND'
  /** items.json is unparseable / structurally invalid — left untouched. */
  | 'STORE_CORRUPT'
  /** items.json was written by a newer schema than this build understands. */
  | 'SCHEMA_UNSUPPORTED'
  /** items.json exists but could not be read at all (permissions, IO). */
  | 'STORE_UNREADABLE'
  /** A write failed; existing files were not modified. */
  | 'STORE_WRITE_FAILED'
  /** The state change landed but its lifecycle event could not be appended. */
  | 'EVENT_WRITE_FAILED'

export class HelmsmanBoardError extends Error {
  readonly code: BoardErrorCode
  /** Structured extras (path, stage names, conflict domain, …). */
  readonly details: Record<string, unknown>
  /**
   * Displayable refusal list, when the refusal has one. Structural clients
   * (e.g. a REST layer) treat a thrown refusal carrying `gaps` exactly like a
   * returned one; `details.gaps` mirrors this field.
   */
  readonly gaps?: GateGap[]

  constructor(code: BoardErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'HelmsmanBoardError'
    this.code = code
    this.details = details
    if (Array.isArray(details.gaps)) this.gaps = details.gaps as GateGap[]
  }
}

/** Error message of an unknown throwable. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** True when `err` carries a matching errno `code` (ENOENT, EACCES, …). */
export function isErrno(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === code
}
