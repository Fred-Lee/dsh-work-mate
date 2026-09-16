/**
 * BoardView — the standalone four-column task kanban (spec task-kanban).
 *
 * Layout: 需求分析 / 规格设计 / 开发实施 / 验收归档 (horizontal scroll below
 * 1200px) + a right-hand card detail drawer. It is a SEPARATE PAGE rather than
 * a sidebar tab because four columns plus a drawer need the width (proposal
 * "独立页面而非侧边栏 Tab").
 *
 * Every stage change goes through `POST api/item/:id/advance`: drag-and-drop and
 * the "推进到下一阶段" button call the SAME route, the card is never moved
 * locally, and a refusal renders the gap list / queueing reason with the card
 * left where it was (design D4/D5). Nothing on this page adjudicates conflicts.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent, FormEvent } from 'react'
import {
  api,
  ASSOCIATION_ICONS,
  ASSOCIATION_LABELS,
  isStage,
  STAGE_LABELS,
  STAGES,
  type AssociationType,
  type BoardCardPayload,
  type BoardEventPayload,
  type ConfigPayload,
  type GateGap,
  type ItemDetailPayload,
  type ResolvedAssociationPayload,
  type RunsPayload,
  type Stage,
  type WipPayload,
} from './api'
import { RunPanel } from './RunPanel'
import { StartRunDialog } from './StartRunDialog'

export interface BoardViewProps {
  className?: string
}

export type SummaryFilter = 'all' | 'has' | 'none'

export interface UrlState {
  repo: string
  stage: Stage | ''
  summary: SummaryFilter
  /** Selected card id — the drawer's source of truth (spec D2). */
  card: string | null
}

/** Reads filter/drawer state out of the query string (`?repo=&stage=&card=`). */
export function readUrlState(search: string): UrlState {
  const params = new URLSearchParams(search)
  const stage = params.get('stage')
  const summary = params.get('summary')
  return {
    repo: params.get('repo') ?? '',
    stage: isStage(stage) ? stage : '',
    summary: summary === 'has' || summary === 'none' ? summary : 'all',
    card: params.get('card'),
  }
}

/** Serializes the state back into a shareable query string. */
export function buildSearch(state: UrlState): string {
  const params = new URLSearchParams()
  if (state.repo) params.set('repo', state.repo)
  if (state.stage) params.set('stage', state.stage)
  if (state.summary !== 'all') params.set('summary', state.summary)
  if (state.card) params.set('card', state.card)
  const qs = params.toString()
  return qs === '' ? '' : `?${qs}`
}

