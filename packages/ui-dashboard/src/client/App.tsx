/**
 * Helmsman Dashboard — implements PRD 第 4 章 (UI 交互流程与设计系统规范):
 * 单向数据流, 任务状态机视觉反馈, 项目群配置面板, 七种边缘状态, 暗色主题,
 * 4px 网格, 响应式 3/2/1 列网格。
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import {
  AGENTS,
  AGENT_LABELS,
  USAGE_QUOTA,
  api,
  type AgentRunPayload,
  type AgentRunState,
  type ImportPreviewPayload,
  type StatePayload,
  type TaskPayload,
  type TopologyPayload,
} from './api'

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

let toastSeq = 1

function reducer(state: StateShape, action: Action): StateShape {
  switch (action.type) {
    case 'loaded': {
      const active = action.payload.tasks.some((t) => ['CREATING_WORKTREES', 'RUNNING', 'AGGREGATING'].includes(t.status))
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
      return { ...state, selectedTaskId: action.taskId }
    case 'selectGroup':
      return { ...state, currentGroup: action.group, tasks: [], selectedTaskId: null, loading: true }
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
    configOpen: false,
    theme: window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    isExecuting: false,
  })
  const [isOffline, setOffline] = useState(!navigator.onLine)
  const [search, setSearch] = useState('')

  useEffect(() => {
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

  // polling — fast while tasks are active, slow otherwise (PRD: 保持可见)
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

  useEffect(() => {
    const interval = setInterval(() => void refresh(), state.isExecuting ? 1500 : 5000)
    return () => clearInterval(interval)
  }, [refresh, state.isExecuting])

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

  const filteredTasks = useMemo(() => {
    if (!search.trim()) return state.tasks
    const q = search.trim().toLowerCase()
    return state.tasks.filter((t) => t.prompt.toLowerCase().includes(q) || t.id.includes(q))
  }, [state.tasks, search])

  if (state.loading && state.tasks.length === 0 && state.groups.length === 0) {
    return (
      <div className="app">
        <SkeletonScreen />
      </div>
    )
  }

  return (
    <div className="app">
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
                dispatch({ type: 'selectTask', taskId })
                void refresh()
              }}
            />
            {selectedTask != null && (
              <section className="task-section" aria-label="任务卡片">
                <TaskHeader
                  tasks={filteredTasks}
                  selectedTask={selectedTask}
                  onSelect={(id) => dispatch({ type: 'selectTask', taskId: id })}
                  onDiscard={async (id) => {
                    try {
                      await api.discard(id)
                      toast('success', '已放弃全部 worktree')
                      void refresh()
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
}) {
  const t = props.selectedTask
  const completed = Object.values(t.agents).filter((r) => r.state === 'completed').length
  const total = Object.values(t.agents).length
  const banner =
    t.status === 'AGGREGATING' ? <div className="aggregating-banner">📊 正在对比结果...</div>
    : t.status === 'PARTIAL_FAILED' ? <div className="degraded-banner">⚠️ 部分 Agent 执行失败 ({completed}/{total} 成功)</div>
    : t.status === 'ALL_FAILED' ? <div className="degraded-banner error">❌ 全部 Agent 执行失败</div>
    : t.status === 'CANCELLED' ? <div className="degraded-banner">⏹ 任务已取消</div>
    : null
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
  onToast: (kind: Toast['kind'], text: string) => void
  onRefresh: () => void
}) {
  const { agent, run, task } = props
  const meta = STATE_META[run.state] ?? STATE_META.idle
  const [elapsed, setElapsed] = useState(0)
  const [logOpen, setLogOpen] = useState(false)
  const [log, setLog] = useState('')
  const [logOffset, setLogOffset] = useState(0)

  useEffect(() => {
    if (run.state !== 'running' || run.startedAt == null) return
    const started = typeof run.startedAt === 'number' ? run.startedAt : Date.parse(String(run.startedAt))
    const tick = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(tick)
  }, [run.state, run.startedAt])

  useEffect(() => {
    if (!logOpen || !run) return
    let active = true
    const poll = async (): Promise<void> => {
      try {
        const res = await api.getLog(task.id, agent)
        if (!active) return
        setLog((prev) => {
          if (res.log.length >= logOffset) {
            setLogOffset(res.log.length)
            return res.log
          }
          return prev
        })
      } catch {
        // transient
      }
    }
    void poll()
    const id = setInterval(() => void poll(), 1500)
    return () => {
      active = false
      clearInterval(id)
    }
  }, [logOpen, task.id, agent, logOffset, run])

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
                await api.cancelTask(task.id)
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
          {log || '（暂无输出）'}
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

function ConfigPanel(props: {
  groups: string[]
  currentGroup: string | null
  onClose: () => void
  onSelectGroup: (g: string) => void
  onToast: (kind: Toast['kind'], text: string) => void
}) {
  const [group, setGroup] = useState<string | null>(props.currentGroup)
  const [topology, setTopology] = useState<TopologyPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState<string | null>(null)
  const [editService, setEditService] = useState<string | 'new' | null>(null)
  const [depModal, setDepModal] = useState(false)
  const [importModal, setImportModal] = useState(false)

  useEffect(() => {
    let active = true
    setLoading(true)
    if (group == null) {
      setTopology(null)
      setLoading(false)
      return
    }
    void api
      .loadTopology(group)
      .then((res) => {
        if (!active) return
        setTopology(res.topology)
      })
      .catch(() => props.onToast('error', '❌ 无法加载项目拓扑，请检查网络或配置文件'))
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [group, props])

  const save = async (): Promise<void> => {
    if (!topology) return
    try {
      await api.saveTopology(topology)
      props.onToast('success', '✅ 配置已保存')
    } catch (err) {
      props.onToast('error', err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <aside className="config-panel" role="dialog" aria-label="项目群配置">
      <header className="config-head">
        <h3>⚙️ 项目群配置</h3>
        <button className="icon-btn" onClick={props.onClose} aria-label="关闭">✕</button>
      </header>

      <div className="config-toolbar">
        <select
          value={group ?? ''}
          onChange={(e) => {
            const g = e.target.value || null
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
              if (!window.confirm(`确认删除项目群 "${group}"？`)) return
              await api.deleteGroup(group)
              props.onToast('success', '已删除')
              setGroup(null)
              setTopology(null)
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
              const { topology: t } = await api.createGroup(name)
              setTopology(t)
              setGroup(name)
              props.onSelectGroup(name)
              props.onToast('success', '项目群已创建')
            } catch (err) {
              props.onToast('error', err instanceof Error ? err.message : String(err))
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
                      setTopology({ ...topology, services: next })
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
                        setTopology({
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
              edges.map((edge, i) => (
                <p key={`${from}-${i}`} className="dep-line">
                  {from} ──{edge.method} {edge.endpoints[0] ?? ''}──▶ {edge.toServiceId}
                  {edge.critical && <span className="badge warn">关键路径</span>}
                  <button
                    className="btn btn-sm ghost"
                    onClick={() => {
                      const rest = { ...topology.restDependencies }
                      rest[from] = (rest[from] ?? []).filter((_, idx) => idx !== i)
                      if (rest[from]?.length === 0) delete rest[from]
                      setTopology({ ...topology, restDependencies: rest })
                    }}
                  >
                    🗑️
                  </button>
                </p>
              )),
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
                  const yaml = await api.exportYaml(group)
                  downloadText(`helmsman-topology-${group}.yaml`, yaml)
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
            setTopology({ ...topology, services: { ...topology.services, [id]: svc } })
            setEditService(null)
          }}
          onDelete={(id) => {
            const next = { ...topology.services }
            delete next[id]
            setTopology({ ...topology, services: next })
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
            rest[from] = [...(rest[from] ?? []), edge]
            setTopology({ ...topology, restDependencies: rest })
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
            setTopology(topology2)
            if (g && g !== group) {
              setGroup(g)
              props.onSelectGroup(g)
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
        <label className="field">
          HTTP 方法
          <select value={method} onChange={(e) => setMethod(e.target.value)}>
            {['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].map((m) => <option key={m}>{m}</option>)}
          </select>
        </label>
        <label className="field">端点路径 <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/api/users/{id}/orders" /></label>
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
                method,
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
