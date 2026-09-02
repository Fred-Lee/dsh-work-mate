/** Client-side API layer + shared types (mirror of server payloads). */

export type TaskStatus = 'CREATING_WORKTREES' | 'RUNNING' | 'AGGREGATING' | 'COMPLETED' | 'PARTIAL_FAILED' | 'ALL_FAILED' | 'CANCELLED'
export type AgentRunState = 'idle' | 'running' | 'completed' | 'failed' | 'timeout' | 'rate-limited' | 'auth-failed' | 'cancelled'

export interface AgentStatePayload {
  installed: boolean
  version?: string
}

export interface AgentRunPayload {
  state: AgentRunState
  attempts: number
  startedAt: string | number | null
  endedAt: string | number | null
  exitCode: number | null
  error: string | null
  stats: { files: number; additions: number; deletions: number } | null
  conflictingFiles: string[]
  hasDiff: boolean
}

export interface TaskPayload {
  id: string
  prompt: string
  status: TaskStatus
  projectGroupId: string | null
  cascade: boolean
  timeoutSec: number
  createdAt: number
  endedAt: number | null
  agents: Record<string, AgentRunPayload>
}

export interface UsagePayload {
  runs: number
  promptChars: number
  outputChars: number
  estimatedTokens: number
}

export interface StatePayload {
  serverTime: number
  groups: string[]
  agents: Record<string, AgentStatePayload>
  tasks: TaskPayload[]
  usage: Record<string, UsagePayload>
}

export interface ApiEndpointPayload {
  method: string
  path: string
  handler?: string
  description?: string
}

export interface TopologyPayload {
  projectGroupId: string
  name: string
  description: string
  defaultBranch: string
  projects: Record<string, { name: string; repoUrl: string; localPath: string; type: string }>
  services: Record<string, {
    name: string
    projectId: string
    techStack: string[]
    apiEndpoints: ApiEndpointPayload[]
    localPath?: string
  }>
  mavenParents: Record<string, { pomPath: string; managedDependencies: Record<string, string>; children: string[] }>
  restDependencies: Record<string, Array<{ toServiceId: string; endpoints: string[]; method: string; critical?: boolean }>>
}

export interface ImportPreviewPayload {
  source: string
  services: Array<{ name: string; image?: string; selected: boolean; endpoints: ApiEndpointPayload[] }>
  dependencies: Array<{ from: string; to: string; method: string; endpoints: string[] }>
  warnings: string[]
}

const BASE = '/helmsman-dashboard/api'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  })
  const ct = res.headers.get('content-type') ?? ''
  if (!ct.includes('application/json')) {
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.text()) as unknown as T
  }
  const data = (await res.json()) as T & { error?: string }
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data
}

export const api = {
  getState: () => request<StatePayload>('/state'),
  runTask: (body: { prompt: string; agents: string[]; projectGroupId?: string; cascade?: boolean; timeoutSec?: number }) =>
    request<{ taskId: string }>('/task', { method: 'POST', body: JSON.stringify(body) }),
  cancelTask: (taskId: string) => request<{ ok: boolean }>(`/task/${encodeURIComponent(taskId)}/cancel`, { method: 'POST' }),
  retryTask: (taskId: string, agents?: string[]) =>
    request<{ taskId: string }>(`/task/${encodeURIComponent(taskId)}/retry`, { method: 'POST', body: JSON.stringify({ agents }) }),
  getLog: (taskId: string, agent: string) =>
    request<{ agent: string; log: string; state: AgentRunState | null }>(`/task/${encodeURIComponent(taskId)}/log?agent=${encodeURIComponent(agent)}`),
  merge: (taskId: string, body: { agents?: string[]; files?: string[]; discardAfterMerge?: boolean }) =>
    request<{ taskId: string; results: Array<{ agent: string; ok: boolean; committed: boolean; message: string; conflictFiles: string[] }> }>(
      `/task/${encodeURIComponent(taskId)}/merge`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  discard: (taskId: string) => request<{ ok: boolean }>(`/task/${encodeURIComponent(taskId)}/discard`, { method: 'POST' }),
  loadTopology: (group: string) => request<{ group: string; topology: TopologyPayload | null }>(`/topology?group=${encodeURIComponent(group)}`),
  saveTopology: (topology: TopologyPayload) => request<{ ok: boolean }>('/topology/save', { method: 'POST', body: JSON.stringify({ topology }) }),
  createGroup: (group: string, name?: string) => request<{ topology: TopologyPayload }>('/topology/create', { method: 'POST', body: JSON.stringify({ group, name }) }),
  deleteGroup: (group: string) => request<{ ok: boolean }>('/topology/delete', { method: 'POST', body: JSON.stringify({ group }) }),
  scanApi: (localPath: string) => request<{ total: number; endpoints: ApiEndpointPayload[] }>('/topology/scan-api', { method: 'POST', body: JSON.stringify({ localPath }) }),
  importPreview: (source: string, text: string, inferDeps: boolean) =>
    request<ImportPreviewPayload>('/topology/import-preview', { method: 'POST', body: JSON.stringify({ source, text, inferDeps }) }),
  importApply: (group: string, preview: ImportPreviewPayload) =>
    request<{ topology: TopologyPayload }>('/topology/import-apply', { method: 'POST', body: JSON.stringify({ group, preview }) }),
  exportYaml: (group: string) => request<string>(`/topology/export?group=${encodeURIComponent(group)}`),
}

export const AGENTS = ['claude', 'codex', 'pi', 'oh-my-pi'] as const
export const AGENT_LABELS: Record<string, string> = { claude: 'Claude', codex: 'Codex', pi: 'Pi', 'oh-my-pi': 'oh-my-pi' }
export const USAGE_QUOTA = 5000
