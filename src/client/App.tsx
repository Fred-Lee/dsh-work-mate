/**
 * ProposalPanel — the single UI implementation behind every exit (standalone
 * page, better-sidebar tab). Kanban-first: three columns mirror the proposal
 * lifecycle, cards carry a status bar and OpenSpec progress rail, details
 * expand in place grouped per associated project (multi-service support),
 * creation lives in a modal with a project picker.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives/src/Button.tsx'
import { SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives/src/SegmentedControl.tsx'
import { Tag } from '@deepseek-ai/dsh-client-ui-primitives/src/Tag.tsx'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives/src/StateDot.tsx'
import { PathLabel } from '@deepseek-ai/dsh-client-ui-primitives/src/PathLabel.tsx'
import { DisclosureRow } from '@deepseek-ai/dsh-client-ui-primitives/src/DisclosureRow.tsx'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives/src/Modal.tsx'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives/src/Tooltip.tsx'
import { Pill } from '@deepseek-ai/dsh-client-ui-primitives/src/Pill.tsx'
import { getBands, getMetrics } from './api'
import type { AggregateMetrics, BandEvaluation, BandsPayload } from './types'
import {
  advanceProposal,
  answerTeamQuestion,
  abandonProposal, approvePlan, archiveProposal,
  createProposal,
  getIsolation,
  getProposal,
  getProjectStatus,
  getTeamRun,
  listProposalEvents,
  listProjectBranches,
  listProjects,
  listProposals,
  listTeamRuns,
  getTeamArtifacts,
  type TeamArtifactView,
  listWorkspaceCandidates,
  reconcileProposal,
  rejectMerge,
  registerProject,
  transitionProposal,
  type IsolationPayload,
  type ProjectBranches,
  type RegisteredProject,
  type ProposalEventRow,
  type TeamRunEvent,
  type WorkspaceCandidate,
} from './api'
import type { Proposal, ProposalState, ProposalStatusPayload } from './types'
import type { TeamRun } from '../features/team/types.ts'
import { GraphView } from './GraphView'
import { taskWaves, waveDepth } from './team-waves'
import { PANEL_STYLE } from './styles'

/** Map lifecycle states onto the shared Tag/StateDot palettes. */
function statusTone(status: ProposalState): 'success' | 'info' | 'warning' | 'outline' | 'danger' {
  if (status === 'archived') return 'success'
  if (status === 'merging' || status === 'archiving') return 'info'
  if (status === 'reviewing' || status === 'ready' || status === 'implementing') return 'warning'
  return 'outline'
}

function statusDot(status: ProposalState): 'done' | 'ongoing' | 'warning' | 'idle' | 'error' {
  if (status === 'archived') return 'done'
  if (status === 'implementing' || status === 'merging' || status === 'archiving') return 'ongoing'
  if (status === 'ready' || status === 'reviewing') return 'warning'
  return 'idle'
}

const POLL_MS = 5_000

