/** Diff client API layer + unified-diff parsing (zero deps). */

export interface FileDiff {
  path: string
  status: 'added' | 'deleted' | 'renamed' | 'modified' | 'binary'
  additions: number
  deletions: number
  diff: string
}

export interface AgentDiffPayload {
  state: string
  error: string | null
  stats: { files: number; additions: number; deletions: number } | null
  conflictingFiles: string[]
  diffs: FileDiff[]
}

export interface DiffTaskPayload {
  id: string
  prompt: string
  status: string
  createdAt: number
  agents: Record<string, AgentDiffPayload>
}

export interface MergeResult {
  taskId: string
  results: Array<{ agent: string; ok: boolean; committed: boolean; message: string; conflictFiles: string[] }>
}

export type ClientResolution =
  | { kind: 'agent'; agent: string }
  | { kind: 'manual' }
  | { kind: 'skip' }

const BASE = '/helmsman-diff/api'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: { 'content-type': 'application/json' }, ...init })
  const data = (await res.json()) as T & { error?: string }
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data
}

export const api = {
  listTasks: () => request<{ tasks: Array<{ id: string; prompt: string; status: string; createdAt: number; agents: Record<string, { state: string; stats: { files: number; additions: number; deletions: number } | null }> }> }>('/tasks'),
  getTask: (id: string) => request<{ found: boolean; task?: DiffTaskPayload }>(`/task/${encodeURIComponent(id)}`),
  getConflicts: (id: string) => request<{ taskId: string; conflictFiles: string[] }>(`/task/${encodeURIComponent(id)}/conflicts`),
  merge: (id: string, body: { agents?: string[]; files?: string[]; discardAfterMerge?: boolean; confirmationToken?: string; resolutions?: Record<string, ClientResolution> }) =>
    request<MergeResult>(`/task/${encodeURIComponent(id)}/merge`, { method: 'POST', body: JSON.stringify(body) }),
  discard: (id: string, confirmationToken?: string) =>
    request<{ ok: boolean }>(`/task/${encodeURIComponent(id)}/discard`, { method: 'POST', body: JSON.stringify({ confirmationToken }) }),
  // ---- approval gate (mirror of the dashboard REST surface) --------------
  approvalPolicy: (op: string) =>
    request<{ op: string; mode: 'confirm-required' | 'auto-grant'; confirmRequired: boolean }>(`/approvals/policy?op=${encodeURIComponent(op)}`),
  requestApproval: (body: { op: string; taskId?: string; group?: string }) =>
    request<{ approvalId: string; op: string; scope: string; source: string; requestedAt: number; expiresAt: number }>('/approvals', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  decideApproval: (approvalId: string, approve: boolean) =>
    request<{ granted: true; token: string; expiresAt: number } | { granted: false; reason: 'denied' | 'not-found' }>(
      `/approvals/${encodeURIComponent(approvalId)}/decision`,
      { method: 'POST', body: JSON.stringify({ approve }) },
    ),
}

/** Two-phase gate helper shared by merge/discard in the diff SPA. */
export async function runGatedAction(
  op: string,
  scope: { taskId?: string; group?: string },
  message: string,
  run: (token: string | undefined) => Promise<unknown>,
): Promise<boolean> {
  let confirmRequired = true
  try {
    confirmRequired = (await api.approvalPolicy(op)).confirmRequired
  } catch {
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

// ---------------------------------------------------------------------------
// unified diff parsing
// ---------------------------------------------------------------------------

export interface DiffLine {
  kind: 'context' | 'add' | 'del' | 'meta' | 'hunk'
  oldNo: number | null
  newNo: number | null
  text: string
}

export function parseHunks(diffText: string): DiffLine[] {
  const lines: DiffLine[] = []
  let oldNo = 0
  let newNo = 0
  for (const raw of diffText.split('\n')) {
    if (raw.startsWith('diff --git') || raw.startsWith('index ') || raw.startsWith('--- ') || raw.startsWith('+++ ')) {
      lines.push({ kind: 'meta', oldNo: null, newNo: null, text: raw })
      continue
    }
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      oldNo = Number(hunk[1])
      newNo = Number(hunk[2])
      lines.push({ kind: 'hunk', oldNo: null, newNo: null, text: raw })
      continue
    }
    if (raw.startsWith('+')) {
      lines.push({ kind: 'add', oldNo: null, newNo, text: raw.slice(1) })
      newNo += 1
    } else if (raw.startsWith('-')) {
      lines.push({ kind: 'del', oldNo, newNo: null, text: raw.slice(1) })
      oldNo += 1
    } else if (raw.startsWith('\\')) {
      lines.push({ kind: 'meta', oldNo: null, newNo: null, text: raw })
    } else if (raw.startsWith(' ')) {
      lines.push({ kind: 'context', oldNo, newNo, text: raw.slice(1) })
      oldNo += 1
      newNo += 1
    } else if (raw !== '') {
      // extended headers without a leading space (e.g. "new file mode", "rename from …")
      lines.push({ kind: 'meta', oldNo: null, newNo: null, text: raw })
    }
  }
  return lines
}

export const AGENT_LABELS: Record<string, string> = { claude: 'Claude', codex: 'Codex', pi: 'Pi', 'oh-my-pi': 'oh-my-pi' }
