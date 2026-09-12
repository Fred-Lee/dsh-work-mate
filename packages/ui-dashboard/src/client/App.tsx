/**
 * Helmsman Dashboard — implements PRD 第 4 章 (UI 交互流程与设计系统规范):
 * 单向数据流, 任务状态机视觉反馈, 项目群配置面板, 七种边缘状态, 暗色主题,
 * 4px 网格, 响应式 3/2/1 列网格。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import {
  AGENTS,
  AGENT_LABELS,
  SERVICE_LEVEL_METHOD,
  USAGE_QUOTA,
  api,
  artifactUrl,
  subscribeTaskStream,
  type AgentRunPayload,
  type AgentRunState,
  type AuditEntryPayload,
  type GraphHealthPayload,
  type ImportPreviewPayload,
  type StatePayload,
  type TaskPayload,
  type TaskStreamHandle,
  type TopologyPayload,
} from './api'
import {
  ACTIVE_TASK_STATES,
  type ClientExecutionEvent,
  type ClientTaskStatePayload,
  type TaskStreamStatus,
} from './event'
import { injectDashboardStyles } from './inject-styles'
import { runGatedAction } from './approval'

// Embedded mounts get their stylesheet from this injection (standalone mounts
// load the same file via index.html <link>; the injection is idempotent).
injectDashboardStyles()

/** Task states that ended (bundle packaging is offered on these). */
const TASK_TERMINAL_STATES: ReadonlySet<string> = new Set(['COMPLETED', 'PARTIAL_FAILED', 'ALL_FAILED', 'CANCELLED'])

/** Same-origin download via the artifact endpoint (attachment header server-side). */
function downloadFromUrl(url: string): void {
  const a = document.createElement('a')
  a.href = url
  a.rel = 'noreferrer'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

interface Toast {
  id: number
  kind: 'info' | 'success' | 'warning' | 'error'
  text: string
}

interface StateShape {
  loading: boolean
  groups: string[]
  currentGroup: string | null
  agents: Record<string, { installed: boolean; version?: string }>
  tasks: TaskPayload[]
  selectedTaskId: string | null
  usage: Record<string, { runs: number; estimatedTokens: number }>
  toasts: Toast[]
  configOpen: boolean
  theme: 'light' | 'dark'
  isExecuting: boolean
  /** `"${taskId}:${agent}"` → streamed log tail (selected task only). */
  agentLogs: Record<string, string>
  /** Per-task SSE stream state, for the reconnect/pruned indicators. */
  streams: Record<string, { status: TaskStreamStatus; pruned: boolean }>
}

type Action =
  | { type: 'loaded'; payload: StatePayload }
  | { type: 'selectTask'; taskId: string | null }
  | { type: 'selectGroup'; group: string | null }
  | { type: 'toast'; kind: Toast['kind']; text: string }
  | { type: 'dismissToast'; id: number }
  | { type: 'setConfigOpen'; open: boolean }
  | { type: 'toggleTheme' }
  | { type: 'setExecuting'; value: boolean }
  | { type: 'streamEvent'; event: ClientExecutionEvent }
  | { type: 'streamPruned'; taskId: string }
  | { type: 'streamStatus'; taskId: string; status: TaskStreamStatus }

let toastSeq = 1

/** Per-agent log cap while a task is selected (keeps the UI bounded). */
const MAX_CLIENT_LOG = 512 * 1024

function reducer(state: StateShape, action: Action): StateShape {
  switch (action.type) {
    case 'loaded': {
      const active = action.payload.tasks.some((t) => ACTIVE_TASK_STATES.has(t.status) && t.interrupted !== true)
      return {
        ...state,
        loading: false,
        groups: action.payload.groups,
        currentGroup: state.currentGroup ?? action.payload.groups[0] ?? null,
        agents: action.payload.agents,
        tasks: action.payload.tasks,
        selectedTaskId: state.selectedTaskId ?? action.payload.tasks[0]?.id ?? null,
        usage: action.payload.usage,
        isExecuting: active,
      }
    }
    case 'selectTask':
      // switching the visible task rebuilds its log from the durable replay
      return { ...state, selectedTaskId: action.taskId, agentLogs: {} }
    case 'selectGroup':
      return { ...state, currentGroup: action.group, tasks: [], selectedTaskId: null, loading: true, agentLogs: {}, streams: {} }
    case 'toast':
      return { ...state, toasts: [...state.toasts, { id: toastSeq++, kind: action.kind, text: action.text }] }
    case 'dismissToast':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) }
    case 'setConfigOpen':
      return { ...state, configOpen: action.open }
    case 'toggleTheme':
      return { ...state, theme: state.theme === 'dark' ? 'light' : 'dark' }
    case 'setExecuting':
      return { ...state, isExecuting: action.value }
    case 'streamStatus':
      return {
        ...state,
        streams: { ...state.streams, [action.taskId]: { ...(state.streams[action.taskId] ?? { pruned: false }), status: action.status } },
      }
    case 'streamPruned':
      return {
        ...state,
        streams: { ...state.streams, [action.taskId]: { status: 'open', pruned: true } },
      }
    case 'streamEvent': {
      const event = action.event
      let tasks = state.tasks
      if (event.kind === 'task-state') {
        const patched = taskFromStateEvent(event.payload)
        const known = tasks.some((t) => t.id === event.taskId)
        tasks = known ? tasks.map((t) => (t.id === event.taskId ? patched : t)) : [patched, ...tasks]
      }
      let agentLogs = state.agentLogs
      if (event.kind === 'agent-log' && event.taskId === state.selectedTaskId && event.agent) {
        const key = `${event.taskId}:${event.agent}`
        const prev = agentLogs[key] ?? ''
        const next = (prev + (event.payload.text ?? '')).slice(-MAX_CLIENT_LOG)
        agentLogs = prev === next ? agentLogs : { ...agentLogs, [key]: next }
      }
      return { ...state, tasks, agentLogs }
    }
  }
}

/** Translate a durable `task-state` event payload into the SPA task card shape. */
function taskFromStateEvent(payload: ClientTaskStatePayload): TaskPayload {
  const agents: Record<string, AgentRunPayload> = {}
  for (const [name, r] of Object.entries(payload.agents ?? {})) {
    agents[name] = {
      state: r.state,
      attempts: r.attempts,
      startedAt: r.startedAt ?? null,
      endedAt: r.endedAt ?? null,
      exitCode: r.exitCode ?? null,
      error: r.error ?? null,
      stats: r.stats ?? null,
      conflictingFiles: r.conflictingFiles ?? [],
      hasDiff: r.hasDiff === true,
    }
  }
  return {
    id: payload.id,
    prompt: payload.prompt,
    status: payload.status,
    projectGroupId: payload.projectGroupId ?? null,
    cascade: payload.cascade,
    timeoutSec: payload.timeoutSec,
    createdAt: payload.createdAt,
    endedAt: payload.endedAt ?? null,
    interrupted: payload.interrupted === true,
    agents,
  }
}

// ---------------------------------------------------------------------------
// app
// ---------------------------------------------------------------------------