/** Close an overlay with Escape; a stable, tiny focus-management primitive. */
function useEscape(onClose: () => void): void {
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])
}

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
  const [view, setView] = useState<'board' | 'list' | 'graph' | 'console' | 'team'>(() => initialView())
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
  const [treeOpen, setTreeOpen] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [statusFilter, setStatusFilter] = useState<'active' | 'all' | 'reviewing' | 'archived'>('active')
  const [loading, setLoading] = useState(true)
  const searchRef = useRef<HTMLInputElement>(null)
  const [drawerId, setDrawerId] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  const refresh = useCallback(async () => {
    try {
      const { proposals: list } = await listProposals()
      setProposals(list.filter((proposal) => proposal.abandonedAt === undefined))
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
    setLoading(false)
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
    async (id: string, action: 'advance' | 'back' | 'archive' | 'abandon' | 'plan' | 'reject', to?: ProposalState, force = false) => {
      setBusy(true)
      setPending(`${id}:${action}`)
      try {
        let result: unknown
        if (action === 'archive') {
          let rationale: string | undefined
          if (force) {
            const entered = window.prompt('强制归档理由（必填，会写入审批记录）')
            if (entered === null) throw new Error('已取消强制归档')
            if (entered.trim() === '') throw new Error('强制归档必须写理由')
            rationale = entered.trim()
          }
          result = await archiveProposal(id, force, rationale)
        }
        else if (action === 'plan') {
          await approvePlan(id)
          result = await reconcileProposal(id)
        }
        else if (action === 'reject') {
          const category = window.prompt('退回类型：plan=方案问题，implementation=实现问题', 'implementation')
          if (category === null) throw new Error('已取消退回')
          if (category !== 'plan' && category !== 'implementation') throw new Error('退回类型只能是 plan 或 implementation')
          const rationale = window.prompt('G5 拒绝理由（必填，写入审批记录）')
          if (rationale === null || rationale.trim() === '') throw new Error('G5 拒绝必须写理由')
          result = await rejectMerge(id, category, rationale)
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
                  : action === 'reject'
                    ? '↩️ 已退回 implementing（G5 拒绝已记录）'
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

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      const target = event.target
      const editing =
        target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
      const palette = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k'
      if (editing || (!palette && event.key !== '/')) return
      event.preventDefault()
      searchRef.current?.focus()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

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
    const byStatus = visibleProposals.filter((proposal) => {
      if (statusFilter === 'all') return true
      if (statusFilter === 'active') return proposal.status !== 'archived'
      return proposal.status === statusFilter
    })
    const filtered =
      showArchived || statusFilter === 'archived'
        ? byStatus
        : byStatus.filter((proposal) => proposal.status !== 'archived')
    return [...filtered].sort(
      (left, right) =>
        (left.status === 'archived' ? 1 : 0) - (right.status === 'archived' ? 1 : 0) ||
        right.updatedAt.localeCompare(left.updatedAt),
    )
  }, [visibleProposals, showArchived, statusFilter])

  const hiddenArchived =
    showArchived || statusFilter === 'archived'
      ? 0
      : visibleProposals.filter((proposal) => proposal.status === 'archived').length

  const drawerProposal = drawerId === null ? undefined : proposals.find((proposal) => proposal.id === drawerId)

  return (
    <div className="wm-root">
      <style dangerouslySetInnerHTML={{ __html: PANEL_STYLE }} />

      <header className="wm-header">
        <div className="wm-brand">
          <span className="wm-logo" aria-hidden>WM</span>
          WorkMate
          <span className="wm-count">{proposals.length} 条提案</span>
        </div>
        <div className="wm-toolbar">
          <SegmentedControl
            id="wm-view"
            value={view}
            label="视图"
            options={[
              { value: 'board', label: '看板' },
              { value: 'list', label: '列表' },
              { value: 'team', label: '团队' },
              { value: 'console', label: '控制台' },
              { value: 'graph', label: '知识图谱' },
            ]}
            onChange={(next) => setView(next)}
          />
          <Button variant="primary" size="sm" type="button" onClick={() => setCreateOpen(true)}>
            ＋ 新提案
          </Button>
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
        <label className="wm-context-field">
          <span>状态</span>
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as 'active' | 'all' | 'reviewing' | 'archived')}
          >
            <option value="active">进行中</option>
            <option value="all">全部</option>
            <option value="reviewing">评审中</option>
            <option value="archived">已归档</option>
          </select>
        </label>
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
          ref={searchRef}
          className="wm-search"
          value={search}
          placeholder="搜索提案 / 项目…"
          onChange={(event) => setSearch(event.target.value)}
        />
        <Tooltip label={showArchived ? '隐藏已归档提案' : '显示已归档提案'} side="bottom">
          <Pill active={showArchived} type="button" onClick={() => setShowArchived((prev) => !prev)}>
            {showArchived ? '隐藏已归档' : '显示已归档'}
          </Pill>
        </Tooltip>
        <button className="wm-btn mini" type="button" onClick={() => setTreeOpen(true)}>
          项目树
        </button>
        <button className="wm-btn mini" type="button" onClick={() => setImportOpen(true)}>
          从 Workspace 导入
        </button>
      </div>

      {error !== '' && (
        <div className="wm-error" role="alert" aria-live="polite">
          {error}
        </div>
      )}

      <div className="wm-body">
        {view === 'graph' ? (
          <GraphView projectRoot={projectRootDraft || undefined} />
        ) : view === 'team' ? (
          <TeamView onError={setError} />
        ) : view === 'console' ? (
          <ConsoleView onError={setError} />
        ) : view === 'list' ? (
          <div className="wm-list">
            {loading && proposals.length === 0 && (
              <div className="wm-skeleton-list" aria-label="加载中">
                {[0, 1, 2].map((index) => (
                  <div className="wm-skeleton-row" key={index} />
                ))}
              </div>
            )}
            {!loading && listRows.length === 0 && <div className="wm-empty">没有匹配的提案</div>}
            {listRows.map((proposal) => (
              <button className="wm-list-row" key={proposal.id} type="button" onClick={() => openDrawer(proposal.id)}>
                <div>
                  <h3 className="wm-list-title">{proposal.title}</h3>
                  <div className="wm-card-id">{proposal.id}</div>
                </div>
                <div className="wm-meta">
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <StateDot state={statusDot(proposal.status)} />
                    <Tag tone={statusTone(proposal.status)}>{STATE_META[proposal.status].label}</Tag>
                  </span>
                  <span>{proposal.projects.length > 0 ? proposal.projects.join(' · ') : '未关联项目'}</span>
                  <span>{relativeTime(proposal.updatedAt)}</span>
                </div>
              </button>
            ))}
            {hiddenArchived > 0 && (
              <DisclosureRow
                icon="▸"
                title={`已隐藏 ${hiddenArchived} 条已归档`}
                open={false}
                expandable
                onToggle={() => setShowArchived(true)}
              />
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
                        aria-current={expanded === proposal.id ? 'true' : undefined}
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
                                  {proposal.status === 'merging' && (
                                    <button
                                      className="wm-btn mini"
                                      type="button"
                                      disabled={busy}
                                      title="G5 拒绝：方案问题 → 重走 G1/G2；实现问题 → 生成修复任务"
                                      onClick={() => void act(proposal.id, 'reject')}
                                    >
                                      {pending === `${proposal.id}:reject` ? '退回中…' : 'G5 退回'}
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

      {treeOpen && (
        <ProjectTreeModal
          projects={projects}
          proposals={proposals}
          onClose={() => setTreeOpen(false)}
          onSelect={(name) => {
            setSelectedProject(name)
            setTreeOpen(false)
          }}
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

function TeamView(props: { onError: (message: string) => void }): JSX.Element {
  const [runs, setRuns] = useState<TeamRun[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<{ run: TeamRun; events: TeamRunEvent[] } | null>(null)
  const [artifacts, setArtifacts] = useState<TeamArtifactView[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const response = await listTeamRuns()
      setRuns([...(response.runs ?? [])].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)))
    } catch (cause) {
      props.onError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
    // The error callback is stable enough for this read-only view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function open(id: string): Promise<void> {
    setSelected(id)
    try {
      setDetail(await getTeamRun(id))
      const view = await getTeamArtifacts(id)
      setArtifacts(view.artifacts ?? [])
    } catch (cause) {
      props.onError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  useEffect(() => {
    if (selected === null && runs.length > 0) void open(runs[0]!.id)
    // Auto-select the newest run so the console is not an empty page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs])

  async function answer(runId: string, messageId: string): Promise<void> {
    const reply = window.prompt('回答 worker 的提问（会写回 Run 的 inbox）')
    if (reply === null || reply.trim() === '') return
    try {
      await answerTeamQuestion(runId, messageId, reply)
      await open(runId)
      await refresh()
    } catch (cause) {
      props.onError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const shown = detail?.run ?? runs.find((run) => run.id === selected)

  return (
    <div className="wm-team">
      <div className="wm-team-head">
        <h3>团队 Run</h3>
        <button className="wm-btn mini" type="button" onClick={() => void refresh()}>
          刷新
        </button>
      </div>
      {loading ? (
        <div className="wm-empty">加载中…</div>
      ) : runs.length === 0 ? (
        <div className="wm-empty">还没有团队 Run — 用 workmate_team_plan 从 TASKS.json 创建</div>
      ) : (
        <div className="wm-team-list">
          {runs.map((run) => {
            const done = run.tasks.filter((task) => task.status === 'done').length
            return (
              <button
                className={`wm-team-row${selected === run.id ? ' active' : ''}`}
                key={run.id}
                type="button"
                onClick={() => void open(run.id)}
              >
                <div>
                  <b>{run.id}</b>
                  <div className="wm-card-id">
                    {run.proposalId} · {run.template}
                  </div>
                </div>
                <span className="wm-tier">{run.status}</span>
                <span className="wm-progress-label">
                  {done}/{run.tasks.length} tasks
                </span>
              </button>
            )
          })}
        </div>
      )}

      {shown !== undefined && (
        <div className="wm-team-detail">
          <h4>
            {shown.id} · {shown.status}
          </h4>
          <div className="wm-progress-label">
            {shown.proposalId} · {shown.template} · parallel {shown.budget.maxParallel} · 关键路径 {waveDepth(shown.tasks)} 波 · token {shown.tokensUsed !== undefined ? `${shown.tokensUsed}/${shown.budget.maxTokens}` : '未计量'}
          </div>
          {(shown.inbox ?? [])
            .filter((message) => message.status === 'open' && (message.kind === 'question' || message.kind === 'escalation'))
            .map((message) => (
              <div className="wm-team-question" key={message.id}>
                <b>{message.kind}</b> {message.taskId ?? ''}：{message.body}
                <button className="wm-btn mini" type="button" onClick={() => void answer(shown.id, message.id)}>
                  回答
                </button>
              </div>
            ))}
          <div className="wm-team-roles">
            {[...new Set(shown.tasks.map((task) => task.role))].map((role) => {
              const roleTasks = shown.tasks.filter((task) => task.role === role)
              const active = roleTasks.filter((task) => task.status === 'dispatched' || task.status === 'running').length
              return (
                <span className={`wm-team-role${active > 0 ? ' active' : ''}`} key={role}>
                  {role} · {roleTasks.length}
                  {active > 0 ? ` · 运行 ${active}` : ''}
                </span>
              )
            })}
          </div>
          {shown.tasks.some((task) => task.status === 'dispatched' || task.status === 'running') && (
            <div className="wm-team-current">
              当前 worker：
              {shown.tasks
                .filter((task) => task.status === 'dispatched' || task.status === 'running')
                .map((task) => `${task.id}（${task.role}）`)
                .join('、')}
            </div>
          )}
          <div className="wm-team-waves">
            {taskWaves(shown.tasks).map((wave, index) => (
              <div className="wm-team-wave" key={index}>
                <div className="wm-team-wave-head">波次 {index + 1}</div>
                {wave.map((task) => (
                  <div className={`wm-team-chip ${task.status}`} key={task.id}>
                    {task.id} · {task.role} · {task.status}
                  </div>
                ))}
              </div>
            ))}
          </div>
          <table className="wm-team-table">
            <thead>
              <tr>
                <th>Task</th>
                <th>角色</th>
                <th>状态</th>
                <th>依赖</th>
                <th>Dispatch / 身份 / 报告</th>
                <th>尝试</th>
              </tr>
            </thead>
            <tbody>
              {shown.tasks.map((task) => (
                <tr key={task.id}>
                  <td>{task.id}</td>
                  <td>{task.role}</td>
                  <td>{task.status}</td>
                  <td>{task.dependsOn !== undefined && task.dependsOn.length > 0 ? task.dependsOn.join(', ') : '—'}</td>
                  <td>
                    {(shown.dispatches ?? [])
                      .filter((dispatch) => dispatch.taskId === task.id)
                      .map((dispatch) => `${dispatch.id}${dispatch.sessionId !== undefined ? ` · ${dispatch.sessionId}` : ''}${dispatch.reportPath !== undefined ? ` · ${dispatch.reportPath}` : ''}`)
                      .join(' / ') || '—'}
                  </td>
                  <td>{task.attempts}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {artifacts.length > 0 && (
            <div className="wm-team-artifacts">
              {artifacts.map((artifact) => (
                <details className="wm-team-artifact" key={artifact.name}>
                  <summary>
                    {artifact.name}
                    {artifact.content === undefined ? '（缺失）' : ` · ${artifact.content.length} 字符`}
                  </summary>
                  {artifact.content !== undefined && (
                    <pre className="wm-team-artifact-body">{artifact.content}</pre>
                  )}
                </details>
              ))}
            </div>
          )}
          {detail !== null && detail.events.length > 0 && (
            <div className="wm-team-events">
              {detail.events.map((event, index) => (
                <div key={`${event.at}-${index}`} className="wm-action-note">
                  {event.kind} {event.taskId ?? ''} {event.status ?? ''} {event.detail ?? ''}
                </div>
              ))}
            </div>
          )}
        </div>
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
  onAction: (action: 'advance' | 'back' | 'archive' | 'abandon' | 'plan' | 'reject', to?: ProposalState, force?: boolean) => void
}): JSX.Element {
  const { proposal, detail } = props
  useEscape(props.onClose)
  const [events, setEvents] = useState<ProposalEventRow[]>([])
  useEffect(() => {
    let alive = true
    void listProposalEvents(proposal.id)
      .then((response) => {
        if (alive) setEvents(response.events ?? [])
      })
      .catch(() => {
        if (alive) setEvents([])
      })
    return () => {
      alive = false
    }
  }, [proposal.id])
  const tasks = detail?.openspec?.tasks
  return (
    <div className="wm-drawer-mask" onClick={props.onClose}>
      <aside
        className="wm-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`提案详情：${proposal.title}`}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="wm-drawer-head">
          <div>
            <h3>{proposal.title}</h3>
            <div className="wm-card-id">{proposal.id}</div>
          </div>
          <button className="wm-btn mini" type="button" autoFocus onClick={props.onClose}>
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
            <h4 className="wm-drawer-section">概览</h4>
            {detail.lifecycle !== undefined && (
              <div className="wm-action-note">下一步：{detail.lifecycle.hint}</div>
            )}
            {detail.pendingApproval !== undefined && (
              <div className="wm-tier wm-tier-diagnose">⏳ {detail.pendingApproval.reason}</div>
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

            <h4 className="wm-drawer-section">目标矩阵</h4>
            {(proposal.targets ?? []).length > 0 ? (
              (proposal.targets ?? []).map((target) => (
                <div className="wm-section" key={target.project}>
                  <b>{target.project}</b> @ {target.baseBranch}
                  {target.featureBranch !== undefined && <code style={{ marginLeft: 6 }}>⎇ {target.featureBranch}</code>}
                  {target.baseCommit !== undefined && (
                    <span className="wm-progress-label"> · base {target.baseCommit.slice(0, 8)}</span>
                  )}
                  <div className="wm-progress-label">
                    {target.worktreePath ?? '未创建 worktree'}
                    {target.portRange !== undefined ? ` · ports ${target.portRange.join('/')}` : ''}
                  </div>
                </div>
              ))
            ) : (
              <div className="wm-progress-label">
                {proposal.featureBranch !== undefined ? `⎇ ${proposal.featureBranch}` : '未声明 targets（旧提案）'}
                {proposal.worktreePath !== undefined ? ` · ${proposal.worktreePath}` : ''}
              </div>
            )}

            <h4 className="wm-drawer-section">任务</h4>
            {tasks !== undefined && tasks.total > 0 ? (
              <div>
                <div className="wm-progress-track">
                  <div className="wm-progress-fill" style={{ width: `${Math.round((tasks.done / tasks.total) * 100)}%` }} />
                </div>
                <div className="wm-progress-label">tasks {tasks.done}/{tasks.total}</div>
              </div>
            ) : (
              <div className="wm-progress-label">暂无任务进度</div>
            )}

            <h4 className="wm-drawer-section">审查</h4>
            {(detail.projects ?? []).filter((project) => project.reviewTally !== undefined || project.reviewReport !== undefined).length === 0 ? (
              <div className="wm-progress-label">暂无审查记录</div>
            ) : (
              (detail.projects ?? []).map((project) =>
                project.reviewTally === undefined && project.reviewReport === undefined ? null : (
                  <div className="wm-section" key={`review-${project.project}`}>
                    <b>{project.project}</b>
                    {project.reviewTally !== undefined && (
                      <span className="wm-progress-label">
                        {' '}发现 {project.reviewTally.findings} · 未解 {project.reviewTally.open} · 阻断{' '}
                        {project.reviewTally.blocking}
                      </span>
                    )}
                    {(project.reviewReport?.criticals ?? []).map((issue, index) => (
                      <div key={index} className="wm-progress-label">
                        {issue.resolved ? '✓' : '✖'} CRITICAL: {issue.text}
                      </div>
                    ))}
                  </div>
                ),
              )
            )}
            <h4 className="wm-drawer-section">事件</h4>
            {events.length === 0 ? (
              <div className="wm-progress-label">暂无事件</div>
            ) : (
              <div className="wm-team-events">
                {events.slice(-20).map((event, index) => (
                  <div className="wm-action-note" key={`${event.at}-${index}`}>
                    {event.kind}
                    {event.from !== undefined ? ` ${event.from}→${event.to ?? ''}` : event.to !== undefined ? ` →${event.to}` : ''}
                    {event.reason !== undefined ? ` · ${event.reason}` : ''}
                    {event.detail !== undefined ? ` · ${event.detail}` : ''}
                  </div>
                ))}
              </div>
            )}
            {props.note !== undefined && <div className="wm-action-note">{props.note}</div>}
          </>
        )}

        {detail !== undefined && (
          <div className="wm-drawer-actions">
            {proposal.status === 'reviewing' && (
              <button className="wm-btn mini primary" type="button" disabled={props.busy} onClick={() => props.onAction('plan')}>
                {props.pending === `${proposal.id}:plan` ? '确认中…' : '确认方案'}
              </button>
            )}
            {proposal.status === 'merging' && (
              <button className="wm-btn mini" type="button" disabled={props.busy} onClick={() => props.onAction('reject')}>
                G5 退回
              </button>
            )}
            {detail.lifecycle?.prev !== undefined && (
              <button className="wm-btn mini" type="button" disabled={props.busy} onClick={() => props.onAction('back', detail.lifecycle?.prev)}>
                ‹ 回退到 {STATE_META[detail.lifecycle.prev].label}
              </button>
            )}
            {detail.lifecycle?.next !== undefined && detail.lifecycle.next !== 'archived' && (
              <button className="wm-btn mini primary" type="button" disabled={props.busy} onClick={() => props.onAction('advance')}>
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
        )}
      </aside>
    </div>
  )
}

function ProjectTreeModal(props: {
  projects: RegisteredProject[]
  proposals: Proposal[]
  onClose: () => void
  onSelect: (name: string) => void
}): JSX.Element {
  useEscape(props.onClose)
  const [statuses, setStatuses] = useState<Record<string, { branch: string; dirtyCount: number }>>({})
  useEffect(() => {
    let alive = true
    void Promise.all(
      props.projects.map(async (project) => {
        try {
          const response = await getProjectStatus(project.name)
          return [project.name, response.status] as const
        } catch {
          return [project.name, undefined] as const
        }
      }),
    ).then((entries) => {
      if (!alive) return
      const next: Record<string, { branch: string; dirtyCount: number }> = {}
      for (const [name, status] of entries) {
        if (status !== undefined) next[name] = { branch: status.branch, dirtyCount: status.dirtyCount }
      }
      setStatuses(next)
    })
    return () => {
      alive = false
    }
  }, [props.projects])
  const groups = new Map<string, RegisteredProject[]>()
  for (const project of props.projects) {
    const workspace = project.workspace ?? '未分组'
    groups.set(workspace, [...(groups.get(workspace) ?? []), project])
  }
  return (
    <div className="wm-modal" onClick={props.onClose}>
      <div className="wm-modal-box" onClick={(event) => event.stopPropagation()}>
        <h3>项目树</h3>
        <p className="wm-progress-label">按 DSH Workspace 分组；点击项目过滤列表。</p>
        {props.projects.length === 0 ? (
          <div className="wm-empty">还没有注册项目</div>
        ) : (
          <div className="wm-tree">
            {[...groups.entries()].map(([workspace, projects]) => (
              <div className="wm-tree-group" key={workspace}>
                <div className="wm-tree-group-head">{workspace}</div>
                {projects.map((project) => {
                  const related = props.proposals.filter((proposal) => proposal.projects.includes(project.name))
                  const active = related.filter((proposal) => proposal.status !== 'archived')
                  const worktrees = active.filter((proposal) =>
                    (proposal.targets ?? []).some(
                      (target) => target.project === project.name && target.worktreePath !== undefined,
                    ),
                  )
                  return (
                    <button className="wm-tree-row" key={project.name} type="button" onClick={() => props.onSelect(project.name)}>
                      <div>
                        <b>{project.name}</b>
                        <div className="wm-progress-label">{project.root}</div>
                      </div>
                      <div className="wm-meta">
                        <span>⎇ {statuses[project.name]?.branch ?? project.defaultBranch ?? 'main'}</span>
                        <span>脏 {statuses[project.name]?.dirtyCount ?? '—'}</span>
                        <span>进行中 {active.length}</span>
                        <span>worktree {worktrees.length}</span>
                      </div>
                    </button>
                  )
                })}
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

function ImportProjectsModal(props: {
  onClose: () => void
  onImported: () => Promise<void> | void
  onError: (message: string) => void
}): JSX.Element {
  useEscape(props.onClose)
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
    <Modal
      open
      onClose={props.onClose}
      title="从 DSH Workspace 导入项目"
      closeLabel="关闭"
      footer={
        <Button variant="outline" size="sm" type="button" onClick={props.onClose}>
          关闭
        </Button>
      }
    >
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
                  <PathLabel path={candidate.path} className="wm-import-path" />
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
    </Modal>
  )
}

function CreateModal(props: {
  projectRoot: string
  onProjectRoot: (value: string) => void
  onClose: () => void
  onCreated: () => Promise<void>
  onError: (message: string) => void
}): JSX.Element {
  useEscape(props.onClose)
  const [title, setTitle] = useState('')
  const [id, setId] = useState('')
  const [projects, setProjects] = useState<RegisteredProject[]>([])
  const [checked, setChecked] = useState<string[]>([])
  const [newName, setNewName] = useState('')
  const [newRoot, setNewRoot] = useState('')
  const [newBranch, setNewBranch] = useState('')
  const [newWorkspace, setNewWorkspace] = useState('')
  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [branches, setBranches] = useState<Record<string, ProjectBranches | undefined>>({})
  const [chosen, setChosen] = useState<Record<string, string>>({})
  const [primary, setPrimary] = useState('')
  const [localError, setLocalError] = useState('')
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
      const { project } = await registerProject(newName.trim(), newRoot.trim(), {
        ...(newBranch.trim() !== '' ? { defaultBranch: newBranch.trim() } : {}),
        ...(newWorkspace.trim() !== '' ? { workspace: newWorkspace.trim() } : {}),
      })
      setProjects((prev) => [...prev.filter((p) => p.name !== project.name), project])
      setChecked((prev) => [...prev, project.name])
      setNewName('')
      setNewRoot('')
      setNewBranch('')
      setNewWorkspace('')
    } catch (cause) {
      props.onError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function goBranches(): Promise<void> {
    const selected = projects.filter((project) => checked.includes(project.name))
    if (selected.length === 0) {
      setLocalError('未选择项目：将只创建提案记录，不生成 target/worktree')
      setStep(2)
      return
    }
    setLocalError('')
    setBusy(true)
    try {
      const entries = await Promise.all(
        selected.map(async (project) => {
          const response = await listProjectBranches(project.name).catch(() => undefined)
          return [project.name, response?.branches] as const
        }),
      )
      const nextBranches: Record<string, ProjectBranches | undefined> = {}
      const nextChosen: Record<string, string> = {}
      for (const [name, value] of entries) {
        nextBranches[name] = value
        const project = projects.find((entry) => entry.name === name)
        nextChosen[name] = value?.default ?? project?.defaultBranch ?? 'main'
      }
      setBranches(nextBranches)
      setChosen(nextChosen)
      setPrimary((current) => (checked.includes(current) ? current : checked[0] ?? ''))
      setStep(2)
    } finally {
      setBusy(false)
    }
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (!title.trim() || busy || created !== null) return
    const targets = checked.map((name) => ({
      project: name,
      baseBranch: chosen[name] ?? projects.find((project) => project.name === name)?.defaultBranch ?? 'main',
    }))
    setBusy(true)
    setLocalError('')
    try {
      const result = await createProposal({
        title: title.trim(),
        ...(id.trim() ? { id: id.trim() } : {}),
        ...(checked.length > 0 ? { projects: checked } : {}),
        ...(targets.length > 0 ? { targets, primaryProject: primary !== '' ? primary : targets[0]?.project } : {}),
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

  const featurePreview = `feature/${id.trim() !== '' ? id.trim() : '<id>'}`

  return (
    <div className="wm-modal" onClick={props.onClose}>
      <form
        className="wm-modal-box"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => void submit(event)}
      >
        <h3>＋ 新提案 · 步骤 {step}/3</h3>
        {step === 1 && (
          <>
            <div className="wm-field">
              <label>标题（必填）</label>
              <input autoFocus value={title} placeholder="批量批改 v2.1" onChange={(event) => setTitle(event.target.value)} />
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
                  <PathLabel path={project.root} style={{ color: 'var(--wm-muted)', fontSize: 11 }} />
                </label>
              ))}
              <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
                <input style={{ flex: 1 }} value={newName} placeholder="项目名" onChange={(event) => setNewName(event.target.value)} />
                <input style={{ flex: 2 }} value={newRoot} placeholder="/abs/path/to/project" onChange={(event) => setNewRoot(event.target.value)} />
                <input value={newBranch} placeholder="默认分支（可选）" onChange={(event) => setNewBranch(event.target.value)} />
                <input value={newWorkspace} placeholder="工作区（可选）" onChange={(event) => setNewWorkspace(event.target.value)} />
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
            {localError !== '' && <div className="wm-error-note">{localError}</div>}
          </>
        )}

        {step === 2 && (
          <div className="wm-field">
            <label>每个项目选择基线分支（默认 master/main）</label>
            {checked.map((name) => {
              const value = branches[name]
              const options = value?.local ?? []
              return (
                <label key={name} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
                  <code style={{ minWidth: 90 }}>{name}</code>
                  <select
                    value={chosen[name] ?? value?.default ?? 'main'}
                    onChange={(event) => setChosen((prev) => ({ ...prev, [name]: event.target.value }))}
                  >
                    {(options.length > 0 ? options : [chosen[name] ?? 'main']).map((branch) => (
                      <option key={branch} value={branch}>
                        {branch}
                        {branch === value?.default ? '（默认）' : ''}
                      </option>
                    ))}
                  </select>
                </label>
              )
            })}
          </div>
        )}

        {step === 3 && (
          <div className="wm-field">
            <label>确认主项目、OpenSpec 归属与分支预览</label>
            <label style={{ fontSize: 12 }}>
              主项目：
              <select value={primary} onChange={(event) => setPrimary(event.target.value)}>
                {checked.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <div className="wm-progress-label">OpenSpec 归属：主项目 {primary || checked[0] || '—'}（openspecTargets 可配 all）</div>
            <div className="wm-progress-label">
              分支预览：{checked.map((name) => `${name} @ ${chosen[name] ?? 'main'} → ${featurePreview}`).join('；')}
            </div>
            {created !== null && (
              <div className="wm-ok-note">
                ✓ 已创建 <code>{created.id}</code> —{' '}
                <a href="/workmate/" target="_blank" rel="noreferrer">
                  打开面板
                </a>
              </div>
            )}
          </div>
        )}

        <div className="wm-modal-foot">
          <button className="wm-btn" type="button" onClick={props.onClose}>
            关闭
          </button>
          {step > 1 && step < 3 && (
            <button className="wm-btn" type="button" onClick={() => setStep((step - 1) as 1 | 2)}>
              上一步
            </button>
          )}
          {step === 1 && (
            <button className="wm-btn primary" type="button" disabled={busy} onClick={() => void goBranches()}>
              下一步
            </button>
          )}
          {step === 2 && (
            <button className="wm-btn primary" type="button" onClick={() => setStep(3)}>
              下一步
            </button>
          )}
          {step === 3 && (
            <button className="wm-btn primary" type="submit" disabled={busy || created !== null}>
              创建提案
            </button>
          )}
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
function initialView(): 'board' | 'list' | 'graph' | 'console' | 'team' {
  if (typeof window === 'undefined') return 'list'
  const requested = new URLSearchParams(window.location.search).get('view')
  return requested === 'console' || requested === 'graph' || requested === 'list' || requested === 'team'
    ? requested
    : 'list'
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

/** Band metrics mix durations, ratios and counts; format by metric name. */
function formatBandValue(metric: string, value: number): string {
  if (/time|ms/i.test(metric)) return formatDuration(value)
  if (metric === 'rework' || metric === 'firstPass' || /rate/i.test(metric)) return percent(value)
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

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
              {rows.filter((row) => !row.abandoned).map((row) => (
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
                  <td className="wm-num">{entry.status === 'ok' ? formatBandValue(entry.metric, entry.current) : '—'}</td>
                  <td className="wm-num">{entry.status === 'ok' ? formatBandValue(entry.metric, entry.baseline) : '—'}</td>
                  <td className="wm-num">{entry.status === 'ok' ? formatBandValue(entry.metric, entry.sigma) : '—'}</td>
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
