/**
 * ProposalPanel — the single UI implementation behind every exit (standalone
 * page, better-sidebar tab). Kanban-first: three columns mirror the proposal
 * lifecycle, cards carry a status bar and OpenSpec progress rail, details
 * expand in place grouped per associated project (multi-service support),
 * creation lives in a modal with a project picker.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { getBands, getMetrics } from './api'
import type { AggregateMetrics, BandEvaluation, BandsPayload } from './types'
import {
  advanceProposal,
  abandonProposal, approvePlan, archiveProposal,
  createProposal,
  getIsolation,
  getProposal,
  listProjectBranches,
  listProjects,
  listProposals,
  listWorkspaceCandidates,
  reconcileProposal,
  registerProject,
  transitionProposal,
  type IsolationPayload,
  type ProjectBranches,
  type RegisteredProject,
  type WorkspaceCandidate,
} from './api'
import type { Proposal, ProposalState, ProposalStatusPayload } from './types'
import { GraphView } from './GraphView'
import { PANEL_STYLE } from './styles'

const POLL_MS = 5_000

const STATE_META: Record<Proposal['status'], { label: string; tone: string }> = {
  draft: { label: '需求输入', tone: '#9ca3af' },
  proposing: { label: '提案分支', tone: '#a78bfa' },
  reviewing: { label: '评审中', tone: '#f59e0b' },
  ready: { label: '待实现', tone: '#38bdf8' },
  implementing: { label: '实现中', tone: '#3b82f6' },
  merging: { label: '合并校验', tone: '#818cf8' },
  archiving: { label: '归档中', tone: '#fb923c' },
  archived: { label: '已归档', tone: '#22c55e' },
}
/**
 * Pipeline stages, not a generic kanban: the eight internal states collapse to
 * the five things a human actually acts on (方案 → 待确认 → 执行中 → 待合并 →
 * 已归档). Human gates are G2 (`待确认`) and G5 (`待合并`).
 */
const COLUMNS: Array<{ states: Proposal['status'][]; label: string; tone: string }> = [
  { states: ['draft', 'proposing'], label: '方案', tone: '#a78bfa' },
  { states: ['reviewing'], label: '待确认', tone: '#f59e0b' },
  { states: ['ready', 'implementing'], label: '执行中', tone: '#3b82f6' },
  { states: ['merging', 'archiving'], label: '待合并', tone: '#818cf8' },
  { states: ['archived'], label: '已归档', tone: '#22c55e' },
]

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(diff)) return ''
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return new Date(iso).toLocaleDateString()
}

