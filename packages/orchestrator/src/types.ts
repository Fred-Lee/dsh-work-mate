/** Orchestrator data model — task state machine (PRD §4.2), adapter contract,
 * conflict model. Shared by the engine, the UI host halves, and the tools. */

export type TaskState =
  | 'CREATING_WORKTREES'
  | 'RUNNING'
  | 'AGGREGATING'
  | 'COMPLETED'
  | 'PARTIAL_FAILED'
  | 'ALL_FAILED'
  | 'CANCELLED'

export type AgentRunState =
  | 'idle'
  | 'running'
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'rate-limited'
  | 'auth-failed'
  | 'cancelled'

export interface FileDiffSummary {
  path: string
  status: 'added' | 'deleted' | 'renamed' | 'modified' | 'binary'
  additions: number
  deletions: number
  diff: string
}

export interface AgentRun {
  agent: string
  state: AgentRunState
  worktreeId?: string
  attempts: number
  startedAt?: number
  endedAt?: number
  exitCode?: number | null
  /** Short human-readable failure reason (already classified). */
  error?: string
  /** Accumulated stdout+stderr of the latest attempt. */
  log: string
  stats?: { files: number; additions: number; deletions: number }
  diffs?: FileDiffSummary[]
  /** Files this agent changed that other agents also changed. */
  conflictingFiles?: string[]
}

export interface TaskRecord {
  id: string
  prompt: string
  projectGroupId?: string
  cascade: boolean
  timeoutSec: number
  status: TaskState
  createdAt: number
  endedAt?: number
  repoPath?: string
  /**
   * True only for records restored from durable history after a host restart
   * while the task had not reached a terminal state — i.e. an interrupted run
   * shown at its last-known state. Cleared as soon as the task runs again.
   */
  interrupted?: boolean
  agents: Record<string, AgentRun>
}

export interface AgentExecuteRequest {
  prompt: string
  worktreePath: string
  timeoutSec: number
  signal: AbortSignal
  onOutput: (chunk: string) => void
}

export interface AgentExecuteResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface AgentInstallStatus {
  installed: boolean
  version?: string
}

export interface AgentAdapter {
  name: string
  checkInstalled(): Promise<AgentInstallStatus>
  execute(req: AgentExecuteRequest): Promise<AgentExecuteResult>
}

export interface RunParallelParams {
  prompt: string
  agents: string[]
  projectGroupId?: string
  /** Direct override when no topology group is configured. */
  repoPath?: string
  cascade?: boolean
  timeoutSec?: number
}

/**
 * Per-file human adjudication for a real (apply-failed) conflict file, carried
 * by a merge request (spec merge-conflict-resolution): adopt one agent's plan,
 * keep a manual edit (base content already resolved by the operator), or skip
 * the file (leave it unmerged).
 */
export type MergeResolution =
  | { kind: 'agent'; agent: string }
  | { kind: 'manual' }
  | { kind: 'skip' }

export interface MergeTaskParams {
  taskId: string
  /** Agents to merge from; omit for "all completed agents". */
  agents?: string[]
  /** Repo-relative file paths to restrict the merge to. */
  files?: string[]
  discardAfterMerge?: boolean
  /**
   * Code-level confirmation token issued by the confirmation gate (design D1).
   * Required when the merge operation is policy-`confirm-required`.
   */
  confirmationToken?: string
  /**
   * User's per-file adjudication for real conflict files
   * `Record<file, MergeResolution>`. Persisted to the run timeline
   * (`merge-decision` event) and the audit journal.
   */
  resolutions?: Record<string, MergeResolution>
  /** Attribution source for the audit trail. @default 'ui' */
  source?: 'ui' | 'tool'
}

export interface MergeTaskResult {
  taskId: string
  results: Array<{ agent: string; ok: boolean; committed: boolean; message: string; conflictFiles: string[] }>
}

export interface UsageEntry {
  runs: number
  promptChars: number
  outputChars: number
  /** Estimated tokens (chars/4) — display only, not billing-grade. */
  estimatedTokens: number
}

/** Shape of @helmsman/worktree used by the engine (structural, no import). */
export interface WorktreeLike {
  createWorktree(params: { taskId: string; agent: string; repoPath: string }): Promise<{ id: string; path: string; branch: string; baseSha: string }>
  removeWorktree(id: string): Promise<void>
  listWorktrees(taskId?: string): Promise<Array<{ id: string; agent: string; taskId: string; path: string }>>
  getDiff(id: string): Promise<{ worktreeId: string; files: FileDiffSummary[]; additions: number; deletions: number }>
  mergeWorktree(selection: { worktreeId: string; files?: string[]; commitMessage?: string }): Promise<{ ok: boolean; committed: boolean; message: string; conflictFiles: string[] }>
  removeTaskWorktrees(taskId: string): Promise<void>
  /**
   * Atomic dry-run (spec merge-conflict-resolution): checks whether the
   * concatenated patches of the selected worktree files apply cleanly onto the
   * base repo WITHOUT modifying it. `ok: false` reports the real conflict
   * files.
   *
   * REQUIRED: the engine refuses to merge (or preview conflicts) without this
   * seam — silently applying per-agent patches without a combined dry-run is a
   * non-atomic degrade. The worktree plugin always provides it; integrators
   * with a custom host must implement it (unit-test fakes carry a stub).
   */
  mergeDryRun(selection: { worktrees: Array<{ worktreeId: string; files?: string[] }> }): Promise<{ ok: boolean; conflictFiles: string[] }>
}

/** Shape of @helmsman/memory-topology used by the engine (optional). */
export interface TopologyLike {
  loadTopology(group: string): Promise<{
    services: Record<string, { name: string; localPath?: string }>
    restDependencies: Record<string, Array<{ toServiceId: string; endpoints: string[]; method: string }>>
  } | null>
  getDownstream(group: string, serviceId: string): Promise<{
    direct: Array<{ toServiceId: string; endpoints: string[]; method: string }>
    calledBy: Array<{ fromServiceId: string }>
    transitive: string[]
    cyclic: boolean
  }>
}

/** Failure classification from raw adapter results (single source of truth). */
export function classifyFailure(result: { exitCode: number | null; stdout?: string; stderr: string; timedOut: boolean }): { state: AgentRunState; error: string } {
  if (result.timedOut) return { state: 'timeout', error: `执行超时` }
  const err = (result.stderr || '').toLowerCase()
  if (/429|rate.?limit|too many requests|quota exceeded/.test(err)) return { state: 'rate-limited', error: '触发限流 (429)' }
  if (/unauthorized|401|invalid api key|api key invalid|authentication|login required|not logged in/.test(err)) {
    return { state: 'auth-failed', error: '认证失效或未配置密钥' }
  }
  const snippet = (result.stderr || result.stdout || `exit code ${result.exitCode}`).trim().split('\n').slice(-3).join(' | ').slice(0, 200)
  return { state: 'failed', error: snippet || `exit code ${result.exitCode}` }
}

export function taskSummary(status: TaskState): string {
  switch (status) {
    case 'CREATING_WORKTREES': return '准备环境'
    case 'RUNNING': return '执行中'
    case 'AGGREGATING': return '正在对比结果'
    case 'COMPLETED': return '全部完成'
    case 'PARTIAL_FAILED': return '部分失败'
    case 'ALL_FAILED': return '全部失败'
    case 'CANCELLED': return '已取消'
  }
}