export function BoardView({ className }: BoardViewProps = {}): JSX.Element {
  const [urlState, setUrlState] = useState<UrlState>(() =>
    readUrlState(typeof window === 'undefined' ? '' : window.location.search),
  )
  const [items, setItems] = useState<BoardCardPayload[]>([])
  const [wip, setWip] = useState<WipPayload | null>(null)
  const [config, setConfig] = useState<ConfigPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  /** Last refusal per card — the card greys out and shows the reason. */
  const [refusals, setRefusals] = useState<Record<string, { gaps: GateGap[]; reason: string }>>({})
  const [detail, setDetail] = useState<ItemDetailPayload | null>(null)
  const [runsData, setRunsData] = useState<RunsPayload | null>(null)
  const [migrations, setMigrations] = useState<BoardEventPayload[]>([])
  const [createOpen, setCreateOpen] = useState(false)
  /** Card whose 「▶ 发起执行」 dialog is open (design D4: the card stays put). */
  const [startRunCard, setStartRunCard] = useState<BoardCardPayload | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const dragId = useRef<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await api.listItems()
      setItems(res.items)
      setWip(res.wip)
      setConfig(res.config)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Coarse poll keeps columns / run dots fresh without any state websocket.
  useEffect(() => {
    const ms = config?.pollMs ?? 5_000
    const timer = setInterval(() => void load(), ms)
    return () => clearInterval(timer)
  }, [load, config?.pollMs])

  // Drawer payloads: detail (stage + gate + associations), runs, migration trail.
  useEffect(() => {
    const id = urlState.card
    if (!id) {
      setDetail(null)
      setRunsData(null)
      setMigrations([])
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const [detailRes, runsRes, eventRes] = await Promise.all([
          api.getItem(id),
          api.getRuns(id),
          api.boardEvents({ itemId: id, limit: 5 }).catch(() => ({ events: [] as BoardEventPayload[], available: false })),
        ])
        if (cancelled) return
        setDetail(detailRes)
        setRunsData(runsRes)
        setMigrations(eventRes.events)
      } catch (err) {
        if (!cancelled) setToast(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [urlState.card, refreshKey])

  // URL mirroring: refresh and sharing keep the view (spec 筛选 + D2).
  useEffect(() => {
    if (typeof window === 'undefined') return
    const search = buildSearch(urlState)
    window.history.replaceState(null, '', `${window.location.pathname}${search}`)
  }, [urlState])

  const refresh = useCallback(async (): Promise<void> => {
    await load()
    setRefreshKey((key) => key + 1)
  }, [load])

  const selectCard = useCallback((id: string | null): void => {
    setUrlState((prev) => ({ ...prev, card: id }))
  }, [])

  const patchFilters = useCallback((patch: Partial<Omit<UrlState, 'card'>>): void => {
    setUrlState((prev) => ({ ...prev, ...patch }))
  }, [])

  /**
   * The single stage-migration path. The card is NEVER moved locally: on a
   * refusal the server's gaps/queueing reason are shown and the card stays put.
   */
  const advanceTo = useCallback(
    async (id: string, to: Stage): Promise<void> => {
      const card = items.find((entry) => entry.id === id)
      if (card && card.stage === to) return
      try {
        const res = await api.advance(id, { to })
        if (res.ok) {
          setRefusals((prev) => {
            const next = { ...prev }
            delete next[id]
            return next
          })
          setToast(`已推进到「${STAGE_LABELS[(res.to ?? to) as Stage] ?? to}」`)
        } else {
          const reason = res.queueingReason ?? (res.gaps.map((gap) => gap.label).join('、') || '推进门未满足')
          setRefusals((prev) => ({ ...prev, [id]: { gaps: res.gaps, reason } }))
          setToast(`推进被拒绝:${reason}`)
        }
      } catch (err) {
        setToast(`推进失败:${err instanceof Error ? err.message : String(err)}`)
      } finally {
        await refresh()
      }
    },
    [items, refresh],
  )

  const associate = useCallback(
    async (id: string, association: { type: AssociationType; refId: string; label?: string }): Promise<void> => {
      await api.associate(id, association)
      await refresh()
    },
    [refresh],
  )

  const disassociate = useCallback(
    async (id: string, type: AssociationType, refId: string): Promise<void> => {
      await api.disassociate(id, type, refId)
      await refresh()
    },
    [refresh],
  )

  const saveSummary = useCallback(
    async (id: string, text: string): Promise<void> => {
      await api.updateItem(id, { summary: { text } })
      setToast('摘要已保存')
      await refresh()
    },
    [refresh],
  )

  const saveModule = useCallback(
    async (id: string, module: string): Promise<void> => {
      await api.updateItem(id, { module })
      setToast(`开发作用域已更新:${module || '(整仓库)'}`)
      await refresh()
    },
    [refresh],
  )

  // ---- display filtering (counts follow the visible set) ------------------
  const visible = useMemo(
    () =>
      items.filter((card) => {
        if (urlState.repo && card.repo !== urlState.repo) return false
        if (urlState.stage && card.stage !== urlState.stage) return false
        if (urlState.summary === 'has' && !card.summary) return false
        if (urlState.summary === 'none' && card.summary) return false
        return true
      }),
    [items, urlState.repo, urlState.stage, urlState.summary],
  )

  const counts = useMemo(() => {
    const map = new Map<Stage, number>()
    for (const stage of STAGES) map.set(stage, 0)
    for (const card of visible) map.set(card.stage, (map.get(card.stage) ?? 0) + 1)
    return map
  }, [visible])

  const devGroups = useMemo(() => {
    const groups = new Map<string, BoardCardPayload[]>()
    for (const card of visible) {
      if (card.stage !== 'dev') continue
      const list = groups.get(card.conflictDomain) ?? []
      list.push(card)
      groups.set(card.conflictDomain, list)
    }
    return [...groups.entries()]
      .map(([key, cards]) => ({ key, cards, domain: wip?.domains.find((domain) => domain.key === key) ?? null }))
      .sort((a, b) => (a.key < b.key ? -1 : 1))
  }, [visible, wip])

  /** Column-level aggregate of the visible conflict domains (在跑/上限). */
  const devOccupancy = useMemo(() => {
    const running = devGroups.reduce((sum, group) => sum + (group.domain?.running ?? group.cards.length), 0)
    const limits = devGroups.map((group) => group.domain?.limit ?? null)
    const known = limits.filter((limit): limit is number => typeof limit === 'number')
    return { running, limit: known.length === limits.length && known.length > 0 ? known.reduce((a, b) => a + b, 0) : null }
  }, [devGroups])

  const moduleSuggestions = useMemo(() => {
    const repo = detail?.item.repo
    const set = new Set<string>()
    for (const card of items) {
      if (repo && card.repo !== repo) continue
      if (card.module) set.add(card.module)
    }
    if (detail?.item.module) set.add(detail.item.module)
    return [...set].sort()
  }, [items, detail?.item.repo, detail?.item.module])

  const onCardDragStart = useCallback((event: DragEvent, card: BoardCardPayload): void => {
    dragId.current = card.id
    event.dataTransfer?.setData('text/plain', card.id)
  }, [])

  const onColumnDrop = useCallback(
    (event: DragEvent, stage: Stage): void => {
      event.preventDefault()
      const id = event.dataTransfer?.getData('text/plain') || dragId.current || ''
      dragId.current = null
      if (id) void advanceTo(id, stage)
    },
    [advanceTo],
  )

  const onGapAction = useCallback((gap: GateGap): void => {
    const action = gap.action ?? ''
    if (/^https?:\/\//.test(action) || action.startsWith('/')) {
      window.open(action, '_blank', 'noreferrer')
      return
    }
    if (/merge|合并/i.test(action) || /merge|合并/i.test(gap.label)) {
      const mount = config?.diffMount ?? '/helmsman-diff'
      window.open(`${mount}/`, '_blank', 'noreferrer')
      return
    }
    setToast(`请先补齐:${gap.label}`)
  }, [config?.diffMount])

  /** Same card behaves the same in every column (the entry itself is dev-only). */
  const cardBindings = useCallback(
    (card: BoardCardPayload) => ({
      card,
      selected: urlState.card === card.id,
      refusal: refusals[card.id]?.reason ?? null,
      dashboardMount: config?.dashboardMount ?? '/helmsman-dashboard',
      onSelect: selectCard,
      onDragStart: onCardDragStart,
      onStartRun: setStartRunCard,
    }),
    [urlState.card, refusals, config?.dashboardMount, selectCard, onCardDragStart],
  )

  return (
    <div className={`board-app${className ? ` ${className}` : ''}`} data-role="board">
      <header className="board-topbar" data-role="board-topbar">
        <h1 className="board-title">⚓ 任务看板</h1>
        <div className="board-filters" data-role="filters">
          <label className="filter">
            <span>仓库</span>
            <select
              data-role="filter-repo"
              value={urlState.repo}
              onChange={(event) => patchFilters({ repo: event.target.value })}
            >
              <option value="">全部</option>
              {[...new Set(items.map((card) => card.repo))].sort().map((repo) => (
                <option key={repo} value={repo}>
                  {repo}
                </option>
              ))}
            </select>
          </label>
          <label className="filter">
            <span>阶段</span>
            <select
              data-role="filter-stage"
              value={urlState.stage}
              onChange={(event) => {
                const value = event.target.value
                patchFilters({ stage: isStage(value) ? value : '' })
              }}
            >
              <option value="">全部</option>
              {STAGES.map((stage) => (
                <option key={stage} value={stage}>
                  {STAGE_LABELS[stage]}
                </option>
              ))}
            </select>
          </label>
          <label className="filter">
            <span>对话摘要</span>
            <select
              data-role="filter-summary"
              value={urlState.summary}
              onChange={(event) => patchFilters({ summary: event.target.value as SummaryFilter })}
            >
              <option value="all">全部</option>
              <option value="has">仅含有摘要</option>
              <option value="none">仅含无摘要</option>
            </select>
          </label>
          {urlState.repo || urlState.stage || urlState.summary !== 'all' ? (
            <button
              type="button"
              className="btn btn-sm"
              data-role="filter-clear"
              onClick={() => patchFilters({ repo: '', stage: '', summary: 'all' })}
            >
              清除筛选
            </button>
          ) : null}
        </div>
        <div className="board-actions">
          <button type="button" className="btn btn-primary" data-role="open-create" onClick={() => setCreateOpen(true)}>
            + 新建任务
          </button>
        </div>
      </header>

      {error ? (
        <div className="board-error" data-role="error">
          看板数据加载失败:{error}
          <button type="button" className="btn btn-sm" onClick={() => void load()}>
            重试
          </button>
        </div>
      ) : null}

      <main className="board-columns" data-role="columns">
        {STAGES.map((stage) => (
          <section
            className={`board-column column-${stage}`}
            key={stage}
            data-role="column"
            data-stage={stage}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => onColumnDrop(event, stage)}
          >
            <header className="column-head">
              <span className="column-title">{STAGE_LABELS[stage]}</span>
              <span className="column-count" data-role="column-count" data-stage={stage}>
                {counts.get(stage) ?? 0}
              </span>
              {stage === 'dev' ? (
                <span className="column-wip" data-role="dev-wip" title="在跑 / 上限">
                  在跑 {devOccupancy.running}/{devOccupancy.limit ?? '—'}
                </span>
              ) : null}
            </header>

            {stage === 'dev' ? (
              <div className="column-domains" data-role="wip-domains">
                {devGroups.map((group) => (
                  <span className="wip-domain" data-role="wip-domain" data-key={group.key} key={group.key}>
                    {group.key} {group.domain?.running ?? group.cards.length}/{group.domain?.limit ?? '—'}
                  </span>
                ))}
                {wip && wip.source === 'derived' ? (
                  <span className="muted small" data-role="wip-derived">
                    上限由 board 服务提供(当前为本地统计)
                  </span>
                ) : null}
              </div>
            ) : null}

            <div className="column-body">
              {stage === 'dev'
                ? devGroups.map((group) => (
                    <div className="domain-group" data-role="domain-group" data-key={group.key} key={group.key}>
                      <div className="domain-label">{group.key}</div>
                      {group.cards.map((card) => (
                        <Card key={card.id} {...cardBindings(card)} />
                      ))}
                    </div>
                  ))
                : visible
                    .filter((card) => card.stage === stage)
                    .map((card) => <Card key={card.id} {...cardBindings(card)} />)}
              {loading ? <p className="muted small">加载中…</p> : null}
            </div>
          </section>
        ))}
      </main>

      {urlState.card ? (
        detail ? (
          <ItemDrawer
            detail={detail}
            runs={runsData}
            migrations={migrations}
            refusal={refusals[detail.item.id]?.reason ?? detail.item.queueingReason}
            moduleSuggestions={moduleSuggestions}
            diffMount={config?.diffMount ?? '/helmsman-diff'}
            onClose={() => selectCard(null)}
            onAdvance={(to) => void advanceTo(detail.item.id, to)}
            onSaveSummary={(text) => void saveSummary(detail.item.id, text)}
            onSaveModule={(module) => void saveModule(detail.item.id, module)}
            onAssociate={(association) => associate(detail.item.id, association)}
            onDisassociate={(type, refId) => void disassociate(detail.item.id, type, refId)}
            onGapAction={onGapAction}
            onToast={setToast}
          />
        ) : (
          <aside className="board-drawer" data-role="drawer">
            <p className="muted small">加载详情…</p>
          </aside>
        )
      ) : null}

      {createOpen ? (
        <CreateItemForm
          repos={[...new Set(items.map((card) => card.repo))].sort()}
          onCancel={() => setCreateOpen(false)}
          onCreated={async (id) => {
            await refresh()
            selectCard(id)
          }}
        />
      ) : null}

      {startRunCard ? (
        <StartRunDialog
          card={startRunCard}
          dashboardMount={config?.dashboardMount ?? '/helmsman-dashboard'}
          onCancel={() => setStartRunCard(null)}
          onStarted={async (taskId) => {
            // The card does not move and nothing is written locally: the page
            // only re-reads the server (spec 「只发起、不复制操作」). The run's
            // `runs[]`/SSE timeline is the EXISTING persistence's job.
            setToast(`已发起执行:${taskId} · 取消/重试/审批/合并请去执行看板`)
            await refresh()
          }}
          onOpenCard={() => {
            const id = startRunCard.id
            setStartRunCard(null)
            selectCard(id)
          }}
        />
      ) : null}

      {toast ? (
        <div className="board-toast" data-role="toast" role="status" onClick={() => setToast(null)}>
          {toast}
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

interface CardProps {
  card: BoardCardPayload
  selected: boolean
  refusal: string | null
  /** Dashboard mount — the 「去执行看板」 link target (design D4). */
  dashboardMount: string
  onSelect: (id: string) => void
  onDragStart: (event: DragEvent, card: BoardCardPayload) => void
  /** Opens the 发起执行 dialog; only 第 ③ 列 cards render the entry. */
  onStartRun: (card: BoardCardPayload) => void
}

function Card(props: CardProps): JSX.Element {
  const { card, selected, refusal } = props
  const queueReason = card.queueingReason ?? refusal
  const dotState = queueReason ? 'queued' : card.runState
  const dotLabel = queueReason ? '排队' : card.runStateLabel
  const dashboardHref = `${props.dashboardMount.replace(/\/+$/, '')}/`
  return (
    <article
      className={`board-card${queueReason ? ' is-queued' : ''}${selected ? ' is-selected' : ''}`}
      data-role="card"
      data-id={card.id}
      data-stage={card.stage}
      draggable
      onDragStart={(event) => props.onDragStart(event, card)}
      onClick={() => props.onSelect(card.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') props.onSelect(card.id)
      }}
      role="button"
      tabIndex={0}
    >
      <header className="card-head">
        <span className={`run-dot run-${dotState}`} data-role="run-dot" data-state={dotState} aria-label={`执行状态:${dotLabel}`} />
        <h4 className="card-title" data-role="card-title">
          {card.title}
        </h4>
        <span className="run-state-text" data-role="run-state">
          {dotLabel}
        </span>
      </header>

      {card.summary ? (
        <p className="card-summary" data-role="card-summary">
          {card.summary.text}
        </p>
      ) : (
        <p className="card-summary muted" data-role="card-summary-empty">
          暂无对话摘要
        </p>
      )}

      <footer className="card-foot">
        <span className="card-badges">
          {card.badges.docs > 0 ? (
            <span className="badge" data-role="badge-doc" title="关联文档">
              {ASSOCIATION_ICONS.doc} {card.badges.docs}
            </span>
          ) : null}
          {card.badges.conversations > 0 ? (
            <span className="badge" data-role="badge-conversation" title="关联对话">
              {ASSOCIATION_ICONS.conversation} {card.badges.conversations}
            </span>
          ) : null}
          {card.badges.services > 0 ? (
            <span className="badge" data-role="badge-service" title="关联服务">
              {ASSOCIATION_ICONS.service} {card.badges.services}
            </span>
          ) : null}
        </span>
        <span className="muted small card-repo">
          {card.repo}
          {card.module ? ` · ${card.module}` : ''}
        </span>
      </footer>

      {queueReason ? (
        <div className="card-queue" data-role="card-queue">
          排队:{queueReason}
        </div>
      ) : null}

      {/*
        第 ③ 列专属:发起执行入口 (spec card-start-run). Gated on
        `projectGroup` × ≥1 installed agent — an unmet gate renders the
        「请先在执行看板发起」 hint instead of a button that fails on submit.
        cancel/retry/approval/merge are NOT offered here: the only jump-off is
        the 「去执行看板」 link (design D4).
      */}
      {card.stage === 'dev' ? (
        <div className="card-start-run" data-role="card-start-run">
          {card.startRun.available ? (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              data-role="start-run"
              title="调既有 runParallelTask 起一个新 run(卡片原地不动)"
              onClick={(event) => {
                // the card itself is a click target (it opens the drawer)
                event.stopPropagation()
                props.onStartRun(card)
              }}
            >
              ▶ 发起执行
            </button>
          ) : (
            <span className="card-start-hint" data-role="start-run-hint">
              请先在执行看板发起
              {card.startRun.reason ? (
                <span className="muted small" data-role="start-run-hint-reason">
                  ({card.startRun.reason})
                </span>
              ) : null}
            </span>
          )}
          <a
            className="card-dashboard-link"
            data-role="start-run-dashboard-link"
            href={dashboardHref}
            target="_blank"
            rel="noreferrer"
            title="取消 / 重试 / 审批 / 合并仍在执行看板完成"
            onClick={(event) => event.stopPropagation()}
          >
            去执行看板
          </a>
        </div>
      ) : null}
    </article>
  )
}

// ---------------------------------------------------------------------------
// Detail drawer
// ---------------------------------------------------------------------------

function ItemDrawer(props: {
  detail: ItemDetailPayload
  runs: RunsPayload | null
  migrations: BoardEventPayload[]
  refusal: string | null
  moduleSuggestions: string[]
  diffMount: string
  onClose: () => void
  onAdvance: (to: Stage) => void
  onSaveSummary: (text: string) => void
  onSaveModule: (module: string) => void
  onAssociate: (association: { type: AssociationType; refId: string; label?: string }) => Promise<void> | void
  onDisassociate: (type: AssociationType, refId: string) => void
  onGapAction: (gap: GateGap) => void
  onToast: (message: string) => void
}): JSX.Element {
  const { detail, runs, migrations, moduleSuggestions } = props
  const item = detail.item
  const [draft, setDraft] = useState<string>(item.summary?.text ?? '')
  const [moduleDraft, setModuleDraft] = useState(item.module ?? '')
  const [assocInput, setAssocInput] = useState({ type: 'doc' as AssociationType, refId: '', label: '' })

  // Re-sync the editable fields when the drawer switches to another card.
  useEffect(() => {
    setDraft(item.summary?.text ?? '')
    setModuleDraft(item.module ?? '')
  }, [item.id, item.summary?.text, item.module])

  const grouped = useMemo(() => {
    const map = new Map<AssociationType, ResolvedAssociationPayload[]>()
    for (const assoc of detail.associations) {
      const list = map.get(assoc.type) ?? []
      list.push(assoc)
      map.set(assoc.type, list)
    }
    return map
  }, [detail.associations])

  const next = detail.nextStage
  const nextLabel = detail.nextStageLabel
  const blocked = detail.gate.gaps.length > 0
  const showModuleEditor = item.stage === 'dev' || next === 'dev'

  return (
    <aside className="board-drawer" data-role="drawer" data-item={item.id}>
      <header className="drawer-head">
        <h3 className="drawer-title" data-role="drawer-title">
          {item.title}
        </h3>
        <div className="drawer-sub">
          <span className={`stage-chip stage-${item.stage}`} data-role="drawer-stage">
            {item.stageLabel}
          </span>
          <span className="muted small">
            {item.repo}
            {item.module ? ` · ${item.module}` : ''}
          </span>
          <button type="button" className="btn btn-sm" data-role="drawer-close" onClick={props.onClose}>
            关闭
          </button>
        </div>
      </header>

      <section className="drawer-section">
        <h4>摘要</h4>
        <textarea
          className="summary-input"
          data-role="summary-input"
          rows={3}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="drawer-actions">
          <button type="button" className="btn btn-sm" data-role="summary-save" onClick={() => props.onSaveSummary(draft)}>
            保存摘要
          </button>
          <span className="muted small">
            {item.summary
              ? `来源:${item.summary.generatedBy} · ${new Date(item.summary.at).toLocaleString('zh-CN')}`
              : '暂无摘要'}
          </span>
        </div>
      </section>

      {showModuleEditor ? (
        <section className="drawer-section">
          <h4>开发作用域(冲突域)</h4>
          <div className="drawer-actions">
            <input
              className="module-input"
              data-role="module-input"
              list="board-module-candidates"
              placeholder="模块名,如 user-service"
              value={moduleDraft}
              onChange={(event) => setModuleDraft(event.target.value)}
            />
            <datalist id="board-module-candidates">
              {moduleSuggestions.map((candidate) => (
                <option key={candidate} value={candidate} />
              ))}
            </datalist>
            <button type="button" className="btn btn-sm" data-role="module-save" onClick={() => props.onSaveModule(moduleDraft)}>
              保存作用域
            </button>
          </div>
          <div className="muted small" data-role="module-domain">
            当前冲突域:{item.conflictDomain}
          </div>
        </section>
      ) : null}

      <section className="drawer-section">
        <h4>推进门{nextLabel ? ` · 进入${nextLabel}` : ''}</h4>
        <ul className="gate-list" data-role="gate-list">
          {detail.gate.gaps.length === 0 ? (
            <li className="gate-ok" data-role="gate-ok">
              ✓ 门项已满足
            </li>
          ) : (
            detail.gate.gaps.map((gap) => (
              <li className="gate-gap" data-role="gate-gap" key={gap.key}>
                <span className="gate-blocked">✗ {gap.label}</span>
                {gap.action ? (
                  <button type="button" className="btn btn-sm" data-role="gap-action" onClick={() => props.onGapAction(gap)}>
                    {gap.action}
                  </button>
                ) : null}
              </li>
            ))
          )}
        </ul>
        {props.refusal ? (
          <div className="drawer-refusal" data-role="drawer-refusal">
            上次推进被拒绝:{props.refusal}
          </div>
        ) : null}
        <div className="drawer-actions">
          <button
            type="button"
            className="btn btn-primary"
            data-role="advance"
            disabled={blocked || next === null}
            title={blocked ? '存在未满足的门项' : next ? `推进到${nextLabel}` : '已是最后阶段'}
            onClick={() => next && props.onAdvance(next)}
          >
            {next ? `推进到${nextLabel}` : '已是最后阶段'}
          </button>
        </div>
      </section>

      <section className="drawer-section">
        <h4>关联</h4>
        {(['doc', 'conversation', 'service', 'worktree', 'run', 'artifact'] as AssociationType[]).map((type) => {
          const list = grouped.get(type) ?? []
          return (
            <details
              className={`assoc-group${list.length === 0 ? ' is-empty' : ''}`}
              data-role="assoc-group"
              data-type={type}
              key={type}
              open={list.length > 0}
            >
              <summary>
                {ASSOCIATION_ICONS[type]} {ASSOCIATION_LABELS[type]}({list.length})
              </summary>
              {list.length === 0 ? (
                <p className="muted small">无</p>
              ) : (
                <ul className="assoc-list">
                  {list.map((assoc) => (
                    <li className="assoc-row" data-role="assoc-row" key={`${assoc.type}:${assoc.refId}`}>
                      {assoc.href ? (
                        // Jump-off only: the target tool renders the content,
                        // nothing is copied into this page (spec task-kanban).
                        <a className="assoc-link" data-role="assoc-jump" href={assoc.href} target="_blank" rel="noreferrer">
                          {assoc.label}
                        </a>
                      ) : (
                        <span className="assoc-static" title="该关联无 Web 入口(只读展示引用)">
                          {assoc.label}
                        </span>
                      )}
                      {assoc.dangling ? (
                        <span className="badge badge-dangling" data-role="assoc-dangling" title="引用目标不存在">
                          悬空
                        </span>
                      ) : null}
                      <button
                        type="button"
                        className="assoc-remove"
                        data-role="assoc-remove"
                        title="取消关联"
                        onClick={() => props.onDisassociate(assoc.type, assoc.refId)}
                      >
                        ✕
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </details>
          )
        })}
        <div className="drawer-actions assoc-add">
          <select
            data-role="assoc-type"
            value={assocInput.type}
            onChange={(event) => setAssocInput((prev) => ({ ...prev, type: event.target.value as AssociationType }))}
          >
            {(['doc', 'conversation', 'service', 'worktree', 'run', 'artifact'] as AssociationType[]).map((type) => (
              <option key={type} value={type}>
                {ASSOCIATION_LABELS[type]}
              </option>
            ))}
          </select>
          <input
            data-role="assoc-ref"
            placeholder="引用 id / 路径(不复制内容)"
            value={assocInput.refId}
            onChange={(event) => setAssocInput((prev) => ({ ...prev, refId: event.target.value }))}
          />
          <button
            type="button"
            className="btn btn-sm"
            data-role="assoc-add"
            onClick={() => {
              if (!assocInput.refId.trim()) return
              void props.onAssociate({
                type: assocInput.type,
                refId: assocInput.refId.trim(),
                ...(assocInput.label.trim() ? { label: assocInput.label.trim() } : {}),
              })
              setAssocInput((prev) => ({ ...prev, refId: '' }))
            }}
          >
            关联
          </button>
        </div>
      </section>

      <section className="drawer-section">
        <h4>执行(run)</h4>
        {runs ? (
          <RunPanel
            runs={runs.runs}
            approvals={runs.approvals}
            streamUrlTemplate={runs.streamUrlTemplate}
            pollMs={runs.pollMs}
            historyAvailable={runs.historyAvailable}
            diffMount={runs.diffMount}
            onAssociate={(association) => props.onAssociate(association)}
            onToast={props.onToast}
          />
        ) : (
          <p className="muted small">加载中…</p>
        )}
      </section>

      {migrations.length > 0 ? (
        <section className="drawer-section">
          <h4>阶段迁移留痕</h4>
          <ul className="migration-list" data-role="migration-list">
            {migrations.slice(0, 5).map((event, index) => (
              <li key={index}>
                {`${event.from ?? '?'} → ${event.to ?? '?'}`}
                {typeof event.ts === 'number' ? ` · ${new Date(event.ts).toLocaleString('zh-CN')}` : ''}
                {typeof event.actor === 'string' ? ` · ${event.actor}` : ''}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </aside>
  )
}

// ---------------------------------------------------------------------------
// Create-task form (spec task-kanban 建档入口, page-side fallback D7a)
// ---------------------------------------------------------------------------

export function CreateItemForm(props: {
  repos: string[]
  onCancel: () => void
  onCreated: (id: string) => Promise<void> | void
}): JSX.Element {
  const [title, setTitle] = useState('')
  const [baseRepo, setBaseRepo] = useState('')
  const [projectGroup, setProjectGroup] = useState('')
  const [stage, setStage] = useState<Stage>('requirements')
  const [docPreset, setDocPreset] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [createdId, setCreatedId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!title.trim()) {
      setError('标题不能为空')
      return
    }
    if (!baseRepo.trim() && !projectGroup.trim()) {
      setError('请填写仓库(baseRepo)或项目组(projectGroup)')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await api.createItem({
        title: title.trim(),
        repoScope: {
          ...(baseRepo.trim() ? { baseRepo: baseRepo.trim() } : {}),
          ...(projectGroup.trim() ? { projectGroup: projectGroup.trim() } : {}),
        },
        stage,
        ...(docPreset ? { docPreset: true } : {}),
      })
      setCreatedId(res.item.id)
      await props.onCreated(res.item.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="board-modal" data-role="create-form">
      <form className="board-modal-box" onSubmit={(event) => void submit(event)}>
        <h3>+ 新建任务</h3>
        {createdId ? (
          <div className="create-done" data-role="create-done">
            <p>已创建任务「{title}」,当前阶段:{STAGE_LABELS[stage]}。</p>
            <div className="drawer-actions">
              <button type="button" className="btn btn-primary" data-role="open-created" onClick={() => props.onCreated(createdId)}>
                打开卡片
              </button>
              <button type="button" className="btn" onClick={props.onCancel}>
                完成
              </button>
            </div>
          </div>
        ) : (
          <>
            <label className="field">
              <span>标题 *</span>
              <input data-role="create-title" value={title} onChange={(event) => setTitle(event.target.value)} />
            </label>
            <label className="field">
              <span>仓库(baseRepo)</span>
              <input
                data-role="create-repo"
                list="board-repo-candidates"
                value={baseRepo}
                onChange={(event) => setBaseRepo(event.target.value)}
              />
              <datalist id="board-repo-candidates">
                {props.repos.map((repo) => (
                  <option key={repo} value={repo} />
                ))}
              </datalist>
            </label>
            <label className="field">
              <span>项目组(projectGroup)</span>
              <input data-role="create-group" value={projectGroup} onChange={(event) => setProjectGroup(event.target.value)} />
            </label>
            <label className="field">
              <span>初始阶段</span>
              <select data-role="create-stage" value={stage} onChange={(event) => setStage(event.target.value as Stage)}>
                {STAGES.map((value) => (
                  <option key={value} value={value}>
                    {STAGE_LABELS[value]}
                  </option>
                ))}
              </select>
            </label>
            <label className="field field-check">
              <input
                type="checkbox"
                data-role="create-doc-preset"
                checked={docPreset}
                onChange={(event) => setDocPreset(event.target.checked)}
              />
              <span>用 PRD / 研究预设先生成文档</span>
            </label>
            {error ? (
              <p className="form-error" data-role="create-error">
                {error}
              </p>
            ) : null}
            <div className="drawer-actions">
              <button type="submit" className="btn btn-primary" data-role="create-submit" disabled={busy}>
                创建
              </button>
              <button type="button" className="btn" onClick={props.onCancel}>
                取消
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  )
}

/** Standalone-page entry (the IIFE shell mounts exactly this component). */
export function App(): JSX.Element {
  return <BoardView />
}