export function ProposalPanel(props: { projectRoot?: string }): JSX.Element {
  const { projectRoot } = props
  const [view, setView] = useState<'board' | 'list' | 'graph' | 'console'>(() => initialView())
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [details, setDetails] = useState<Record<string, ProposalStatusPayload>>({})
  const [expanded, setExpanded] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [error, setError] = useState('')
  const [projectRootDraft, setProjectRootDraft] = useState(projectRoot ?? '')
  const [busy, setBusy] = useState(false)
  /** `${proposalId}:${action}` currently in flight — drives the button's pending label. */
  const [pending, setPending] = useState('')
  /** Per-proposal outcome line (success or failure), shown on the card itself. */
  const [notes, setNotes] = useState<Record<string, string>>({})
  /** Why a proposal's detail could not be loaded (e.g. its project root no longer exists). */
  const [detailErrors, setDetailErrors] = useState<Record<string, string>>({})
  const [projects, setProjects] = useState<RegisteredProject[]>([])
  const [selectedProject, setSelectedProject] = useState('')
  const [branches, setBranches] = useState<ProjectBranches | undefined>(undefined)
  const [selectedBranch, setSelectedBranch] = useState('')
  const [isolation, setIsolation] = useState<IsolationPayload>({ occupancy: [], conflicts: [] })
  const [importOpen, setImportOpen] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [drawerId, setDrawerId] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  const refresh = useCallback(async () => {
    try {
      const { proposals: list } = await listProposals()
      setProposals(list)
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
    try {
      const next = await getIsolation()
      setIsolation({ occupancy: next.occupancy ?? [], conflicts: next.conflicts ?? [] })
    } catch {
      // Occupancy is advisory; a host without the endpoint keeps the old panel.
    }
  }, [])

  const refreshProjects = useCallback(async () => {
    try {
      const response = await listProjects()
      setProjects(response.projects ?? [])
    } catch {
      setProjects([])
    }
  }, [])

  useEffect(() => {
    void refresh()
    void refreshProjects()
    const timer = window.setInterval(() => void refresh(), POLL_MS)
    return () => window.clearInterval(timer)
  }, [refresh, refreshProjects])

  useEffect(() => {
    if (selectedProject === '') {
      setBranches(undefined)
      setSelectedBranch('')
      return
    }
    let alive = true
    void listProjectBranches(selectedProject)
      .then((response) => {
        if (!alive) return
        setBranches(response.branches)
        setSelectedBranch(response.branches.default ?? response.branches.current)
      })
      .catch(() => {
        if (!alive) return
        setBranches(undefined)
        setSelectedBranch('')
      })
    return () => {
      alive = false
    }
  }, [selectedProject])

  const loadDetail = useCallback(
    async (id: string) => {
      try {
        const detail = await getProposal(id, projectRootDraft || undefined)
        setDetails((prev) => ({ ...prev, [id]: detail }))
        setDetailErrors((prev) => {
          const next = { ...prev }
          delete next[id]
          return next
        })
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        setError(message)
        setDetailErrors((prev) => ({ ...prev, [id]: message }))
      }
    },
    [projectRootDraft],
  )

  const openDrawer = useCallback(
    (id: string) => {
      setDrawerId(id)
      if (details[id] === undefined) void loadDetail(id)
    },
    [details, loadDetail],
  )

  const act = useCallback(
    async (id: string, action: 'advance' | 'back' | 'archive' | 'abandon' | 'plan', to?: ProposalState, force = false) => {
      setBusy(true)
      setPending(`${id}:${action}`)
      try {
        let result: unknown
        if (action === 'archive') result = await archiveProposal(id, force)
        else if (action === 'plan') {
          await approvePlan(id)
          result = await reconcileProposal(id)
        }
        else if (action === 'abandon') {
          const reason = window.prompt('终止原因（必填，写入事件流便于审计）')
          if (reason === null) throw new Error('已取消终止')
          result = await abandonProposal(id, reason)
        }
        else if (action === 'advance') {
          // Gated states are the HUMAN's call: ask for the rationale here, so a
          // panel approval is as auditable as an API one.
          const gate = details[id]?.pendingApproval
          const rationale = gate === undefined ? undefined : (window.prompt(`${gate.reason}\n\n批准理由（可选）`) ?? undefined)
          await advanceProposal(id, rationale)
        }
        else if (to !== undefined) await transitionProposal(id, to)
        else throw new Error('rollback requires an adjacent target state')
        setError('')
        // A silent long-running action reads as "frozen": say what happened, on the card.
        const forced = typeof result === 'object' && result !== null && (result as { forced?: boolean }).forced === true
        setNotes((prev) => ({
          ...prev,
          [id]:
            action === 'archive'
              ? `✅ 归档完成${forced ? '（force：已跳过审查门）' : ''}`
              : action === 'abandon'
                ? '🛑 已终止（记录原因，未跑归档编排）'
                : action === 'plan'
                  ? '✅ 方案已确认（planHash 已记录，方案再改会失效）'
                  : '✅ 状态已更新',
        }))
        await Promise.all([refresh(), loadDetail(id)])
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        setError(message)
        setNotes((prev) => ({ ...prev, [id]: `❌ ${message}` }))
      } finally {
        setBusy(false)
        setPending('')
      }
    },
    [refresh, loadDetail],
  )

  const visibleProposals = useMemo(() => {
    const query = search.trim().toLowerCase()
    return proposals.filter((proposal) => {
      if (selectedProject !== '' && !proposal.projects.includes(selectedProject)) return false
      if (query === '') return true
      return (
        proposal.title.toLowerCase().includes(query) ||
        proposal.id.toLowerCase().includes(query) ||
        proposal.projects.some((project) => project.toLowerCase().includes(query))
      )
    })
  }, [proposals, selectedProject, search])

  const columns = useMemo(
    () =>
      COLUMNS.map((column) => ({
        ...column,
        cards: visibleProposals.filter((proposal) => column.states.includes(proposal.status)),
      })),
    [visibleProposals],
  )

  const listRows = useMemo(() => {
    const filtered = showArchived ? visibleProposals : visibleProposals.filter((proposal) => proposal.status !== 'archived')
    return [...filtered].sort(
      (left, right) =>
        (left.status === 'archived' ? 1 : 0) - (right.status === 'archived' ? 1 : 0) ||
        right.updatedAt.localeCompare(left.updatedAt),
    )
  }, [visibleProposals, showArchived])

  const hiddenArchived = showArchived ? 0 : visibleProposals.filter((proposal) => proposal.status === 'archived').length

  const drawerProposal = drawerId === null ? undefined : proposals.find((proposal) => proposal.id === drawerId)

  return (
    <div className="wm-root">
      <style dangerouslySetInnerHTML={{ __html: PANEL_STYLE }} />

      <header className="wm-header">
        <div className="wm-brand">
          <span className="wm-logo">🛠</span>
          WorkMate
          <span className="wm-count">{proposals.length} 条提案</span>
        </div>
        <div className="wm-toolbar">
          <div className="wm-pills">
            <button className={`wm-pill${view === 'board' ? ' active' : ''}`} type="button" onClick={() => setView('board')}>
              看板
            </button>
            <button className={`wm-pill${view === 'list' ? ' active' : ''}`} type="button" onClick={() => setView('list')}>
              列表
            </button>
            <button className={`wm-pill${view === 'console' ? ' active' : ''}`} type="button" onClick={() => setView('console')}>
              控制台
            </button>
            <button className={`wm-pill${view === 'graph' ? ' active' : ''}`} type="button" onClick={() => setView('graph')}>
              知识图谱
            </button>
          </div>
          <button className="wm-btn primary" type="button" onClick={() => setCreateOpen(true)}>
            ＋ 新提案
          </button>
        </div>
      </header>

      <div className="wm-context">
        <label className="wm-context-field">
          <span>项目</span>
          <select value={selectedProject} onChange={(event) => setSelectedProject(event.target.value)}>
            <option value="">全部项目</option>
            {projects.map((project) => (
              <option key={project.name} value={project.name}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        {selectedProject !== '' && (
          <label className="wm-context-field">
            <span>分支</span>
            <select value={selectedBranch} onChange={(event) => setSelectedBranch(event.target.value)}>
              {(branches?.local ?? []).map((branch) => (
                <option key={branch} value={branch}>
                  {branch}
                </option>
              ))}
            </select>
          </label>
        )}
        {branches?.current !== undefined && branches.current !== '' && (
          <span className="wm-context-meta">当前 ⎇ {branches.current}</span>
        )}
        {selectedProject !== '' && (
          <span className="wm-context-meta">
            {visibleProposals.length}/{proposals.length} 条
          </span>
        )}
        {isolation.conflicts.length > 0 && (
          <span className="wm-tier wm-tier-diagnose" title="同项目同名分支被多个活跃提案占用">
            ⚠ {isolation.conflicts.length} 个分支冲突
          </span>
        )}
        <input
          className="wm-search"
          value={search}
          placeholder="搜索提案 / 项目…"
          onChange={(event) => setSearch(event.target.value)}
        />
        <button className="wm-btn mini" type="button" onClick={() => setShowArchived((prev) => !prev)}>
          {showArchived ? '隐藏已归档' : '显示已归档'}
        </button>
        <button className="wm-btn mini" type="button" onClick={() => setImportOpen(true)}>
          从 Workspace 导入
        </button>
      </div>

      {error !== '' && <div className="wm-error">{error}</div>}

      <div className="wm-body">
        {view === 'graph' ? (
          <GraphView projectRoot={projectRootDraft || undefined} />
        ) : view === 'console' ? (
          <ConsoleView onError={setError} />
        ) : view === 'list' ? (
          <div className="wm-list">
            {listRows.length === 0 && <div className="wm-empty">没有匹配的提案</div>}
            {listRows.map((proposal) => (
              <button className="wm-list-row" key={proposal.id} type="button" onClick={() => openDrawer(proposal.id)}>
                <div>
                  <h3 className="wm-list-title">{proposal.title}</h3>
                  <div className="wm-card-id">{proposal.id}</div>
                </div>
                <div className="wm-meta">
                  <span className="wm-tier" style={{ color: STATE_META[proposal.status].tone }}>
                    {STATE_META[proposal.status].label}
                  </span>
                  <span>{proposal.projects.length > 0 ? proposal.projects.join(' · ') : '未关联项目'}</span>
                  <span>{relativeTime(proposal.updatedAt)}</span>
                </div>
              </button>
            ))}
            {hiddenArchived > 0 && (
              <div className="wm-col-empty">
                已隐藏 {hiddenArchived} 条已归档
                <button className="wm-btn mini" type="button" onClick={() => setShowArchived(true)}>
                  显示
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="wm-board">
            {columns.map((column) => (
              <section className="wm-col" key={column.label}>
                <header className="wm-col-head">
                  <i className="wm-dot" style={{ background: column.tone }} />
                  <span>{column.label}</span>
                  <span className="wm-col-count">{column.cards.length}</span>
                </header>
                <div className="wm-col-body">
                  {column.cards.length === 0 && <div className="wm-col-empty">暂无提案</div>}
                  {column.label === '已归档' && !showArchived && column.cards.length > 0 && (
                    <div className="wm-col-empty">
                      已隐藏 {column.cards.length} 条已归档
                      <button className="wm-btn mini" type="button" onClick={() => setShowArchived(true)}>
                        显示
                      </button>
                    </div>
                  )}
                  {(column.label === '已归档' && !showArchived ? [] : column.cards).map((proposal) => {
                    const detail = details[proposal.id]
                    const tasks = detail?.openspec?.tasks
                    return (
                      <article
                        className="wm-card"
                        key={proposal.id}
                        tabIndex={0}
                        onMouseEnter={() => {
                          if (details[proposal.id] === undefined) void loadDetail(proposal.id)
                        }}
                        onFocus={() => {
                          if (details[proposal.id] === undefined) void loadDetail(proposal.id)
                        }}
                        onClick={() => setExpanded((prev) => (prev === proposal.id ? null : proposal.id))}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            setExpanded((prev) => (prev === proposal.id ? null : proposal.id))
                          }
                        }}
                      >
                        <span className="wm-card-bar" style={{ background: STATE_META[proposal.status].tone }} />
                        <h3 className="wm-card-title">{proposal.title}</h3>
                        <div className="wm-card-id">{proposal.id}</div>
                        {tasks !== undefined && tasks.total > 0 && (
                          <div>
                            <div className="wm-progress-track">
                              <div
                                className="wm-progress-fill"
                                style={{ width: `${Math.round((tasks.done / tasks.total) * 100)}%` }}
                              />
                            </div>
                            <div className="wm-progress-label">
                              tasks {tasks.done}/{tasks.total}
                            </div>
                          </div>
                        )}
                        <div className="wm-meta">
                          <span>{STATE_META[proposal.status].label}</span>
                          <span>{relativeTime(proposal.updatedAt)}</span>
                          {proposal.projects.length > 0 && <span>{proposal.projects.length} 个关联项目</span>}
                          {detail?.pendingApproval !== undefined && (
                            <span className="wm-tier wm-tier-diagnose" title={detail.pendingApproval.reason}>
                              ⏳ 等待人工批准
                            </span>
                          )}
                        </div>

                        {expanded === proposal.id && (
                          <div className="wm-detail" onClick={(event) => event.stopPropagation()}>
                            {detail === undefined ? (
                              <div className="wm-actions">
                                <button className="wm-btn mini" type="button" onClick={() => void loadDetail(proposal.id)}>
                                  加载详情
                                </button>
                              </div>
                            ) : (
                              <>
                                {(detail.projects ?? []).map((project) => (
                                  <div className="wm-section" key={project.project}>
                                    <b>
                                      📦 {project.project}
                                      {project.git !== undefined && project.git.branch !== '' && (
                                        <code style={{ marginLeft: 6 }}>⎇ {project.git.branch}</code>
                                      )}
                                      {project.git?.isWorktree === true && (
                                        <code style={{ marginLeft: 4 }}>worktree</code>
                                      )}
                                    </b>
                                    {project.root === undefined ? (
                                      <span>{project.note ?? '未注册项目根'}</span>
                                    ) : (
                                      <div>
                                        {project.git !== undefined && (
                                          <div className="wm-meta" style={{ marginTop: 2 }}>
                                            <code>{project.git.headShort}</code>
                                            {project.git.dirtyCount > 0 && (
                                              <span>{project.git.dirtyCount} 个未提交变更</span>
                                            )}
                                          </div>
                                        )}
                                        {project.openspec !== undefined && (
                                          <div>
                                            openspec <code>{project.openspec.state}</code>
                                            {project.openspec.tasks !== undefined && (
                                              <span className="wm-progress-label">
                                                {' '}
                                                · tasks {project.openspec.tasks.done}/{project.openspec.tasks.total}
                                              </span>
                                            )}
                                          </div>
                                        )}
                                        {project.commits !== undefined && project.commits.length > 0 && (
                                          <ul>
                                            {project.commits.map((commit) => (
                                              <li key={commit.hash}>
                                                <code>{commit.short}</code> {commit.subject}
                                              </li>
                                            ))}
                                          </ul>
                                        )}
                                      </div>
                                    )}
                                  </div>
                                ))}
                                {(proposal.blockers?.length ?? 0) > 0 && (
                                  <div className="wm-section">
                                    <b>🚧 卡点</b>
                                    {proposal.blockers?.map((blocker) => (
                                      <div
                                        key={blocker.id}
                                        style={{
                                          marginBottom: 4,
                                          color: blocker.status === 'open' ? '#ef4444' : 'var(--wm-muted)',
                                          fontWeight: blocker.status === 'open' ? 600 : 400,
                                        }}
                                      >
                                        {blocker.status === 'open' ? '✖ 待答复' : '✓ 已解除'} <code>{blocker.id}</code>{' '}
                                        {blocker.question}
                                        {blocker.answer !== undefined && <div>↳ {blocker.answer}</div>}
                                      </div>
                                    ))}
                                  </div>
                                )}
                                {(proposal.decisions?.length ?? 0) > 0 && (
                                  <div className="wm-section">
                                    <b>🧭 决策日志</b>
                                    {proposal.decisions?.map((entry) => (
                                      <div key={entry.id} style={{ marginBottom: 4 }}>
                                        <code>{entry.id}</code> {entry.decision}
                                        {entry.supersedes !== undefined && (
                                          <span style={{ color: '#b45309' }}>（推翻 {entry.supersedes}）</span>
                                        )}
                                        <div style={{ color: 'var(--wm-muted)', fontSize: 11 }}>↳ {entry.rationale}</div>
                                      </div>
                                    ))}
                                  </div>
                                )}
                                {(detail.proposal.swarmTasks ?? []).length > 0 && (
                                  <div className="wm-section">
                                    <b>🧩 并行任务</b>
                                    {(detail.proposal.swarmTasks ?? []).map((task) => (
                                      <div key={task.id} className="wm-meta" title={task.writes.join(', ') || '未声明 writes'}>
                                        <span>
                                          [{task.id}] {task.title}
                                        </span>
                                        <span
                                          className={`wm-tier ${
                                            task.status === 'merged'
                                              ? 'wm-tier-normal'
                                              : task.status === 'failed'
                                                ? 'wm-tier-propose'
                                                : task.status === 'running'
                                                  ? 'wm-tier-diagnose'
                                                  : 'wm-tier-log'
                                          }`}
                                        >
                                          {task.status}
                                        </span>
                                        {task.commit !== undefined && <code>{task.commit}</code>}
                                      </div>
                                    ))}
                                    <div className="wm-kpi-note">
                                      每任务一个 worktree + 分支；未 merged 的任务会阻断归档（force 可跳过）。
                                    </div>
                                  </div>
                                )}

                                {detail.proposal.archiveManifest !== undefined && (
                                  <div className="wm-section">
                                    <b>📦 交付物</b>
                                    <div className="wm-kpi-note">
                                      归档于 {detail.proposal.archiveManifest.at}
                                    </div>
                                    {detail.proposal.archiveManifest.projects.map((entry) => (
                                      <div key={entry.project} style={{ marginTop: 4 }}>
                                        <code>{entry.project}</code>
                                        <div className="wm-meta">
                                          <span>{entry.commits.length} 个标记提交</span>
                                          <span>{entry.specsUpdated === true ? 'spec 已更新' : '无 spec 更新'}</span>
                                          <span>{entry.reindexed ? '知识图谱已重建' : '未重建知识图谱'}</span>
                                        </div>
                                        {entry.commits.length > 0 && (
                                          <div className="wm-kpi-note">{entry.commits.slice(0, 6).join(' · ')}</div>
                                        )}
                                        {entry.diffStat !== undefined && <div className="wm-kpi-note">{entry.diffStat}</div>}
                                        {entry.note !== undefined && <div className="wm-kpi-note">{entry.note}</div>}
                                        {entry.drift !== undefined && (
                                          <div className="wm-meta">
                                            <span className={`wm-tier ${entry.drift.undeclared.length === 0 ? 'wm-tier-normal' : 'wm-tier-diagnose'}`}>
                                              漂移 {(entry.drift.driftRatio * 100).toFixed(0)}%
                                            </span>
                                            <span>声明 {entry.drift.declared.length} 项</span>
                                            <span>实际 {entry.drift.actual.length} 个文件</span>
                                          </div>
                                        )}
                                        {entry.drift !== undefined && entry.drift.undeclared.length > 0 && (
                                          <div className="wm-kpi-note">
                                            未声明改动：{entry.drift.undeclared.slice(0, 5).join(' · ')}
                                          </div>
                                        )}
                                        {(entry.artifacts ?? []).length > 0 && (
                                          <div className="wm-kpi-note">
                                            账本 {entry.artifacts?.length} 个工件（sha256 已记录）
                                          </div>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                )}

                                {(detail.projects ?? []).some((p) => p.reviewReport !== undefined) && (
                                  <div className="wm-section">
                                    <b>
                                      🔍 审查报告
                                      <button
                                        className="wm-btn mini"
                                        type="button"
                                        style={{ marginLeft: 6 }}
                                        onClick={() => void loadDetail(proposal.id)}
                                      >
                                        重新审查
                                      </button>
                                    </b>
                                    {(detail.projects ?? []).map((project) =>
                                      project.reviewReport === undefined ? null : (
                                        <div key={project.project} style={{ marginBottom: 6 }}>
                                          <code>{project.project}</code>
                                          {project.reviewTally !== undefined && (
                                            <div className="wm-meta">
                                              {(['CRIT', 'HIGH', 'MED', 'LOW'] as const)
                                                .filter((severity) => (project.reviewTally?.bySeverity[severity]?.total ?? 0) > 0)
                                                .map((severity) => (
                                                  <span key={severity} className="wm-tier wm-tier-log">
                                                    {severity} {project.reviewTally?.bySeverity[severity]?.open}/
                                                    {project.reviewTally?.bySeverity[severity]?.total}
                                                  </span>
                                                ))}
                                              {project.reviewTally.shadow && (
                                                <span className="wm-tier wm-tier-diagnose" title="影子审查者只记录不阻断">
                                                  shadow
                                                </span>
                                              )}
                                              {project.reviewTally.reviewer !== undefined && (
                                                <span>{project.reviewTally.reviewer}</span>
                                              )}
                                            </div>
                                          )}
                                          {project.reviewReport.criticals.map((issue, index) => (
                                            <div
                                              key={index}
                                              style={{ color: issue.resolved ? 'var(--wm-muted)' : '#ef4444', fontWeight: issue.resolved ? 400 : 600 }}
                                            >
                                              {issue.resolved ? '✓' : '✖'} CRITICAL: {issue.text}
                                            </div>
                                          ))}
                                          {project.reviewReport.questions.map((question, index) => (
                                            <div key={index} style={{ color: '#b45309' }}>？疑问：{question}</div>
                                          ))}
                                          {project.reviewReport.confirms.map((confirm, index) => (
                                            <div key={index} style={{ color: 'var(--wm-muted)' }}>✓ {confirm}</div>
                                          ))}
                                        </div>
                                      ),
                                    )}
                                  </div>
                                )}
                                <div className="wm-actions">
                                  {detail.lifecycle !== undefined && (
                                    <span className="wm-progress-label">下一步：{detail.lifecycle.hint}</span>
                                  )}
                                  {proposal.status !== 'archived' && (
                                    <button
                                      className="wm-btn mini"
                                      type="button"
                                      disabled={busy}
                                      title="终止：不跑归档编排（不经审查门），记录原因后置为终态——用于孤儿提案/放弃的变更"
                                      onClick={() => void act(proposal.id, 'abandon')}
                                    >
                                      {pending === `${proposal.id}:abandon` ? '终止中…' : '终止'}
                                    </button>
                                  )}
                                  {detail.lifecycle?.prev !== undefined && (
                                    <button
                                      className="wm-btn mini"
                                      type="button"
                                      disabled={busy}
                                      title="相邻回退（归档回退会把 change 目录搬回 changes/）"
                                      onClick={() => void act(proposal.id, 'back', detail.lifecycle?.prev)}
                                    >
                                      ‹ 回退到 {STATE_META[detail.lifecycle.prev].label}
                                    </button>
                                  )}
                                  {proposal.status === 'reviewing' && (
                                    <button
                                      className="wm-btn mini primary"
                                      type="button"
                                      disabled={busy}
                                      title="确认当前 planHash；方案工件改动后需重新确认"
                                      onClick={() => void act(proposal.id, 'plan')}
                                    >
                                      {pending === `${proposal.id}:plan` ? '确认中…' : '确认方案'}
                                    </button>
                                  )}
                                  {detail.lifecycle?.next !== undefined && detail.lifecycle.next !== 'archived' && (
                                    <button
                                      className="wm-btn mini primary"
                                      type="button"
                                      disabled={busy}
                                      title={detail.lifecycle.hint}
                                      onClick={() => void act(proposal.id, 'advance')}
                                    >
                                      {pending === `${proposal.id}:advance`
                                        ? '推进中…'
                                        : `推进到 ${STATE_META[detail.lifecycle.next].label} ›`}
                                    </button>
                                  )}
                                </div>
                                {/* Archiving only needs the proposal's status: keep these reachable even when
                                    the detail payload fails (deleted project root), so the card is never a dead end. */}
                                {proposal.status === 'archiving' && (
                                  <div className="wm-actions">
                                    <button
                                      className="wm-btn mini primary"
                                      type="button"
                                      disabled={busy}
                                      onClick={() => void act(proposal.id, 'archive')}
                                    >
                                      {pending === `${proposal.id}:archive` ? '归档中…（编排在跑）' : '完成归档'}
                                    </button>
                                    <button
                                      className="wm-btn mini"
                                      type="button"
                                      disabled={busy}
                                      title="只跳过审查门（缺 review.md 或有未解决 CRITICAL）；openspec archive 与 gitnexus 照常执行"
                                      onClick={() => void act(proposal.id, 'archive', undefined, true)}
                                    >
                                      {pending === `${proposal.id}:archive` ? '归档中…' : '强制归档（跳过审查门）'}
                                    </button>
                                  </div>
                                )}
                                {detailErrors[proposal.id] !== undefined && (
                                  <div className="wm-action-note error">
                                    详情加载失败：{detailErrors[proposal.id]}
                                    <button
                                      className="wm-btn mini"
                                      type="button"
                                      style={{ marginLeft: 6 }}
                                      onClick={() => void loadDetail(proposal.id)}
                                    >
                                      重新加载
                                    </button>
                                  </div>
                                )}
                                {notes[proposal.id] !== undefined && (
                                  <div className={`wm-action-note${notes[proposal.id]?.startsWith('❌') === true ? ' error' : ''}`}>
                                    {notes[proposal.id]}
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                        )}
                      </article>
                    )
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>

      {drawerId !== null && drawerProposal !== undefined && (
        <ProposalDrawer
          proposal={drawerProposal}
          detail={details[drawerId]}
          busy={busy}
          pending={pending}
          note={notes[drawerId]}
          onClose={() => setDrawerId(null)}
          onLoad={() => void loadDetail(drawerId)}
          onAction={(action, to, force) => void act(drawerId, action, to, force)}
        />
      )}

      {importOpen && (
        <ImportProjectsModal
          onClose={() => setImportOpen(false)}
          onImported={refreshProjects}
          onError={setError}
        />
      )}

      {createOpen && (
        <CreateModal
          projectRoot={projectRootDraft}
          onProjectRoot={setProjectRootDraft}
          onClose={() => setCreateOpen(false)}
          onCreated={refresh}
          onError={setError}
        />
      )}
    </div>
  )
}

function ProposalDrawer(props: {
  proposal: Proposal
  detail: ProposalStatusPayload | undefined
  busy: boolean
  pending: string
  note?: string
  onClose: () => void
  onLoad: () => void
  onAction: (action: 'advance' | 'back' | 'archive' | 'abandon' | 'plan', to?: ProposalState, force?: boolean) => void
}): JSX.Element {
  const { proposal, detail } = props
  const tasks = detail?.openspec?.tasks
  return (
    <div className="wm-drawer-mask" onClick={props.onClose}>
      <aside className="wm-drawer" onClick={(event) => event.stopPropagation()}>
        <header className="wm-drawer-head">
          <div>
            <h3>{proposal.title}</h3>
            <div className="wm-card-id">{proposal.id}</div>
          </div>
          <button className="wm-btn mini" type="button" onClick={props.onClose}>
            关闭
          </button>
        </header>
        <div className="wm-meta">
          <span>{STATE_META[proposal.status].label}</span>
          <span>{proposal.projects.length > 0 ? proposal.projects.join(' · ') : '未关联项目'}</span>
          <span>{relativeTime(proposal.updatedAt)}</span>
        </div>

        {detail === undefined ? (
          <div className="wm-actions">
            <span className="wm-progress-label">加载详情…</span>
            <button className="wm-btn mini" type="button" onClick={props.onLoad}>
              重新加载
            </button>
          </div>
        ) : (
          <>
            {detail.lifecycle !== undefined && (
              <div className="wm-action-note">下一步：{detail.lifecycle.hint}</div>
            )}
            {detail.pendingApproval !== undefined && (
              <div className="wm-tier wm-tier-diagnose">⏳ {detail.pendingApproval.reason}</div>
            )}
            {tasks !== undefined && tasks.total > 0 && (
              <div>
                <div className="wm-progress-track">
                  <div className="wm-progress-fill" style={{ width: `${Math.round((tasks.done / tasks.total) * 100)}%` }} />
                </div>
                <div className="wm-progress-label">tasks {tasks.done}/{tasks.total}</div>
              </div>
            )}
            {(detail.projects ?? []).map((project) => (
              <div className="wm-section" key={project.project}>
                <b>{project.project}</b>
                {project.git?.branch !== undefined && project.git.branch !== '' && (
                  <code style={{ marginLeft: 6 }}>⎇ {project.git.branch}</code>
                )}
                {project.git?.isWorktree === true && <code style={{ marginLeft: 4 }}>worktree</code>}
                <div className="wm-progress-label">{project.root ?? project.note ?? '未注册项目根'}</div>
              </div>
            ))}
            <div className="wm-actions">
              {proposal.status === 'reviewing' && (
                <button
                  className="wm-btn mini primary"
                  type="button"
                  disabled={props.busy}
                  onClick={() => props.onAction('plan')}
                >
                  {props.pending === `${proposal.id}:plan` ? '确认中…' : '确认方案'}
                </button>
              )}
              {detail.lifecycle?.prev !== undefined && (
                <button className="wm-btn mini" type="button" disabled={props.busy} onClick={() => props.onAction('back', detail.lifecycle?.prev)}>
                  ‹ 回退到 {STATE_META[detail.lifecycle.prev].label}
                </button>
              )}
              {detail.lifecycle?.next !== undefined && detail.lifecycle.next !== 'archived' && (
                <button
                  className="wm-btn mini primary"
                  type="button"
                  disabled={props.busy}
                  onClick={() => props.onAction('advance')}
                >
                  {props.pending === `${proposal.id}:advance`
                    ? '推进中…'
                    : `推进到 ${STATE_META[detail.lifecycle.next].label} ›`}
                </button>
              )}
              {proposal.status === 'archiving' && (
                <>
                  <button className="wm-btn mini primary" type="button" disabled={props.busy} onClick={() => props.onAction('archive')}>
                    {props.pending === `${proposal.id}:archive` ? '归档中…' : '完成归档'}
                  </button>
                  <button className="wm-btn mini" type="button" disabled={props.busy} onClick={() => props.onAction('archive', undefined, true)}>
                    强制归档
                  </button>
                </>
              )}
              {proposal.status !== 'archived' && (
                <button className="wm-btn mini" type="button" disabled={props.busy} onClick={() => props.onAction('abandon')}>
                  终止
                </button>
              )}
            </div>
            {props.note !== undefined && <div className="wm-action-note">{props.note}</div>}
          </>
        )}
      </aside>
    </div>
  )
}

function ImportProjectsModal(props: {
  onClose: () => void
  onImported: () => Promise<void> | void
  onError: (message: string) => void
}): JSX.Element {
  const [candidates, setCandidates] = useState<WorkspaceCandidate[]>([])
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')

  useEffect(() => {
    let alive = true
    void listWorkspaceCandidates()
      .then((response) => {
        if (!alive) return
        setCandidates(response.candidates ?? [])
        if (response.note !== undefined) setNote(response.note)
      })
      .catch((cause: unknown) => {
        if (alive) props.onError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
    // The modal is mounted per open; candidates are intentionally fetched once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function add(candidate: WorkspaceCandidate): Promise<void> {
    setBusy(candidate.path)
    try {
      await registerProject(candidate.suggestedName, candidate.path, { workspace: candidate.workspace })
      await props.onImported()
      setCandidates((prev) => prev.filter((entry) => entry.path !== candidate.path))
    } catch (cause) {
      props.onError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy('')
    }
  }

  return (
    <div className="wm-modal" onClick={props.onClose}>
      <div className="wm-modal-box" onClick={(event) => event.stopPropagation()}>
        <h3>从 DSH Workspace 导入项目</h3>
        <p className="wm-progress-label">只列出 git 仓库；导入后仍可在项目树里改默认分支与工作区。</p>
        {note !== '' && <div className="wm-action-note">{note}</div>}
        {loading ? (
          <div className="wm-empty">加载中…</div>
        ) : candidates.length === 0 ? (
          <div className="wm-empty">没有可导入的 git 仓库</div>
        ) : (
          <div className="wm-import-list">
            {candidates.map((candidate) => (
              <div className="wm-import-row" key={candidate.path}>
                <div>
                  <b>{candidate.title || candidate.name}</b>
                  {candidate.hasOpenspec && <span className="wm-context-meta"> · openspec</span>}
                  <div className="wm-import-path">{candidate.path}</div>
                </div>
                <div className="wm-actions">
                  {candidate.registered ? (
                    <span className="wm-context-meta">已注册为 {candidate.registeredAs}</span>
                  ) : (
                    <button
                      className="wm-btn mini primary"
                      type="button"
                      disabled={busy !== ''}
                      onClick={() => void add(candidate)}
                    >
                      {busy === candidate.path ? '导入中…' : '加入项目'}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="wm-modal-foot">
          <button className="wm-btn" type="button" onClick={props.onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}

function CreateModal(props: {
  projectRoot: string
  onProjectRoot: (value: string) => void
  onClose: () => void
  onCreated: () => Promise<void>
  onError: (message: string) => void
}): JSX.Element {
  const [title, setTitle] = useState('')
  const [id, setId] = useState('')
  const [projects, setProjects] = useState<RegisteredProject[]>([])
  const [checked, setChecked] = useState<string[]>([])
  const [newName, setNewName] = useState('')
  const [newRoot, setNewRoot] = useState('')
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<{ id: string } | null>(null)

  useEffect(() => {
    void listProjects()
      .then(({ projects: list }) => setProjects(list ?? []))
      .catch(() => setProjects([]))
  }, [])

  async function addProject(): Promise<void> {
    if (!newName.trim() || !newRoot.trim()) return
    try {
      const { project } = await registerProject(newName.trim(), newRoot.trim())
      setProjects((prev) => [...prev.filter((p) => p.name !== project.name), project])
      setChecked((prev) => [...prev, project.name])
      setNewName('')
      setNewRoot('')
    } catch (cause) {
      props.onError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (!title.trim() || busy) return
    setBusy(true)
    try {
      const result = await createProposal({
        title: title.trim(),
        ...(id.trim() ? { id: id.trim() } : {}),
        ...(checked.length > 0 ? { projects: checked } : {}),
        ...(props.projectRoot.trim() ? { projectRoot: props.projectRoot.trim() } : {}),
      })
      setCreated({ id: result.proposal.id })
      await props.onCreated()
    } catch (cause) {
      props.onError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="wm-modal" onClick={props.onClose}>
      <form
        className="wm-modal-box"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => void submit(event)}
      >
        <h3>＋ 新提案</h3>
        <div className="wm-field">
          <label>标题（必填）</label>
          <input
            autoFocus
            value={title}
            placeholder="批量批改 v2.1"
            onChange={(event) => setTitle(event.target.value)}
          />
        </div>
        <div className="wm-field">
          <label>id（可选，留空自动生成）</label>
          <input value={id} placeholder="batch-grading-v2" onChange={(event) => setId(event.target.value)} />
        </div>
        <div className="wm-field">
          <label>关联项目（多选，微服务变更可同时勾选多个）</label>
          {projects.length === 0 && <span className="wm-progress-label">还没有注册项目 — 在下方添加。</span>}
          {projects.map((project) => (
            <label key={project.name} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
              <input
                type="checkbox"
                checked={checked.includes(project.name)}
                onChange={(event) =>
                  setChecked((prev) =>
                    event.target.checked ? [...prev, project.name] : prev.filter((name) => name !== project.name),
                  )
                }
              />
              <code>{project.name}</code>
              <span style={{ color: 'var(--wm-muted)', fontSize: 11 }}>{project.root}</span>
            </label>
          ))}
          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            <input style={{ flex: 1 }} value={newName} placeholder="项目名" onChange={(event) => setNewName(event.target.value)} />
            <input style={{ flex: 2 }} value={newRoot} placeholder="/abs/path/to/project" onChange={(event) => setNewRoot(event.target.value)} />
            <button className="wm-btn mini" type="button" onClick={() => void addProject()}>
              注册
            </button>
          </div>
        </div>
        <div className="wm-field">
          <label>单项目根（可选，兼容旧流程；多项目请用上方关联）</label>
          <input
            value={props.projectRoot}
            placeholder="/abs/path/to/project"
            onChange={(event) => props.onProjectRoot(event.target.value)}
          />
        </div>
        {created !== null && (
          <div className="wm-ok-note">
            ✓ 已创建 <code>{created.id}</code> —{' '}
            <a href="/workmate/" target="_blank" rel="noreferrer">
              打开面板
            </a>
          </div>
        )}
        <div className="wm-modal-foot">
          <button className="wm-btn" type="button" onClick={props.onClose}>
            关闭
          </button>
          <button className="wm-btn primary" type="submit" disabled={busy || created !== null}>
            创建提案
          </button>
        </div>
      </form>
    </div>
  )
}

/**
 * Deep-linkable view for the standalone page (`/workmate/?view=console`): the shell
 * ignores the query, the standalone page honours it, screenshots and docs links
 * stay reproducible.
 */
function initialView(): 'board' | 'list' | 'graph' | 'console' {
  if (typeof window === 'undefined') return 'board'
  const requested = new URLSearchParams(window.location.search).get('view')
  return requested === 'console' || requested === 'graph' || requested === 'list' ? requested : 'board'
}

/** Human-readable dwell/cycle duration; unknown (0) stays unknown, never faked. */
function formatDuration(ms: number | undefined): string {
  if (ms === undefined || ms <= 0) return '—'
  const minutes = Math.round(ms / 60000)
  if (minutes < 60) return `${minutes}m`
  const hours = minutes / 60
  if (hours < 24) return `${hours.toFixed(1)}h`
  return `${(hours / 24).toFixed(1)}d`
}

const percent = (value: number): string => `${Math.round(value * 100)}%`

/**
 * Control room: the cross-proposal view of the process facts (change
 * `add-workbench-panel`). Two read-only requests — the aggregate metric
 * projection and the control bands. `insufficient-data` is shown as such: a
 * thin baseline is not "all good", and the UI must not imply otherwise.
 */
export function ConsoleView({ onError }: { onError: (message: string) => void }): JSX.Element {
  const [metrics, setMetrics] = useState<AggregateMetrics | null>(null)
  const [bands, setBands] = useState<BandsPayload | null>(null)
  const [failure, setFailure] = useState('')

  useEffect(() => {
    let alive = true
    // Independent fetches: one failing endpoint must not hide the other's data
    // (a corrupt bands.json would otherwise keep the whole console in "loading").
    void getMetrics()
      .then((nextMetrics) => {
        if (alive) setMetrics(nextMetrics)
      })
      .catch((cause: unknown) => {
        if (!alive) return
        const message = cause instanceof Error ? cause.message : String(cause)
        setFailure(message)
        onError(message)
      })
    void getBands()
      .then((nextBands) => {
        if (alive) setBands(nextBands)
      })
      .catch((cause: unknown) => {
        if (alive) setBands({ windowDays: 0, evaluations: [] })
        void cause
      })
    return () => {
      alive = false
    }
  }, [onError])

  if (metrics === null) {
    return (
      <div className="wm-empty">
        {failure === ''
          ? '加载过程度量…（若长时间停在这里，多半是 /workmate/api/metrics 没通）'
          : `过程度量加载失败：${failure}`}
      </div>
    )
  }

  // Defensive: a partial or older payload renders as empty data. A crash here would
  // blank the whole view, which is exactly what the panel must never do.
  const byState = metrics.byState ?? {}
  void byState // reserved for the next console revision (per-state column)
  const ranking = metrics.gateFailureRanking ?? []
  const actors = metrics.actorShare ?? { agent: 0, human: 0, system: 0 }
  const rows = [...(metrics.perProposal ?? [])].sort((left, right) => left.id.localeCompare(right.id))
  return (
    <div className="wm-console">
      <section className="wm-section">
        <div className="wm-kpis">
          <div className="wm-kpi">
            <div className="wm-kpi-value">{metrics.proposals}</div>
            <div className="wm-kpi-label">提案总数</div>
          </div>
          <div className="wm-kpi">
            <div className="wm-kpi-value">{percent(metrics.reworkRate)}</div>
            <div className="wm-kpi-label">返工率（有过回退）</div>
          </div>
          <div className="wm-kpi">
            <div className="wm-kpi-value">{percent(metrics.firstPassRate)}</div>
            <div className="wm-kpi-label">首次通过率</div>
          </div>
          <div className="wm-kpi">
            <div className="wm-kpi-value">{formatDuration(metrics.cycleTimeMedianMs)}</div>
            <div className="wm-kpi-label">周期时间中位数</div>
          </div>
          <div className="wm-kpi">
            <div className="wm-kpi-value">
              {metrics.archived7d} / {metrics.archived30d}
            </div>
            <div className="wm-kpi-label">近 7 / 30 天归档</div>
          </div>
          <div className="wm-kpi">
            <div className="wm-kpi-value">
              {actors.agent} / {actors.human}
            </div>
            <div className="wm-kpi-label">agent / 人 触发</div>
          </div>
        </div>
        <div className="wm-kpi-note">
          共 {metrics.events} 条事件
          {metrics.skippedLines > 0 ? `，${metrics.skippedLines} 行无法解析（已忽略）` : ''}
          {ranking.length > 0
            ? `；门禁失败最多：${ranking
                .slice(0, 3)
                .map((entry) => `${entry.gate}×${entry.count}`)
                .join('、')}`
            : ''}
        </div>
      </section>

      <section className="wm-section">
        <h3 className="wm-card-title">提案过程</h3>
        {rows.length === 0 ? (
          <div className="wm-empty">还没有提案</div>
        ) : (
          <table className="wm-table">
            <thead>
              <tr>
                <th>提案</th>
                <th>状态</th>
                <th>该状态停留</th>
                <th>周期</th>
                <th className="wm-num">返工</th>
                <th className="wm-num">门禁失败</th>
                <th className="wm-num">未决卡点</th>
                <th className="wm-num">审批</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td title={row.id}>{row.title}</td>
                  <td>{row.status}</td>
                  <td>{formatDuration(row.currentStateMs)}</td>
                  <td>{row.archived ? formatDuration(row.cycleTimeMs) : '—'}</td>
                  <td className="wm-num">{row.reworkCount}</td>
                  <td className="wm-num">{row.gateFailureCount}</td>
                  <td className="wm-num">{row.openBlockers}</td>
                  <td className="wm-num">{row.approvals}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="wm-section">
        <h3 className="wm-card-title">控制带（每提案一个样本）</h3>
        {bands === null ? (
          <div className="wm-empty">加载控制带…</div>
        ) : (
          <table className="wm-table">
            <thead>
              <tr>
                <th>指标</th>
                <th>档位</th>
                <th className="wm-num">当前</th>
                <th className="wm-num">基线</th>
                <th className="wm-num">σ</th>
                <th className="wm-num">偏离</th>
                <th className="wm-num">样本</th>
              </tr>
            </thead>
            <tbody>
              {(bands.evaluations ?? []).map((entry: BandEvaluation) => (
                <tr key={entry.metric}>
                  <td>
                    {entry.metric}
                    <span className="wm-kpi-note"> {entry.direction === 'high' ? '越大越差' : '越小越差'}</span>
                  </td>
                  <td>
                    {entry.status === 'insufficient-data' ? (
                      <span className="wm-tier wm-tier-unknown">数据不足</span>
                    ) : (
                      <span className={`wm-tier wm-tier-${entry.tier}`}>{entry.tier}</span>
                    )}
                  </td>
                  <td className="wm-num">{entry.status === 'ok' ? entry.current.toFixed(2) : '—'}</td>
                  <td className="wm-num">{entry.status === 'ok' ? entry.baseline.toFixed(2) : '—'}</td>
                  <td className="wm-num">{entry.status === 'ok' ? entry.sigma.toFixed(2) : '—'}</td>
                  <td className="wm-num">{entry.status === 'ok' ? `${entry.deviation.toFixed(2)}σ` : '—'}</td>
                  <td className="wm-num">
                    {entry.samples}
                    {entry.status === 'insufficient-data' ? `（基线 ${entry.baselineSamples}）` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="wm-kpi-note">
          窗口 {bands?.windowDays ?? '—'} 天；样本不足时不判越界（"数据不足"不等于正常）。
        </div>
      </section>
    </div>
  )
}