export function App() {
  const [state, dispatch] = useReducer(reducer, {
    loading: true,
    groups: [],
    currentGroup: null,
    agents: {},
    tasks: [],
    selectedTaskId: null,
    usage: {},
    toasts: [],
    configOpen: new URLSearchParams(window.location.search).get('panel') === 'config',
    theme: new URLSearchParams(window.location.search).get('theme') === 'dark'
      || window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    isExecuting: false,
    agentLogs: {},
    streams: {},
  })
  const [isOffline, setOffline] = useState(!navigator.onLine)
  const [search, setSearch] = useState('')
  /** Live pending confirmation count (approval-gates badge). */
  const [pendingApprovals, setPendingApprovals] = useState(0)
  const [governanceOpen, setGovernanceOpen] = useState(false)
  const [governanceAudit, setGovernanceAudit] = useState<AuditEntryPayload[] | null>(null)
  // Own container root: when mounted standalone the ref is null (not yet
  // rendered) and the theme falls through to <html> as before; when embedded,
  // the theme is scoped here so the host page's theme is untouched.
  const rootRef = useRef<HTMLDivElement | null>(null)
  /** Open per-task SSE controllers, keyed by task id. */
  const controllersRef = useRef<Map<string, TaskStreamHandle>>(new Map())
  /** Cursor we will start the next stream at (0 = replay the retained log). */
  const cursorsRef = useRef<Map<string, number>>(new Map())

  useEffect(() => {
    // Scope theme to the dashboard container. As an embedded view (workbench
    // drawer / DSH shell) the dashboard must NOT touch <html data-theme> —
    // that would flip the host app's whole page theme on mount.
    const ownRoot = rootRef.current
    if (ownRoot) {
      ownRoot.dataset.theme = state.theme
      return
    }
    document.documentElement.dataset.theme = state.theme
  }, [state.theme])

  useEffect(() => {
    const on = (): void => setOffline(false)
    const off = (): void => setOffline(true)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])

  const toast = useCallback((kind: Toast['kind'], text: string) => {
    dispatch({ type: 'toast', kind, text })
  }, [])

  const selectTask = useCallback((taskId: string | null) => {
    dispatch({ type: 'selectTask', taskId })
    if (taskId) {
      // Start the visible task's log from scratch: cursor 0 replays whatever
      // the durable store still retains (per-agent logs rebuild from events).
      cursorsRef.current.set(taskId, 0)
      const existing = controllersRef.current.get(taskId)
      if (existing) {
        existing.close()
        controllersRef.current.delete(taskId)
      }
    }
  }, [])

  // coarse state poll — now a safety net + discovery of new task ids (D5).
  // Live updates ride the per-task SSE streams below.
  const refresh = useCallback(async () => {
    try {
      const payload = await api.getState()
      dispatch({ type: 'loaded', payload })
    } catch {
      // keep last known data on transient errors (降级不崩溃)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // coarse safety-net poll only; streams keep the visible cards fresh in between
  useEffect(() => {
    const interval = setInterval(() => void refresh(), 5000)
    return () => clearInterval(interval)
  }, [refresh])

  // Approval-gate badge: keep the pending-confirmation count fresh so headless
  // (tool-originated) requests are visible to the operator. Best-effort.
  useEffect(() => {
    let active = true
    const tick = async (): Promise<void> => {
      try {
        const res = await api.listPendingApprovals()
        if (!active) return
        setPendingApprovals((res.approvals ?? []).length)
      } catch {
        // transient / unsupported → keep last known badge
      }
    }
    void tick()
    const id = setInterval(() => void tick(), 5000)
    return () => {
      active = false
      clearInterval(id)
    }
  }, [])

  const openGovernance = useCallback(async () => {
    setGovernanceOpen(true)
    try {
      setGovernanceAudit((await api.audit({})).entries)
    } catch {
      setGovernanceAudit([])
    }
  }, [])

  const activeTaskIds = useMemo(
    () => new Set(state.tasks.filter((t) => ACTIVE_TASK_STATES.has(t.status) && t.interrupted !== true).map((t) => t.id)),
    [state.tasks],
  )

  // One SSE stream per active task: subscribe with the last cursor we stored;
  // reconnects are cursor-based (server replays from the durable store).
  useEffect(() => {
    for (const id of activeTaskIds) {
      if (controllersRef.current.has(id)) continue
      const handle = subscribeTaskStream(id, cursorsRef.current.get(id) ?? 0, {
        onEvent: (event) => {
          // remember where we are so a re-open after retry/terminal can resume
          cursorsRef.current.set(event.taskId, event.seq)
          dispatch({ type: 'streamEvent', event })
        },
        onPruned: () => dispatch({ type: 'streamPruned', taskId: id }),
        onStatus: (status) => dispatch({ type: 'streamStatus', taskId: id, status }),
      })
      controllersRef.current.set(id, handle)
    }
    for (const [id, handle] of [...controllersRef.current]) {
      if (!activeTaskIds.has(id) || !handle.active) {
        handle.close()
        controllersRef.current.delete(id)
      }
    }
  }, [activeTaskIds, state.selectedTaskId])

  // Unmount: tear every stream down (separate effect so per-change re-runs of
  // the reconciliation above never churn connections).
  useEffect(() => {
    return () => {
      for (const handle of controllersRef.current.values()) handle.close()
      controllersRef.current.clear()
    }
  }, [])

  useEffect(() => {
    if (state.toasts.length === 0) return
    const timers = state.toasts
      .filter((t) => t.kind !== 'error')
      .map((t) => setTimeout(() => dispatch({ type: 'dismissToast', id: t.id }), 3000))
    return () => timers.forEach(clearTimeout)
  }, [state.toasts])

  const selectedTask = useMemo(
    () => state.tasks.find((t) => t.id === state.selectedTaskId) ?? state.tasks[0] ?? null,
    [state.tasks, state.selectedTaskId],
  )

  const selectedStream = selectedTask ? state.streams[selectedTask.id] : undefined

  const filteredTasks = useMemo(() => {
    if (!search.trim()) return state.tasks
    const q = search.trim().toLowerCase()
    return state.tasks.filter((t) => t.prompt.toLowerCase().includes(q) || t.id.includes(q))
  }, [state.tasks, search])

  if (state.loading && state.tasks.length === 0 && state.groups.length === 0) {
    return (
      <div className="app" ref={rootRef}>
        <SkeletonScreen />
      </div>
    )
  }

  return (
    <div className="app" ref={rootRef}>
      {isOffline && <OfflineBanner onRetry={() => { void refresh() }} />}
      <TopBar
        groups={state.groups}
        currentGroup={state.currentGroup}
        onSelectGroup={(g) => dispatch({ type: 'selectGroup', group: g })}
        onOpenConfig={() => dispatch({ type: 'setConfigOpen', open: true })}
        search={search}
        onSearch={setSearch}
        theme={state.theme}
        onToggleTheme={() => dispatch({ type: 'toggleTheme' })}
      />
      <main className="main">
        {state.groups.length === 0 ? (
          <EmptyState
            onCreate={() => dispatch({ type: 'setConfigOpen', open: true })}
            onImportCompose={() => dispatch({ type: 'setConfigOpen', open: true })}
          />
        ) : (
          <>
            <NewTaskCard
              agents={state.agents}
              currentGroup={state.currentGroup}
              disabled={state.isExecuting}
              isOffline={isOffline}
              onToast={toast}
              onSubmitted={(taskId) => {
                selectTask(taskId)
                void refresh()
              }}
            />
            {selectedTask != null && (
              <section className="task-section" aria-label="任务卡片">
                {selectedStream?.pruned && (
                  <div className="history-pruned-banner" role="alert">
                    ⚠️ 该任务的部分历史早于当前游标，已被清理（history-pruned）；下方为仍保留的事件。
                  </div>
                )}
                {(selectedStream?.status === 'reconnecting' || selectedStream?.status === 'connecting') && (
                  <div className="stream-status" role="status">
                    {selectedStream.status === 'reconnecting' ? '🔄 断线重连中，正在按游标重新同步…' : '📡 连接任务事件流…'}
                  </div>
                )}
                <TaskHeader
                  tasks={filteredTasks}
                  selectedTask={selectedTask}
                  onSelect={selectTask}
                  onDiscard={async (id) => {
                    try {
                      const executed = await runGatedAction(
                        'discard',
                        { taskId: id },
                        `确认放弃任务 ${id} 的全部 worktree 变更？此操作需要代码级确认。`,
                        (token) => api.discard(id, token),
                      )
                      if (!executed) return
                      toast('success', '已放弃全部 worktree')
                      void refresh()
                    } catch (err) {
                      toast('error', err instanceof Error ? err.message : String(err))
                    }
                  }}
                  onBundle={async (id) => {
                    try {
                      const res = await api.buildTaskBundle(id)
                      toast('info', `产物包已生成 → ${res.patch.fileName}`)
                      downloadFromUrl(artifactUrl(res.patch.id))
                    } catch (err) {
                      toast('error', err instanceof Error ? err.message : String(err))
                    }
                  }}
                />
                <div className="card-grid">
                  {Object.entries(selectedTask.agents).map(([agent, run]) => (
                    <AgentCard
                      key={agent}
                      agent={agent}
                      run={run}
                      task={selectedTask}
                      liveLog={state.agentLogs[`${selectedTask.id}:${agent}`] ?? ''}
                      logLive={selectedStream != null && selectedStream.status !== 'closed'}
                      onToast={toast}
                      onRefresh={() => void refresh()}
                    />
                  ))}
                </div>
                <UsageBar usage={state.usage} />
              </section>
            )}
          </>
        )}
      </main>
      {state.configOpen && (
        <ConfigPanel
          groups={state.groups}
          currentGroup={state.currentGroup}
          onClose={() => dispatch({ type: 'setConfigOpen', open: false })}
          onSelectGroup={(g) => dispatch({ type: 'selectGroup', group: g })}
          onToast={toast}
        />
      )}
      <Toasts toasts={state.toasts} onDismiss={(id) => dispatch({ type: 'dismissToast', id })} />
      <GovernanceFab
        pendingCount={pendingApprovals}
        onOpen={() => void openGovernance()}
      />
      {governanceOpen && (
        <GovernancePanel
          onClose={() => setGovernanceOpen(false)}
          onDecided={() => {
            void (async () => {
              try {
                setGovernanceAudit((await api.audit({})).entries)
              } catch {
                setGovernanceAudit([])
              }
            })()
            void api
              .listPendingApprovals()
              .then((r) => setPendingApprovals((r.approvals ?? []).length))
              .catch(() => undefined)
          }}
          audit={governanceAudit}
          onRefreshAudit={async () => {
            try {
              setGovernanceAudit((await api.audit({})).entries)
            } catch {
              setGovernanceAudit([])
            }
          }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// edge states (PRD §5)
// ---------------------------------------------------------------------------

function SkeletonScreen() {
  return (
    <div className="skeleton-wrap" aria-busy="true">
      <div className="skeleton skeleton-bar" />
      <div className="skeleton skeleton-block" />
      <div className="skeleton-grid">
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="skeleton skeleton-card" />
        ))}
      </div>
    </div>
  )
}

function OfflineBanner({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="offline-banner" role="alert">
      <span>⚡ 网络已断开，当前显示本地缓存数据</span>
      <button className="btn btn-sm" onClick={onRetry}>🔄 重连</button>
    </div>
  )
}

function EmptyState({ onCreate, onImportCompose }: { onCreate: () => void; onImportCompose: () => void }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">📭</div>
      <h2>还没有项目群</h2>
      <p>创建第一个项目群，开始指挥你的 Agent 舰队</p>
      <button className="btn btn-primary" onClick={onCreate}>➕ 创建项目群</button>
      <div className="empty-import">
        <span>或者从现有架构导入:</span>
        <button className="btn btn-sm" onClick={onImportCompose}>📂 导入 docker-compose.yml</button>
        <button className="btn btn-sm" onClick={onImportCompose}>📂 导入 K8s manifest</button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// top bar
// ---------------------------------------------------------------------------

function TopBar(props: {
  groups: string[]
  currentGroup: string | null
  onSelectGroup: (g: string) => void
  onOpenConfig: () => void
  search: string
  onSearch: (v: string) => void
  theme: 'light' | 'dark'
  onToggleTheme: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <header className="topbar">
      <span className="logo">⚓ Helmsman</span>
      <div className="group-switcher">
        <button className="group-btn" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
          项目群: {props.currentGroup ?? '未选择项目群'} <span className="caret">▼</span>
        </button>
        {expanded && (
          <ul className="group-menu" role="listbox">
            {props.groups.length === 0 && <li className="group-item muted">（暂无项目群）</li>}
            {props.groups.map((g) => (
              <li key={g}>
                <button
                  className={`group-item ${g === props.currentGroup ? 'active' : ''}`}
                  onClick={() => {
                    props.onSelectGroup(g)
                    setExpanded(false)
                  }}
                >
                  🕸️ {g}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <button className="icon-btn" title="项目群配置" aria-label="打开配置面板" onClick={props.onOpenConfig}>⚙️</button>
      <input
        className="search"
        type="search"
        placeholder="🔍 搜索任务"
        value={props.search}
        onChange={(e) => props.onSearch(e.target.value)}
      />
      <button className="icon-btn" title="切换主题" onClick={props.onToggleTheme}>{props.theme === 'dark' ? '☀️' : '🌙'}</button>
      <span className="profile-chip" title="当前 Profile">👤 web</span>
    </header>
  )
}

// ---------------------------------------------------------------------------
// new task (PRD §4.6 线稿)
// ---------------------------------------------------------------------------

interface TemplateEntry {
  name: string
  prompt: string
  agents: string[]
}

const TEMPLATE_KEY = 'helmsman.templates'

function loadTemplates(): TemplateEntry[] {
  try {
    return JSON.parse(localStorage.getItem(TEMPLATE_KEY) ?? '[]') as TemplateEntry[]
  } catch {
    return []
  }
}

function NewTaskCard(props: {
  agents: Record<string, { installed: boolean; version?: string }>
  currentGroup: string | null
  disabled: boolean
  isOffline: boolean
  onToast: (kind: Toast['kind'], text: string) => void
  onSubmitted: (taskId: string) => void
}) {
  const [prompt, setPrompt] = useState(() => localStorage.getItem('helmsman.promptDraft') ?? '')
  const [selected, setSelected] = useState<Record<string, boolean>>({ claude: true, codex: true, pi: false, 'oh-my-pi': false })
  const [cascade, setCascade] = useState(false)
  const [timeoutSec, setTimeoutSec] = useState(300)
  const [error, setError] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [templates, setTemplates] = useState<TemplateEntry[]>(loadTemplates)
  const [showTemplates, setShowTemplates] = useState(false)
  const promptRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const id = setTimeout(() => localStorage.setItem('helmsman.promptDraft', prompt), 400)
    return () => clearTimeout(id)
  }, [prompt])

  const anySelected = Object.values(selected).some(Boolean)
  const unavailable = Object.values(props.agents).length > 0 && AGENTS.every((a) => props.agents[a] && !props.agents[a]?.installed)

  const submit = async (): Promise<void> => {
    if (!prompt.trim()) {
      setError(true)
      setTimeout(() => setError(false), 600)
      props.onToast('warning', '请输入任务内容')
      promptRef.current?.focus()
      return
    }
    const agents = AGENTS.filter((a) => selected[a])
    if (agents.length === 0) {
      props.onToast('warning', '请至少选择一个 Agent')
      return
    }
    setSubmitting(true)
    try {
      const { taskId } = await api.runTask({
        prompt,
        agents,
        ...(props.currentGroup ? { projectGroupId: props.currentGroup } : {}),
        ...(cascade ? { cascade: true } : {}),
        timeoutSec,
      })
      props.onToast('success', `任务已提交 (${taskId})`)
      setPrompt('')
      localStorage.removeItem('helmsman.promptDraft')
      props.onSubmitted(taskId)
    } catch (err) {
      props.onToast('error', err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className={`new-task ${error ? 'shake' : ''}`} aria-label="新任务">
      <h3 className="section-title">📝 新任务</h3>
      <textarea
        ref={promptRef}
        className={`prompt-input ${error ? 'error' : ''}`}
        placeholder="请在此输入你的需求，例如：为 user-service 增加修改密码接口并补充单元测试"
        rows={3}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        disabled={props.disabled}
      />
      <div className="agent-row" role="group" aria-label="Agent 多选">
        {AGENTS.map((agent) => {
          const status = props.agents[agent]
          const installed = status == null || status.installed
          return (
            <label key={agent} className={`agent-toggle ${installed ? '' : 'disabled'}`} title={installed ? status?.version : '未安装'}>
              <input
                type="checkbox"
                checked={selected[agent] === true}
                disabled={!installed || props.disabled}
                onChange={(e) => setSelected({ ...selected, [agent]: e.target.checked })}
              />
              <span>{selected[agent] ? '✅' : '⬜'} {AGENT_LABELS[agent] ?? agent}</span>
              {!installed && <em className="warn">⚠️ 未安装</em>}
            </label>
          )
        })}
        <label className="agent-toggle">
          <input type="checkbox" checked={cascade} onChange={(e) => setCascade(e.target.checked)} />
          <span>🕸️ 级联拓扑上下文</span>
        </label>
        <label className="timeout-label">
          超时
          <input type="number" min={30} max={3600} value={timeoutSec} onChange={(e) => setTimeoutSec(Number(e.target.value) || 300)} />
          秒
        </label>
      </div>
      <div className="task-actions">
        <button
          className={`btn btn-primary ${submitting ? 'loading' : ''}`}
          disabled={props.disabled || submitting || !anySelected || props.isOffline || unavailable}
          title={props.isOffline ? '网络已断开，请连接后重试' : undefined}
          onClick={() => void submit()}
        >
          {submitting ? <span className="spinner" /> : '▶'} {submitting ? '执行中...' : '并行执行'}
        </button>
        <button
          className="btn"
          onClick={() => {
            const name = prompt.trim().slice(0, 20) || '未命名模板'
            const entry: TemplateEntry = { name, prompt, agents: AGENTS.filter((a) => selected[a]) }
            const next = [...templates, entry]
            setTemplates(next)
            localStorage.setItem(TEMPLATE_KEY, JSON.stringify(next))
            props.onToast('success', '已保存为模板')
          }}
          disabled={!prompt.trim()}
        >
          💾 保存为模板
        </button>
        {templates.length > 0 && (
          <div className="templates">
            <button className="btn btn-sm" onClick={() => setShowTemplates(!showTemplates)}>📋 模板 ({templates.length})</button>
            {showTemplates && (
              <ul className="templates-menu">
                {templates.map((t, i) => (
                  <li key={i}>
                    <button
                      className="group-item"
                      onClick={() => {
                        setPrompt(t.prompt)
                        setSelected(Object.fromEntries(AGENTS.map((a) => [a, t.agents.includes(a)])) as Record<string, boolean>)
                        setShowTemplates(false)
                      }}
                    >
                      {t.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// task header + agent cards (PRD §4.4.2 视觉规范)
// ---------------------------------------------------------------------------

function TaskHeader(props: {
  tasks: TaskPayload[]
  selectedTask: TaskPayload
  onSelect: (id: string) => void
  onDiscard: (id: string) => Promise<void>
  /** Package the terminal task's agent diffs into a downloadable artifact. */
  onBundle?: (id: string) => Promise<void>
}) {
  const t = props.selectedTask
  const [bundling, setBundling] = useState(false)
  const completed = Object.values(t.agents).filter((r) => r.state === 'completed').length
  const total = Object.values(t.agents).length
  const interruptedBanner = t.interrupted === true
    ? <div className="degraded-banner">⚠️ 该任务在宿主重启前未完成，当前为最后已知状态</div>
    : null
  const banner =
    t.status === 'AGGREGATING' ? <div className="aggregating-banner">📊 正在对比结果...</div>
    : t.status === 'PARTIAL_FAILED' ? <div className="degraded-banner">⚠️ 部分 Agent 执行失败 ({completed}/{total} 成功)</div>
    : t.status === 'ALL_FAILED' ? <div className="degraded-banner error">❌ 全部 Agent 执行失败</div>
    : t.status === 'CANCELLED' ? <div className="degraded-banner">⏹ 任务已取消</div>
    : null
  const terminal = TASK_TERMINAL_STATES.has(t.status)
  const onBundle = props.onBundle
  return (
    <div className="task-header">
      <div className="task-meta">
        <span className="muted">任务</span>
        <select value={t.id} onChange={(e) => props.onSelect(e.target.value)} aria-label="选择任务">
          {props.tasks.map((task) => (
            <option key={task.id} value={task.id}>
              {task.id} — {task.prompt.slice(0, 40)}
            </option>
          ))}
        </select>
        <span className={`badge status-${t.status}`}>{t.status}</span>
        {t.cascade && <span className="badge">🕸️ 级联</span>}
      </div>
      {terminal && onBundle && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
          <button
            className="btn btn-sm"
            disabled={bundling}
            onClick={async () => {
              setBundling(true)
              try {
                await onBundle(t.id)
              } finally {
                setBundling(false)
              }
            }}
            title="把各 Agent 的 worktree diff 打包为可下载 .patch + .json 产物"
          >
            {bundling ? '⏳ 打包中…' : '📦 下载产物包'}
          </button>
          <span className="muted small">终态任务的各 Agent diff 打成统一 .patch,可 git apply 复现</span>
        </div>
      )}
      {interruptedBanner}
      {banner}
    </div>
  )
}

const STATE_META: Record<AgentRunState, { dot: string; label: string; cls: string }> = {
  idle: { dot: '⚪', label: '待命', cls: 'idle' },
  running: { dot: '🔄', label: '执行中', cls: 'running' },
  completed: { dot: '🟢', label: '完成', cls: 'completed' },
  failed: { dot: '🔴', label: '失败', cls: 'failed' },
  timeout: { dot: '⏰', label: '超时', cls: 'timeout' },
  'rate-limited': { dot: '⏱️', label: '限流中', cls: 'rate-limited' },
  'auth-failed': { dot: '🔐', label: '认证失效', cls: 'auth-failed' },
  cancelled: { dot: '⏹️', label: '已取消', cls: 'cancelled' },
}

function AgentCard(props: {
  agent: string
  run: AgentRunPayload
  task: TaskPayload
  /** Streamed log text for this agent (from the task's SSE timeline). */
  liveLog: string
  /** True while the task has a live stream feeding `liveLog`. */
  logLive: boolean
  onToast: (kind: Toast['kind'], text: string) => void
  onRefresh: () => void
}) {
  const { agent, run, task } = props
  const meta = STATE_META[run.state] ?? STATE_META.idle
  const [elapsed, setElapsed] = useState(0)
  const [logOpen, setLogOpen] = useState(false)
  const [log, setLog] = useState('')

  useEffect(() => {
    if (run.state !== 'running' || run.startedAt == null) return
    const started = typeof run.startedAt === 'number' ? run.startedAt : Date.parse(String(run.startedAt))
    const tick = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(tick)
  }, [run.state, run.startedAt])

  // Keep a best-effort copy of the streamed log so a terminal task still shows
  // its content once its live stream has closed.
  useEffect(() => {
    setLog((prev) => (props.liveLog.length > prev.length ? props.liveLog : prev))
  }, [props.liveLog])

  // Polling safety net only — used when no live stream is feeding this agent
  // (terminal tasks / tasks that never got a stream). Live tasks render the
  // streamed `liveLog` prop instead and never poll (D5).
  useEffect(() => {
    if (props.logLive || !logOpen) return
    let active = true
    const poll = async (): Promise<void> => {
      try {
        const res = await api.getLog(task.id, agent)
        if (!active) return
        setLog((prev) => (res.log.length >= prev.length ? res.log : prev))
      } catch {
        // transient
      }
    }
    void poll()
    const id = setInterval(() => void poll(), 5000)
    return () => {
      active = false
      clearInterval(id)
    }
  }, [logOpen, task.id, agent, props.logLive])

  // Reset local state when the visible task changes (the card is keyed by agent).
  useEffect(() => {
    setLog('')
    setLogOpen(false)
  }, [task.id])

  const shownLog = props.logLive ? props.liveLog : log

  const progress = run.state === 'completed' ? 100
    : run.state === 'timeout' ? 80
    : run.state === 'running' ? Math.min(95, (elapsed / task.timeoutSec) * 100)
    : run.state === 'failed' || run.state === 'auth-failed' ? 0
    : 0

  return (
    <article className={`agent-card ${meta.cls}`} style={{ width: 280, minHeight: 160 }}>
      <header className="card-head">
        <span className="card-title">
          {meta.dot} {AGENT_LABELS[agent] ?? agent}
        </span>
        <span className="muted small">
          {run.state === 'running' && <>执行中 {elapsed}s</>}
          {run.state === 'completed' && run.stats && <>✅ 完成 +{run.stats.additions}/-{run.stats.deletions}行</>}
          {run.state === 'failed' && <>❌ 失败</>}
          {run.state === 'timeout' && <>⏰ 超时 ({task.timeoutSec}s)</>}
          {run.state === 'rate-limited' && <>⏱️ 限流中</>}
          {run.state === 'auth-failed' && <>🔐 认证失效</>}
          {run.state === 'idle' && <>待命</>}
          {run.state === 'cancelled' && <>已取消</>}
        </span>
      </header>
      {run.error && <p className="card-error" title={run.error}>{run.error}</p>}
      {run.conflictingFiles.length > 0 && (
        <p className="card-conflict">⚡ 冲突: {run.conflictingFiles.length} 个文件与其他 Agent 重叠</p>
      )}
      <div className="progress-track" role="progressbar" aria-valuenow={Math.round(progress)} aria-valuemin={0} aria-valuemax={100}>
        <div className="progress-fill" style={{ width: `${progress}%` }} />
      </div>
      <div className="card-actions">
        {run.state === 'completed' && (
          <a className="btn btn-sm btn-primary" href={`/helmsman-diff/?task=${encodeURIComponent(task.id)}`}>
            查看Diff
          </a>
        )}
        {(run.state === 'failed' || run.state === 'timeout' || run.state === 'cancelled') && (
          <button
            className="btn btn-sm"
            onClick={async () => {
              try {
                await api.retryTask(task.id, [agent])
                props.onToast('info', `正在重试 ${agent}`)
                props.onRefresh()
              } catch (err) {
                props.onToast('error', err instanceof Error ? err.message : String(err))
              }
            }}
          >
            重试
          </button>
        )}
        {run.state === 'auth-failed' && <button className="btn btn-sm" onClick={() => props.onToast('info', '请更新该 Agent 的 API 密钥后重试')}>配置密钥</button>}
        {run.state === 'rate-limited' && <button className="btn btn-sm" onClick={() => props.onToast('info', '限流恢复后将自动重试，或切换其他 Agent')}>稍后重试</button>}
        {run.state === 'running' && (
          <button
            className="btn btn-sm danger"
            onClick={async () => {
              try {
                // cancel is auto-grant by default policy (runs directly); a
                // strict operator policy prompts through the approval gate.
                const executed = await runGatedAction(
                  'cancel',
                  { taskId: task.id },
                  `确认取消任务 ${task.id}？取消后该任务的 agent 会被中止。`,
                  (token) => api.cancelTask(task.id, token),
                )
                if (!executed) return
                props.onToast('info', '已发送取消信号')
                props.onRefresh()
              } catch (err) {
                props.onToast('error', err instanceof Error ? err.message : String(err))
              }
            }}
          >
            ✕ 取消
          </button>
        )}
        <button className="btn btn-sm ghost" onClick={() => setLogOpen(!logOpen)}>
          {logOpen ? '收起日志' : '展开日志'}
        </button>
      </div>
      {logOpen && (
        <pre className="card-log" aria-label={`${agent} 日志`}>
          {shownLog || '（暂无输出）'}
        </pre>
      )}
    </article>
  )
}

function UsageBar(props: { usage: Record<string, { runs: number; estimatedTokens: number }> }) {
  const entries = AGENTS.map((a) => ({ agent: a, usage: props.usage[a] })).filter((e) => e.usage)
  if (entries.length === 0) return null
  return (
    <div className="usage-bar">
      <span>📊 用量:</span>
      {entries.map(({ agent, usage }) => (
        <span key={agent} className="usage-item">
          {AGENT_LABELS[agent]} {fmtK(usage?.estimatedTokens ?? 0)}/{fmtK(USAGE_QUOTA)}
        </span>
      ))}
    </div>
  )
}

function fmtK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n)
}

// ---------------------------------------------------------------------------
// config panel (PRD §4.7)
// ---------------------------------------------------------------------------

type RestEdgePayload = TopologyPayload['restDependencies'][string][number]

/**
 * 前端镜像的「同一对服务只有一条边」（design D2）——语义与 memory-topology 的
 * `mergeDependencyEdge` 一致：明细并入既有边、按 (method, endpoint) 去重，无明细的
 * 添加既不新增行也不覆盖明细。
 *
 * 仅为即时体验（保存后界面立刻只显示一行）；**权威去重仍在服务端保存路径**，
 * 导入 / 直接调 HTTP / 手改 JSON 都不会绕过它。
 */
function mergeClientEdge(edges: RestEdgePayload[], incoming: RestEdgePayload): RestEdgePayload[] {
  const at = edges.findIndex((e) => e.toServiceId === incoming.toServiceId)
  if (at < 0) return [...edges, incoming]
  const existing = edges[at]!
  const incomingHasDetail = incoming.endpoints.length > 0
  const method = incomingHasDetail && existing.endpoints.length === 0 ? incoming.method : existing.method
  const endpoints = [...new Set([...existing.endpoints, ...incoming.endpoints])]
  const merged: RestEdgePayload = {
    toServiceId: existing.toServiceId,
    endpoints,
    method,
    ...(existing.critical === true || incoming.critical === true ? { critical: true } : {}),
  }
  return [...edges.slice(0, at), merged, ...edges.slice(at + 1)]
}

export function ConfigPanel(props: {
  groups: string[]
  currentGroup: string | null
  onClose: () => void
  onSelectGroup: (g: string) => void
  onToast: (kind: Toast['kind'], text: string) => void
}) {
  const [group, setGroup] = useState<string | null>(props.currentGroup)
  const [topology, setTopology] = useState<TopologyPayload | null>(null)
  // 最近一次「加载 / 保存 / 导入应用」的序列化快照：topology 与快照不等即为未保存修改（dirty）。
  // 关闭面板是显式用户动作，dirty 时需确认，避免另一条「配置到一半被冲掉」的路径。
  const [baseline, setBaseline] = useState<string | null>(null)
  // 保存后拉取的图体检结果（环/悬空引用/孤立服务）；仅提示，不阻断保存。
  const [health, setHealth] = useState<GraphHealthPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState<string | null>(null)
  const [editService, setEditService] = useState<string | 'new' | null>(null)
  const [depModal, setDepModal] = useState(false)
  const [importModal, setImportModal] = useState(false)
  const { onToast } = props

  useEffect(() => {
    let active = true
    setLoading(true)
    setHealth(null)
    if (group == null) {
      setTopology(null)
      setBaseline(null)
      setLoading(false)
      return
    }
    void api
      .loadTopology(group)
      .then((res) => {
        if (!active) return
        setTopology(res.topology)
        setBaseline(res.topology == null ? null : JSON.stringify(res.topology))
      })
      .catch(() => onToast('error', '❌ 无法加载项目拓扑，请检查网络或配置文件'))
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
    // 依赖必须是稳定值: props 对象每次父组件渲染都变身份, 而 App 轮询每 5s/1.5s
    // dispatch loaded 触发重渲染, 会把未保存的 topology 编辑整个冲掉。
    // onToast 来自 App 的 useCallback([]), 身份稳定, 效果等价于仅随 group 变化重载。
  }, [group, onToast])

  const applyTopology = (t: TopologyPayload): void => {
    setTopology(t)
    setBaseline(JSON.stringify(t))
  }

  const dirty = topology != null && baseline != null && JSON.stringify(topology) !== baseline

  const tryClose = (): void => {
    if (dirty && !window.confirm('有未保存的修改，关闭将丢弃。确认关闭？')) return
    props.onClose()
  }

  // 保存后体检（design D3）：结果仅作提示，取不到就静默不显示，绝不打断保存流程。
  const refreshHealth = async (): Promise<void> => {
    if (!group) return
    try {
      const res = await api.topologyHealth(group)
      setHealth(res.health)
    } catch {
      setHealth(null)
    }
  }

  const save = async (): Promise<void> => {
    if (!topology) return
    try {
      await api.saveTopology(topology)
      setBaseline(JSON.stringify(topology))
      onToast('success', '✅ 配置已保存')
      await refreshHealth()
    } catch (err) {
      onToast('error', err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <aside className="config-panel" role="dialog" aria-label="项目群配置">
      <header className="config-head">
        <h3>⚙️ 项目群配置</h3>
        <button className="icon-btn" onClick={tryClose} aria-label="关闭">✕</button>
      </header>

      <div className="config-toolbar">
        <select
          value={group ?? ''}
          onChange={(e) => {
            const g = e.target.value || null
            if (g !== group && dirty && !window.confirm('有未保存的修改，切换项目群将丢弃。确认切换？')) return
            setGroup(g)
            if (g) props.onSelectGroup(g)
          }}
          aria-label="选择项目群"
        >
          <option value="">（新建项目群…）</option>
          {props.groups.map((g) => (
            <option key={g} value={g}>{g}</option>
          ))}
        </select>
        {group && (
          <button
            className="btn btn-sm danger"
            onClick={async () => {
              try {
                const executed = await runGatedAction(
                  'topology-delete',
                  { group },
                  `确认删除项目群 "${group}"？此操作需要代码级确认令牌。`,
                  (token) => api.deleteGroup(group, token),
                )
                if (!executed) return
                onToast('success', '已删除')
                setGroup(null)
                setTopology(null)
                setBaseline(null)
              } catch (err) {
                onToast('error', err instanceof Error ? err.message : String(err))
              }
            }}
          >
            🗑️ 删除
          </button>
        )}
        <button
          className="btn btn-sm"
          onClick={async () => {
            const name = window.prompt('新项目群名称（如：订单中台）')
            if (!name) return
            try {
              await api.createGroup(name)
              // 不手动 setTopology: setGroup 触发的 effect 会从服务端加载新群,
              // 避免双写造成的短暂覆盖窗口(与主 bug 同型)
              setGroup(name)
              props.onSelectGroup(name)
              onToast('success', '项目群已创建')
            } catch (err) {
              onToast('error', err instanceof Error ? err.message : String(err))
            }
          }}
        >
          ➕ 新建
        </button>
        <button className="btn btn-sm" onClick={() => setImportModal(true)}>📥 导入</button>
      </div>

      {loading ? (
        <div className="skeleton skeleton-block" />
      ) : !topology ? (
        <p className="muted" style={{ padding: 16 }}>选择上方项目群，或「➕ 新建」开始配置。</p>
      ) : (
        <div className="config-body">
          {/* 图体检告警条（design D3）：无环/无悬空/无孤立时整块不渲染。 */}
          {health && (health.cyclic || health.dangling.length > 0 || health.isolated.length > 0) && (
            <div className="health-strip" role="status" aria-label="图健康检查">
              {health.cyclic && (
                <p className="badge warn">
                  🔁 依赖环：{health.cycles.map((c) => c.join(' → ')).join('；')}（架构约定不应存在循环调用）
                </p>
              )}
              {health.dangling.map((d, i) => (
                <p key={`dangling-${i}`} className="badge warn">
                  ⚠️ 悬空引用：{d.from} → {d.to}（被调用方不是已登记的服务）
                </p>
              ))}
              {health.isolated.length > 0 && (
                <p className="badge warn">💤 孤立服务（无任何入边/出边）：{health.isolated.join('、')}</p>
              )}
              <p className="muted small">以上仅为提示，不影响保存。</p>
            </div>
          )}

          <section className="config-section">
            <h4>📋 基本信息</h4>
            <label className="field">
              名称
              <input value={topology.name} onChange={(e) => setTopology({ ...topology, name: e.target.value })} />
            </label>
            <label className="field">
              描述
              <input value={topology.description} onChange={(e) => setTopology({ ...topology, description: e.target.value })} />
            </label>
            <label className="field">
              默认分支
              <input value={topology.defaultBranch} onChange={(e) => setTopology({ ...topology, defaultBranch: e.target.value })} />
            </label>
          </section>

          <section className="config-section">
            <h4>
              📦 服务列表 ({Object.keys(topology.services).length})
              <button className="btn btn-sm" onClick={() => setEditService('new')}>➕ 添加服务</button>
            </h4>
            {Object.entries(topology.services).map(([id, svc]) => (
              <article key={id} className="service-row">
                <div className="service-main">
                  <strong>{svc.name}</strong>
                  <span className="muted small">{svc.localPath ?? svc.projectId}</span>
                  <span className="muted small">{svc.techStack.join(', ')}</span>
                </div>
                <div className="service-actions">
                  {svc.apiEndpoints.length > 0 && <span className="badge ok">✅ API 已扫描 ({svc.apiEndpoints.length}个端点)</span>}
                  {scanning === id && <span className="badge warn">⏳ 扫描中...</span>}
                  <button className="btn btn-sm" onClick={() => setEditService(id)}>✏️ 编辑</button>
                  <button
                    className="btn btn-sm danger"
                    onClick={() => {
                      const next = { ...topology.services }
                      delete next[id]
                      applyTopology({ ...topology, services: next })
                    }}
                  >
                    🗑️ 移除
                  </button>
                  <button
                    className="btn btn-sm"
                    disabled={scanning === id || !svc.localPath}
                    onClick={async () => {
                      if (!svc.localPath) return
                      setScanning(id)
                      try {
                        const res = await api.scanApi(svc.localPath)
                        applyTopology({
                          ...topology,
                          services: { ...topology.services, [id]: { ...svc, apiEndpoints: res.endpoints } },
                        })
                        props.onToast('success', `扫描完成：${res.total} 个端点`)
                      } catch (err) {
                        props.onToast('error', err instanceof Error ? err.message : String(err))
                      } finally {
                        setScanning(null)
                      }
                    }}
                  >
                    🔄 扫描 API
                  </button>
                </div>
              </article>
            ))}
          </section>

          <section className="config-section">
            <h4>
              🕸️ 依赖拓扑
              <button className="btn btn-sm" onClick={() => setDepModal(true)}>➕ 添加依赖</button>
            </h4>
            {Object.entries(topology.restDependencies).flatMap(([from, edges]) =>
              edges.map((edge, i) => {
                // 无端点明细的服务级边渲染为 `A ──▶ B`（不出现 `GET ` 这类残缺文本、无尾随空白）。
                const label =
                  edge.endpoints.length > 0
                    ? `${from} ──${edge.method} ${edge.endpoints[0] ?? ''}──▶ ${edge.toServiceId}`
                    : `${from} ──▶ ${edge.toServiceId}`
                return (
                  <p key={`${from}-${i}`} className="dep-line">
                    <span className="dep-label">{label}</span>
                    {edge.critical && <span className="badge warn">关键路径</span>}
                    <button
                      className="btn btn-sm ghost"
                      onClick={() => {
                        const rest = { ...topology.restDependencies }
                        rest[from] = (rest[from] ?? []).filter((_, idx) => idx !== i)
                        if (rest[from]?.length === 0) delete rest[from]
                        applyTopology({ ...topology, restDependencies: rest })
                      }}
                    >
                      🗑️
                    </button>
                  </p>
                )
              }),
            )}
            {Object.entries(topology.mavenParents).map(([id, m]) => (
              <p key={id} className="dep-line">
                {id} ──parent of──▶ {m.children.join(', ')}
              </p>
            ))}
          </section>

          <footer className="config-footer">
            <button className="btn btn-primary" onClick={() => void save()}>💾 保存</button>
            <button
              className="btn"
              onClick={async () => {
                if (!group) return
                try {
                  // export registers the YAML and serves it via the artifact
                  // endpoint (.yaml real-name fix); legacy fallback streams the
                  // file directly when the registry is absent.
                  const res = await api.exportYaml(group)
                  if (typeof res === 'object' && res !== null && typeof res.artifactId === 'string') {
                    downloadFromUrl(artifactUrl(res.artifactId))
                  } else {
                    downloadText(`helmsman-topology-${group}.yaml`, String(res ?? ''))
                  }
                } catch (err) {
                  props.onToast('error', err instanceof Error ? err.message : String(err))
                }
              }}
            >
              📥 导出配置
            </button>
          </footer>
        </div>
      )}

      {editService && topology && (
        <ServiceModal
          service={editService === 'new' ? null : editService}
          topology={topology}
          onClose={() => setEditService(null)}
          onSave={(id, svc) => {
            applyTopology({ ...topology, services: { ...topology.services, [id]: svc } })
            setEditService(null)
          }}
          onDelete={(id) => {
            const next = { ...topology.services }
            delete next[id]
            applyTopology({ ...topology, services: next })
            setEditService(null)
          }}
          onToast={props.onToast}
        />
      )}

      {depModal && topology && (
        <DependencyModal
          services={Object.keys(topology.services)}
          onClose={() => setDepModal(false)}
          onSave={(from, edge) => {
            const rest = { ...topology.restDependencies }
            rest[from] = mergeClientEdge(rest[from] ?? [], edge)
            applyTopology({ ...topology, restDependencies: rest })
            setDepModal(false)
          }}
        />
      )}

      {importModal && (
        <ImportModal
          group={group}
          onToast={props.onToast}
          onClose={() => setImportModal(false)}
          onImported={(topology2, g) => {
            if (g && g !== group) {
              // 切群时信任 effect 重新加载, 消除 setTopology+setGroup 双写的覆盖窗口
              setGroup(g)
              props.onSelectGroup(g)
            } else {
              applyTopology(topology2)
            }
            setImportModal(false)
          }}
        />
      )}
    </aside>
  )
}

function ServiceModal(props: {
  service: string | null
  topology: TopologyPayload
  onClose: () => void
  onSave: (id: string, svc: TopologyPayload['services'][string]) => void
  onDelete: (id: string) => void
  onToast: (kind: Toast['kind'], text: string) => void
}) {
  const existing = props.service ? props.topology.services[props.service] : null
  const [id, setId] = useState(props.service ?? '')
  const [name, setName] = useState(existing?.name ?? props.service ?? '')
  const [localPath, setLocalPath] = useState(existing?.localPath ?? '')
  const [techStack, setTechStack] = useState(existing?.techStack.join(', ') ?? '')
  const [endpoints, setEndpoints] = useState(existing?.apiEndpoints ?? [])
  const [scanning, setScanning] = useState(false)

  return (
    <div className="modal-mask" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal" role="dialog" aria-label="编辑服务">
        <header className="modal-head">
          <h4>{props.service ? `✏️ 编辑服务: ${props.service}` : '➕ 添加服务'}</h4>
          <button className="icon-btn" onClick={props.onClose}>✕</button>
        </header>
        <label className="field">服务名称 <input value={name} onChange={(e) => setName(e.target.value)} placeholder="user-service" /></label>
        <label className="field">服务 ID <input value={id} onChange={(e) => setId(e.target.value)} placeholder="user-service" /></label>
        <label className="field">本地路径 (git 仓库) <input value={localPath} onChange={(e) => setLocalPath(e.target.value)} placeholder="~/workspace/order-platform/user-service" /></label>
        <label className="field">技术栈 <input value={techStack} onChange={(e) => setTechStack(e.target.value)} placeholder="Java 17, Spring Boot 3" /></label>

        <h5>已扫描的 API 端点 ({endpoints.length} 个)</h5>
        <div className="endpoint-list">
          {endpoints.map((ep, i) => (
            <p key={i} className="dep-line">
              <strong>{ep.method}</strong> {ep.path} {ep.handler && <span className="muted small">{ep.handler}</span>}
              <button className="btn btn-sm ghost" onClick={() => setEndpoints(endpoints.filter((_, idx) => idx !== i))}>🗑️</button>
            </p>
          ))}
        </div>
        <div className="modal-actions">
          <button
            className="btn btn-sm"
            disabled={scanning || !localPath}
            onClick={async () => {
              setScanning(true)
              try {
                const res = await api.scanApi(localPath)
                setEndpoints(res.endpoints)
                props.onToast('success', `扫描完成：${res.total} 个端点`)
              } catch (err) {
                props.onToast('error', err instanceof Error ? err.message : String(err))
              } finally {
                setScanning(false)
              }
            }}
          >
            {scanning ? '⏳ 扫描中...' : '🔄 重新扫描'}
          </button>
        </div>
        <footer className="modal-actions">
          <button
            className="btn btn-primary"
            disabled={!id || !name}
            onClick={() =>
              props.onSave(id, {
                name,
                projectId: id,
                techStack: techStack.split(',').map((s) => s.trim()).filter(Boolean),
                apiEndpoints: endpoints,
                localPath,
              })
            }
          >
            💾 保存
          </button>
          {props.service && <button className="btn danger" onClick={() => props.onDelete(props.service!)}>🗑️ 删除此服务</button>}
        </footer>
      </div>
    </div>
  )
}

function DependencyModal(props: {
  services: string[]
  onClose: () => void
  onSave: (from: string, edge: { toServiceId: string; endpoints: string[]; method: string; critical?: boolean }) => void
}) {
  const [from, setFrom] = useState(props.services[0] ?? '')
  const [to, setTo] = useState(props.services[1] ?? props.services[0] ?? '')
  const [method, setMethod] = useState('GET')
  const [path, setPath] = useState('')
  const [critical, setCritical] = useState(false)

  return (
    <div className="modal-mask" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal" role="dialog" aria-label="添加依赖">
        <header className="modal-head">
          <h4>➕ 添加依赖关系</h4>
          <button className="icon-btn" onClick={props.onClose}>✕</button>
        </header>
        <label className="field">依赖类型 <input value="REST API" disabled /></label>
        <label className="field">
          调用方服务
          <select value={from} onChange={(e) => setFrom(e.target.value)}>
            {props.services.map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
        <label className="field">
          被调用方服务
          <select value={to} onChange={(e) => setTo(e.target.value)}>
            {props.services.map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
        {/* 端点明细可选：不填即服务级边（endpoints: []、method: '*'）。
            同一对服务重复添加只会并入既有那一行，不会新增行。 */}
        <details className="dep-details">
          <summary>端点明细（可选）</summary>
          <label className="field">
            HTTP 方法
            <select value={method} onChange={(e) => setMethod(e.target.value)}>
              {['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].map((m) => <option key={m}>{m}</option>)}
            </select>
          </label>
          <label className="field">端点路径 <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/api/users/{id}/orders" /></label>
        </details>
        <label className="field checkbox">
          <input type="checkbox" checked={critical} onChange={(e) => setCritical(e.target.checked)} />
          此依赖为关键路径（影响级联调度优先级）
        </label>
        <footer className="modal-actions">
          <button
            className="btn btn-primary"
            disabled={!from || !to}
            onClick={() =>
              props.onSave(from, {
                toServiceId: to,
                endpoints: path ? [path] : [],
                method: path ? method : SERVICE_LEVEL_METHOD,
                ...(critical ? { critical: true } : {}),
              })
            }
          >
            💾 添加
          </button>
          <button className="btn" onClick={props.onClose}>取消</button>
        </footer>
      </div>
    </div>
  )
}

function ImportModal(props: {
  group: string | null
  onClose: () => void
  onImported: (topology: TopologyPayload, group: string | null) => void
  onToast: (kind: Toast['kind'], text: string) => void
}) {
  const [source, setSource] = useState<'docker-compose' | 'kubernetes' | 'openapi'>('docker-compose')
  const [text, setText] = useState('')
  const [inferDeps, setInferDeps] = useState(true)
  const [preview, setPreview] = useState<ImportPreviewPayload | null>(null)
  const [busy, setBusy] = useState(false)

  const doPreview = async (): Promise<void> => {
    setBusy(true)
    try {
      setPreview(await api.importPreview(source, text, inferDeps))
    } catch (err) {
      props.onToast('error', err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-mask" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="modal wide" role="dialog" aria-label="导入架构">
        <header className="modal-head">
          <h4>📥 导入架构</h4>
          <button className="icon-btn" onClick={props.onClose}>✕</button>
        </header>
        <fieldset className="radio-group">
          <legend>选择导入源</legend>
          {([
            ['docker-compose', 'docker-compose.yml（解析 services 定义）'],
            ['kubernetes', 'Kubernetes Manifest（解析 Deployment + Service）'],
            ['openapi', 'OpenAPI / Swagger（JSON，解析 API 定义）'],
          ] as const).map(([value, label]) => (
            <label key={value} className="radio">
              <input type="radio" checked={source === value} onChange={() => { setSource(value); setPreview(null) }} />
              {label}
            </label>
          ))}
        </fieldset>
        <label className="field">
          文件内容（粘贴或选择文件）
          <textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder="粘贴 docker-compose.yml / K8s manifest / OpenAPI JSON 内容…" />
          <input
            type="file"
            accept=".yml,.yaml,.json,.txt"
            onChange={async (e) => {
              const file = e.target.files?.[0]
              if (file) setText(await file.text())
            }}
          />
        </label>
        <label className="field checkbox">
          <input type="checkbox" checked={inferDeps} onChange={(e) => setInferDeps(e.target.checked)} />
          自动推断服务间依赖关系（基于 depends_on 与容器名称）
        </label>
        {preview && (
          <div className="preview-box">
            <h5>预览解析结果：发现 {preview.services.length} 个服务</h5>
            {preview.services.map((s) => (
              <label key={s.name} className="checkline">
                <input
                  type="checkbox"
                  checked={s.selected}
                  onChange={(e) =>
                    setPreview({
                      ...preview,
                      services: preview.services.map((x) => (x.name === s.name ? { ...x, selected: e.target.checked } : x)),
                    })
                  }
                />
                {s.name} {s.image && <span className="muted small">({s.image})</span>}
              </label>
            ))}
            {preview.dependencies.length > 0 && (
              <p className="muted small">依赖: {preview.dependencies.map((d) => `${d.from}→${d.to}`).join(', ')}</p>
            )}
            {preview.warnings.map((w, i) => (
              <p key={i} className="card-error">{w}</p>
            ))}
          </div>
        )}
        <footer className="modal-actions">
          <button className="btn" disabled={busy || !text.trim()} onClick={() => void doPreview()}>
            {busy ? '解析中...' : '🔍 预览解析结果'}
          </button>
          <button
            className="btn btn-primary"
            disabled={!preview}
            onClick={async () => {
              if (!preview) return
              try {
                let group: string | null = props.group
                if (!group) {
                  group = window.prompt('导入到新项目群，请输入名称：')
                  if (!group) return
                  await api.createGroup(group)
                }
                const { topology } = await api.importApply(group, preview)
                props.onToast('success', `已导入 ${preview.services.filter((s) => s.selected).length} 个服务`)
                props.onImported(topology, group)
              } catch (err) {
                props.onToast('error', err instanceof Error ? err.message : String(err))
              }
            }}
          >
            📥 导入
          </button>
          <button className="btn" onClick={props.onClose}>取消</button>
        </footer>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// approval gate + audit panel (approval-gates / audit-trail)
// ---------------------------------------------------------------------------

const govOverlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,.45)',
  zIndex: 200,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
}

const govPanelStyle: CSSProperties = {
  background: 'var(--bg, #fff)',
  color: 'var(--fg, #1a1a1a)',
  border: '1px solid var(--border, #ddd)',
  borderRadius: 10,
  width: 'min(680px, 92vw)',
  maxHeight: '80vh',
  overflow: 'auto',
  padding: 16,
}

/** Floating governance button with the live pending-confirmation count. */
function GovernanceFab(props: { pendingCount: number; onOpen: () => void }) {
  return (
    <button
      className="gov-fab"
      style={{ position: 'fixed', right: 18, bottom: 18, zIndex: 150, borderRadius: 999, padding: '10px 14px', cursor: 'pointer' }}
      onClick={props.onOpen}
      title="待处理确认与审计"
    >
      🛡️ 治理
      {props.pendingCount > 0 && <strong style={{ marginLeft: 6, color: '#c62828' }}>({props.pendingCount})</strong>}
    </button>
  )
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString()
}

/** Pending approvals (approve/deny) + read-only audit journal view. */
function GovernancePanel(props: {
  onClose: () => void
  onDecided: () => void
  onRefreshAudit: () => Promise<void>
  audit: AuditEntryPayload[] | null
}) {
  const [approvals, setApprovals] = useState<Array<{ approvalId: string; op: string; scope: string; source: string; requestedAt: number; expiresAt: number }>>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      const res = await api.listPendingApprovals()
      setApprovals(res.approvals ?? [])
    } catch {
      setApprovals([])
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const decide = async (approvalId: string, approve: boolean): Promise<void> => {
    setBusy(approvalId)
    try {
      const decision = await api.decideApproval(approvalId, approve)
      if (approve && decision.granted) {
        setMsg(`已批准。一次性令牌：${decision.token}（5 分钟内有效，单次使用）`)
      } else if (!approve) {
        setMsg('已拒绝该确认请求')
      } else if (!decision.granted) {
        setMsg(decision.reason === 'not-found' ? '该确认请求已过期或不存在' : '已拒绝')
      }
      void reload()
      props.onDecided()
      void props.onRefreshAudit()
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div style={govOverlayStyle} role="dialog" aria-label="审批与审计" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div style={govPanelStyle}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>🛡️ 待确认与审计</h3>
          <button className="icon-btn" aria-label="关闭" onClick={props.onClose}>✕</button>
        </div>
        {msg && <p className="toast toast-info" role="status" style={{ padding: 8 }}>{msg}</p>}

        <h4 style={{ marginBottom: 6 }}>待处理确认（{approvals.length}）</h4>
        {approvals.length === 0 ? (
          <p className="muted small">没有挂起的确认请求。</p>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {approvals.map((a) => (
              <li key={a.approvalId} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--border,#eee)' }}>
                <code style={{ flex: 1 }}>{a.op}</code>
                <span className="muted small" style={{ flex: 2 }}>{a.scope}</span>
                <span className="muted small">{a.source}</span>
                <button className="btn btn-sm btn-primary" disabled={busy === a.approvalId} onClick={() => void decide(a.approvalId, true)}>批准</button>
                <button className="btn btn-sm danger" disabled={busy === a.approvalId} onClick={() => void decide(a.approvalId, false)}>拒绝</button>
              </li>
            ))}
          </ul>
        )}

        <h4 style={{ marginBottom: 6 }}>审计日志（只读，追加式 JSONL）</h4>
        <button className="btn btn-sm" onClick={() => void props.onRefreshAudit()}>刷新</button>
        {props.audit === null ? (
          <p className="muted small">加载中…</p>
        ) : props.audit.length === 0 ? (
          <p className="muted small">暂无审计条目。</p>
        ) : (
          <ol style={{ fontSize: 12, maxHeight: '40vh', overflow: 'auto', paddingLeft: 20 }}>
            {[...props.audit].reverse().map((e, i) => (
              <li key={`${e.ts}-${i}`} style={{ marginBottom: 6 }}>
                <span className="muted small">[{fmtTime(e.ts)}]</span>{' '}
                <code>{e.type}:{e.operation}</code> <span className="muted small">{e.scope}</span>
                {e.decision && <em style={{ marginLeft: 6 }}>{e.decision}</em>}
                {e.outcome && <em style={{ marginLeft: 6 }}>{e.outcome}</em>}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// toasts (PRD §4.5)
// ---------------------------------------------------------------------------

function Toasts(props: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toast-stack" aria-live="polite">
      {props.toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} onClick={() => t.kind === 'error' && props.onDismiss(t.id)}>
          <span>
            {t.kind === 'info' ? 'ℹ️ ' : t.kind === 'success' ? '✅ ' : t.kind === 'warning' ? '⚠️ ' : '❌ '}
            {t.text}
          </span>
          {t.kind === 'error' && (
            <button className="toast-close" aria-label="关闭" onClick={() => props.onDismiss(t.id)}>✕</button>
          )}
        </div>
      ))}
    </div>
  )
}

function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/yaml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
