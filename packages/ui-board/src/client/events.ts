/**
 * Client-side ExecutionEvent shapes + parser for the durable run timeline.
 *
 * These mirror the `@helmsman/orchestrator` timeline types as plain JSON over
 * the SSE channel. The client deliberately re-declares them (no import from the
 * orchestrator package) so the SPA bundle stays self-contained and the wire
 * format is pinned here for both ends to evolve against — the same rationale as
 * `ui-dashboard/src/client/event.ts`, whose copy this is (design D6).
 *
 * Consumers MUST tolerate unknown `kind` values (future additive kinds).
 */

export type ClientTaskStatus = 'CREATING_WORKTREES' | 'RUNNING' | 'AGGREGATING' | 'COMPLETED' | 'PARTIAL_FAILED' | 'ALL_FAILED' | 'CANCELLED'
export type ClientAgentRunState = 'idle' | 'running' | 'completed' | 'failed' | 'timeout' | 'rate-limited' | 'auth-failed' | 'cancelled'

export const TERMINAL_TASK_STATES: ReadonlySet<string> = new Set(['COMPLETED', 'PARTIAL_FAILED', 'ALL_FAILED', 'CANCELLED'])

export interface ClientAgentRunStateSummary {
  agent: string
  state: ClientAgentRunState
  attempts: number
  startedAt?: number
  endedAt?: number
  exitCode?: number | null
  error?: string
  stats?: { files: number; additions: number; deletions: number }
  conflictingFiles?: string[]
  hasDiff: boolean
}

export interface ClientTaskStatePayload {
  id: string
  prompt: string
  status: ClientTaskStatus
  projectGroupId?: string
  cascade: boolean
  timeoutSec: number
  createdAt: number
  endedAt?: number
  interrupted?: boolean
  agents: Record<string, ClientAgentRunStateSummary>
}

export interface ClientMergeDecisionPayload {
  agents: string[]
  files?: string[]
  resolutions: Record<string, { kind: 'agent'; agent: string } | { kind: 'manual' } | { kind: 'skip' }>
  conflictFiles: string[]
  discardAfterMerge: boolean
  outcome: 'merged' | 'aborted'
  results: Array<{ agent: string; ok: boolean; committed: boolean; message: string; conflictFiles: string[] }>
}

export type ClientExecutionEvent =
  | { v: 1; seq: number; ts: number; taskId: string; kind: 'task-state'; payload: ClientTaskStatePayload }
  | { v: 1; seq: number; ts: number; taskId: string; agent: string; kind: 'agent-log'; payload: { text: string } }
  | { v: 1; seq: number; ts: number; taskId: string; agent: string; kind: 'agent-attempt'; payload: { attempt: number } }
  | { v: 1; seq: number; ts: number; taskId: string; agent: string; kind: 'run-start'; payload: { attempt: number } }
  | { v: 1; seq: number; ts: number; taskId: string; agent: string; kind: 'run-end'; payload: { attempt: number; state: ClientAgentRunState; exitCode?: number | null; timedOut: boolean; error?: string } }
  | { v: 1; seq: number; ts: number; taskId: string; kind: 'merge-decision'; payload: ClientMergeDecisionPayload }

export type RunStreamStatus = 'connecting' | 'open' | 'reconnecting' | 'closed'

export function isTerminalTaskState(status: string): boolean {
  return TERMINAL_TASK_STATES.has(status)
}

export function isTerminalEvent(event: ClientExecutionEvent): boolean {
  return event.kind === 'task-state' && isTerminalTaskState(event.payload.status)
}

/** Parse one `data:` line of the run SSE stream; invalid lines are ignored. */
export function parseExecutionEvent(json: string): ClientExecutionEvent | null {
  try {
    const raw = JSON.parse(json) as Partial<ClientExecutionEvent> & { v?: number }
    if (raw.v !== 1 || typeof raw.seq !== 'number' || typeof raw.taskId !== 'string') return null
    if (typeof raw.kind !== 'string' || !raw.payload || typeof raw.ts !== 'number') return null
    return raw as ClientExecutionEvent
  } catch {
    return null
  }
}
