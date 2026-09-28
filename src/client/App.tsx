/**
 * ProposalPanel — the single UI implementation behind both exits (design D5):
 * the standalone IIFE page and the better-sidebar tab. Polls every 5s (design
 * D5: proposal state is low-frequency; no SSE at M2).
 */
import { useCallback, useEffect, useState } from 'react'
import { archiveProposal, createProposal, getProposal, listProposals, startProposal } from './api'
import type { Proposal, ProposalStatusPayload } from './types'
import { GraphView } from './GraphView'
import { PANEL_STYLE } from './styles'

const POLL_MS = 5_000

const STATUS_LABEL: Record<Proposal['status'], string> = {
  draft: '提案中',
  executing: '执行中',
  archived: '已归档',
}

export function ProposalPanel(props: { projectRoot?: string }): JSX.Element {
  const { projectRoot } = props
  const [view, setView] = useState<'proposals' | 'graph'>('proposals')
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [details, setDetails] = useState<Record<string, ProposalStatusPayload>>({})
  const [error, setError] = useState('')
  const [form, setForm] = useState({ id: '', title: '', projectRoot: projectRoot ?? '' })
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
        const detail = await getProposal(id, form.projectRoot || undefined)
        setDetails((prev) => ({ ...prev, [id]: detail }))
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    },
    [form.projectRoot],
  )

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault()
      if (!form.id.trim() || !form.title.trim()) {
        setError('id 与标题必填')
        return
      }
      setBusy(true)
      try {
        await createProposal({
          id: form.id.trim(),
          title: form.title.trim(),
          ...(form.projectRoot.trim() ? { projectRoot: form.projectRoot.trim() } : {}),
        })
        setForm((prev) => ({ ...prev, id: '', title: '' }))
        setError('')
        await refresh()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(false)
      }
    },
    [form, refresh],
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

  return (
    <div className="wm-root">
      <style dangerouslySetInnerHTML={{ __html: PANEL_STYLE }} />
      <div className="wm-header">
        <h2>🛠 WorkMate</h2>
        <span className="wm-count">{proposals.length} 条提案</span>
        <span className="wm-tabs">
          <button className={`wm-btn${view === 'proposals' ? ' active' : ''}`} type="button" onClick={() => setView('proposals')}>
            提案
          </button>
          <button className={`wm-btn${view === 'graph' ? ' active' : ''}`} type="button" onClick={() => setView('graph')}>
            知识图谱
          </button>
        </span>
      </div>

      {view === 'graph' ? (
        <GraphView projectRoot={form.projectRoot.trim() || undefined} />
      ) : (
        <>
      <form className="wm-form" onSubmit={(event) => void submit(event)}>
        <label>
          ID
          <input
            value={form.id}
            placeholder="batch-grading-v2"
            onChange={(event) => setForm((prev) => ({ ...prev, id: event.target.value }))}
          />
        </label>
        <label>
          标题
          <input
            value={form.title}
            placeholder="批量批改 v2.1"
            onChange={(event) => setForm((prev) => ({ ...prev, title: event.target.value }))}
          />
        </label>
        <label>
          项目根（可选，填了才生成 openspec 目录并扫描 Git）
          <input
            value={form.projectRoot}
            placeholder="/abs/path/to/project"
            onChange={(event) => setForm((prev) => ({ ...prev, projectRoot: event.target.value }))}
          />
        </label>
        <button className="wm-btn primary" type="submit" disabled={busy}>
          创建提案
        </button>
      </form>

      {error !== '' && <div className="wm-error">{error}</div>}

      {proposals.length === 0 && <div className="wm-empty">还没有提案 — 用上面表单或 Agent 工具创建。</div>}

      {proposals.map((proposal) => {
        const detail = details[proposal.id]
        return (
          <div className="wm-card" key={proposal.id}>
            <div className="wm-title-row">
              <span className={`wm-badge ${proposal.status}`}>{STATUS_LABEL[proposal.status]}</span>
              <span className="wm-title">{proposal.title}</span>
              <span className="wm-id">{proposal.id}</span>
            </div>
            <div className="wm-meta">
              openspec: {proposal.openspecChangeId} · 更新于 {new Date(proposal.updatedAt).toLocaleString()}
            </div>

            {detail === undefined ? (
              <div className="wm-actions">
                <button className="wm-btn" type="button" onClick={() => void loadDetail(proposal.id)}>
                  加载详情
                </button>
              </div>
            ) : (
              <div className="wm-detail">
                <div className="wm-section">
                  OpenSpec：
                  {detail.openspec === undefined ? (
                    <span>未关联项目</span>
                  ) : (
                    <span>
                      <code>{detail.openspec.state}</code>
                      {detail.openspec.tasks !== undefined && (
                        <span className="wm-progress">
                          {' '}
                          · tasks {detail.openspec.tasks.done}/{detail.openspec.tasks.total}
                        </span>
                      )}
                    </span>
                  )}
                </div>
                <div className="wm-section">
                  Git 关联：
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
              </div>
            )}

            <div className="wm-actions">
              <button
                className="wm-btn"
                type="button"
                disabled={busy || proposal.status !== 'draft'}
                onClick={() => void act(proposal.id, 'start')}
              >
                推进执行
              </button>
              <button
                className="wm-btn"
                type="button"
                disabled={busy || proposal.status !== 'executing'}
                onClick={() => void act(proposal.id, 'archive')}
              >
                归档
              </button>
            </div>
          </div>
        )
      })}
        </>
      )}
    </div>
  )
}
