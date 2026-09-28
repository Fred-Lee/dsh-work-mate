/**
 * ProposalPanel — the single UI implementation behind every exit (standalone
 * page, better-sidebar tab). Kanban-first (design: rework-panel-ux): three
 * columns mirror the proposal lifecycle, cards carry a status bar and OpenSpec
 * progress rail, details expand in place, creation lives in a modal.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { archiveProposal, createProposal, getProposal, listProposals, startProposal } from './api'
import type { Proposal, ProposalStatusPayload } from './types'
import { GraphView } from './GraphView'
import { PANEL_STYLE } from './styles'

const POLL_MS = 5_000

const STATUS_TONE: Record<Proposal['status'], string> = {
  draft: '#9ca3af',
  executing: '#3b82f6',
  archived: '#22c55e',
}
const COLUMNS: Array<{ status: Proposal['status']; label: string }> = [
  { status: 'draft', label: '提案中' },
  { status: 'executing', label: '执行中' },
  { status: 'archived', label: '已归档' },
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
  const [view, setView] = useState<'board' | 'graph'>('board')
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [details, setDetails] = useState<Record<string, ProposalStatusPayload>>({})
  const [expanded, setExpanded] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [error, setError] = useState('')
  const [projectRootDraft, setProjectRootDraft] = useState(projectRoot ?? '')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const { proposals: list } = await listProposals()
      setProposals(list)
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), POLL_MS)
    return () => window.clearInterval(timer)
  }, [refresh])

  const loadDetail = useCallback(
    async (id: string) => {
      try {
        const detail = await getProposal(id, projectRootDraft || undefined)
        setDetails((prev) => ({ ...prev, [id]: detail }))
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [projectRootDraft],
  )

  const act = useCallback(
    async (id: string, action: 'start' | 'archive') => {
      setBusy(true)
      try {
        if (action === 'start') await startProposal(id)
        else await archiveProposal(id)
        setError('')
        await Promise.all([refresh(), loadDetail(id)])
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(false)
      }
    },
    [refresh, loadDetail],
  )

  const columns = useMemo(
    () =>
      COLUMNS.map((column) => ({
        ...column,
        cards: proposals.filter((proposal) => proposal.status === column.status),
      })),
    [proposals],
  )

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
            <button className={`wm-pill${view === 'graph' ? ' active' : ''}`} type="button" onClick={() => setView('graph')}>
              知识图谱
            </button>
          </div>
          <button className="wm-btn primary" type="button" onClick={() => setCreateOpen(true)}>
            ＋ 新提案
          </button>
        </div>
      </header>

      {error !== '' && <div className="wm-error">{error}</div>}

      {view === 'graph' ? (
        <GraphView projectRoot={projectRootDraft || undefined} />
      ) : (
        <div className="wm-board">
          {columns.map((column) => (
            <section className="wm-col" key={column.status}>
              <header className="wm-col-head">
                <i className="wm-dot" style={{ background: STATUS_TONE[column.status] }} />
                <span>{column.label}</span>
                <span className="wm-col-count">{column.cards.length}</span>
              </header>
              <div className="wm-col-body">
                {column.cards.length === 0 && <div className="wm-col-empty">暂无提案</div>}
                {column.cards.map((proposal) => {
                  const detail = details[proposal.id]
                  const tasks = detail?.openspec?.tasks
                  return (
                    <article
                      className="wm-card"
                      key={proposal.id}
                      onClick={() => setExpanded((prev) => (prev === proposal.id ? null : proposal.id))}
                    >
                      <span className="wm-card-bar" style={{ background: STATUS_TONE[proposal.status] }} />
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
                        <span>{relativeTime(proposal.updatedAt)}</span>
                        {detail?.openspec !== undefined && <span>openspec {detail.openspec.state}</span>}
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
                              <div className="wm-section">
                                <b>Git 关联</b>
                                {detail.commits === undefined ? (
                                  <span>未扫描</span>
                                ) : detail.commits.length === 0 ? (
                                  <span>{detail.gitNote ?? '暂无含 [proposal:<id>] 的提交'}</span>
                                ) : (
                                  <ul>
                                    {detail.commits.map((commit) => (
                                      <li key={commit.hash}>
                                        <code>{commit.short}</code> {commit.subject}
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                              <div className="wm-actions">
                                <button
                                  className="wm-btn mini"
                                  type="button"
                                  disabled={busy || proposal.status !== 'draft'}
                                  onClick={() => void act(proposal.id, 'start')}
                                >
                                  推进执行
                                </button>
                                <button
                                  className="wm-btn mini"
                                  type="button"
                                  disabled={busy || proposal.status !== 'executing'}
                                  onClick={() => void act(proposal.id, 'archive')}
                                >
                                  归档
                                </button>
                              </div>
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

function CreateModal(props: {
  projectRoot: string
  onProjectRoot: (value: string) => void
  onClose: () => void
  onCreated: () => Promise<void>
  onError: (message: string) => void
}): JSX.Element {
  const [title, setTitle] = useState('')
  const [id, setId] = useState('')
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<{ id: string } | null>(null)

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (!title.trim()) return
    setBusy(true)
    try {
      const result = await createProposal({
        title: title.trim(),
        ...(id.trim() ? { id: id.trim() } : {}),
        ...(props.projectRoot.trim() ? { projectRoot: props.projectRoot.trim() } : {}),
      })
      setCreated({ id: result.proposal.id })
      await props.onCreated()
    } catch (cause) {
      props.onError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
      return
    }
    setBusy(false)
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
          <label>项目根（可选，填了才生成 openspec 目录并扫描 Git）</label>
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
