/**
 * 任务视图（change `adopt-superagent-openspec-source`, task 10）。
 *
 * 四列看板 + 新建待办 + 详情抽屉。三条纪律：
 *   1. 列的归属只来自服务端投影（`/api/tasks` 的 lane/substate），前端不推断阶段；
 *   2. 每张卡只有一个主按钮（按子状态选），不给"统一处理"之类的含糊动作；
 *   3. 离线/未知态如实显示，不假装完成。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Btn, Modal, Pill, StateDot, Tag, Tooltip } from './controls'
import {
  assignTask,
  createTask,
  getTaskBoard,
  listLeftoverWorktrees,
  reclaimWorktree,
  reopenTask,
  replyTask,
  retryTask,
  stopTask,
  type TaskBoardView,
  type TaskCardView,
} from './api'
import type { PanelLane } from '../features/superagent/project.ts'
// 列的标题/提示与子状态文案只有一份真源（服务端投影旁）：本地再抄一份时，
// 改文案要改两处、漏一处就静默漂移（整体体检 #6）。
import { LANES, SUBSTATE_LABEL } from '../features/superagent/project.ts'

const TONE: Record<PanelLane, 'info' | 'success' | 'warning' | 'outline'> = {
  todo: 'info',
  working: 'success',
  attention: 'warning',
  done: 'outline',
}

/**
 * 卡片与抽屉共用的紧凑时间：`2026-11-09T08:57:45.336Z` → `11-09 08:57`。
 * 长度不足 16 时原样返回，避免一个异常字段把整张卡渲染成 undefined。
 */
function compactTime(iso: string): string {
  return iso.length >= 16 ? iso.slice(5, 16).replace('T', ' ') : iso
}

/** 每张卡只有一个主按钮：按子状态选，绝不并列两个"该怎么办"。 */
export function primaryActionOf(card: TaskCardView): { kind: 'assign' | 'retry' | 'reply' | 'review' | 'reopen' | 'none'; label: string } {
  if (card.lane === 'todo') {
    // 判据取投影给的 substate，不看 task.abandoned：阶段归属只来自服务端
    // （本文件头第 1 条纪律），前端重复推断迟早与投影漂移。
    return card.substate === 'stopped'
      ? { kind: 'reopen', label: '重新打开' }
      : { kind: 'assign', label: card.connectable ? '指派' : '仓库未接入' }
  }
  if (card.lane === 'attention') {
    if (card.substate === 'review') return { kind: 'review', label: '去验收' }
    if (card.substate === 'blocked' || card.substate === 'failed' || card.substate === 'delivery') {
      return { kind: 'retry', label: '重试' }
    }
    return { kind: 'reply', label: '回答' }
  }
  return { kind: 'none', label: '' }
}

export function TasksView(props: { onError: (message: string) => void; pollMs?: number }): JSX.Element {
  const [board, setBoard] = useState<TaskBoardView | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [drawerId, setDrawerId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [leftovers, setLeftovers] = useState<Array<{ taskId: string; repo: string; directory: string }>>([])
  // 回收被服务端拒绝的原因（taskId → reason）：展示出来之后才有「强制回收」可点。
  const [reclaimReasons, setReclaimReasons] = useState<Record<string, string>>({})

  const refresh = useCallback(async () => {
    try {
      setBoard(await getTaskBoard())
    } catch (error) {
      props.onError(error instanceof Error ? error.message : String(error))
    }
    // 遗留目录是补充信息，失败不影响看板
    void listLeftoverWorktrees()
      .then((result) => setLeftovers(result.entries ?? []))
      .catch(() => setLeftovers([]))
  }, [props])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), props.pollMs ?? 5_000)
    return () => window.clearInterval(timer)
  }, [refresh, props.pollMs])

  const cards = board?.cards ?? []
  const byId = useMemo(() => new Map(cards.map((card) => [card.task.id, card])), [cards])

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true)
      try {
        await action()
        await refresh()
      } catch (error) {
        props.onError(error instanceof Error ? error.message : String(error))
      } finally {
        setBusy(false)
      }
    },
    [props, refresh],
  )

  // 回收分两段（对齐 reclaim.ts 的设计意图）：默认不带 force，走服务端
  // isMergedInto 保护；被拒（未合并等）时把 reason 挂到条目行，用户看到原因
  // 后才有「强制回收」可点——force 是人的决定，不给一键直达。
  const reclaimLeftover = useCallback(
    async (entry: { taskId: string; repo: string; directory: string }, options: { force?: boolean } = {}) => {
      await run(async () => {
        const outcome = await reclaimWorktree(entry.taskId, options)
        setReclaimReasons((prev) => {
          if (outcome.removed === true) {
            // 成功即清原因；刷新后条目本身也会消失
            if (prev[entry.taskId] === undefined) return prev
            const next = { ...prev }
            delete next[entry.taskId]
            return next
          }
          return { ...prev, [entry.taskId]: outcome.reason ?? '回收被拒绝（服务端未给出原因）' }
        })
      })
    },
    [run],
  )

  const drawer = drawerId === null ? undefined : byId.get(drawerId)

  // 多端点健康聚合（change `support-multi-repo-executors`）：
  // 超过 1 个端点时显示「N 个执行器，M 个离线」。单端点或旧服务端不提供 `endpoints`
  // 时沿用 `health` 单值（旧文案与状态点不回归）。整块离线只在**所有**端点都离线时成立，
  // 单个端点不可达只影响它自己服务的那批待办。
  const endpoints = board?.endpoints ?? []
  const multiEndpoint = endpoints.length > 1
  const offlineEndpoints = endpoints.filter((entry) => entry.online === false)
  const healthOnline = multiEndpoint
    ? endpoints.some((entry) => entry.online === true)
    : board?.health?.online === true
  const boardOffline = multiEndpoint
    ? offlineEndpoints.length === endpoints.length
    : board?.health?.online === false

  return (
    <div className="wm-tasks">
      <div className="wm-tasks-bar">
        <span className={`wm-conn-dot ${healthOnline ? 'ok' : 'off'}`} aria-hidden />
        <span className="wm-tasks-health">
          {board === undefined
            ? '读取中…'
            : multiEndpoint
              ? `${endpoints.length} 个执行器，${offlineEndpoints.length} 个离线`
              : board.health?.online === true
                ? `执行器在线 · ${board.health.endpoint}`
                : '执行器离线'}
          {board?.health?.paused === true ? ' · 已暂停' : ''}
        </span>
        <span className="wm-tasks-count">{cards.length} 个任务 · {board?.attention ?? 0} 个需要你</span>
        {(board?.notes ?? [])
          // 「执行器离线」的细节由下面的红色横幅统一说明，这里只留它能做的补充提示。
          .filter((note) => !boardOffline || !note.startsWith('执行器离线'))
          .map((note) => (
            <Tag key={note} tone="warning">{note}</Tag>
          ))}
        {(leftovers ?? []).length > 0 && (
          <Tooltip
            label={`Ticket 已结束但目录仍在：${leftovers.map((entry) => entry.directory).join('、')}`}
            side="bottom"
          >
            <Tag tone="outline">{leftovers.length} 个遗留目录</Tag>
          </Tooltip>
        )}
        <Btn variant="primary" size="sm" type="button" onClick={() => setCreateOpen(true)} disabled={busy}>
          ＋ 新建待办
        </Btn>
      </div>

      {boardOffline && board !== undefined && (
        <div className="wm-error" role="alert">
          执行器离线：{board.health?.reason ?? '未知原因'}。待办仍可记录，恢复后由 Source 扫描投递。
        </div>
      )}

      <div className="wm-tasks-board">
        {LANES.map((lane) => {
          const list = (board?.lanes?.[lane.key] ?? []) as TaskCardView[]
          return (
            <section className={`wm-task-col wm-task-col-${lane.key}`} key={lane.key} aria-label={lane.label}>
              <header className="wm-task-col-head">
                <StateDot state={lane.key === 'attention' ? 'warning' : lane.key === 'working' ? 'success' : undefined} />
                <span className="wm-task-col-label">{lane.label}</span>
                <span className="wm-task-col-count">{list.length}</span>
                <span className="wm-task-col-hint">{lane.hint}</span>
              </header>
              <div className="wm-task-col-body">
                {list.length === 0 && (
                  <div className="wm-empty">
                    {lane.key === 'todo' ? '没有待指派的条目' : lane.key === 'attention' ? '没有等你处理的事' : '暂无任务'}
                  </div>
                )}
                {list.map((card) => (
                  <TaskCardView card={card} busy={busy} key={card.task.id} onOpen={() => setDrawerId(card.task.id)} onRun={run} />
                ))}
              </div>
            </section>
          )
        })}
      </div>

      {(leftovers ?? []).length > 0 && (
        <div className="wm-tasks-leftover">
          <div className="wm-section-title">遗留目录（Ticket 已结束）</div>
          {(leftovers ?? []).map((entry) => {
            const reason = reclaimReasons[entry.taskId]
            return (
              <div className="wm-tasks-leftover-row" key={entry.taskId}>
                <code>{entry.directory}</code>
                <span>{entry.taskId} · {entry.repo}</span>
                {reason !== undefined && (
                  <span className="wm-tasks-leftover-reason" role="note">{reason}</span>
                )}
                <Btn size="sm" type="button" disabled={busy} onClick={() => void reclaimLeftover(entry)}>
                  回收
                </Btn>
                {reason !== undefined && (
                  <Btn
                    size="sm"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      // 与 App.tsx 终止提案同一惯例：不可逆删除先 window.confirm 一次。
                      if (!window.confirm('未合并的分支与未提交修改将一并删除。确定强制回收？')) return
                      void reclaimLeftover(entry, { force: true })
                    }}
                  >
                    强制回收
                  </Btn>
                )}
              </div>
            )
          })}
          <div className="wm-kpi-note">回收删除 worktree 与分支；未合并的分支会被拒绝，确认放弃后可强制回收。</div>
        </div>
      )}

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="新建待办" closeLabel="关闭">
        <CreateForm
          busy={busy}
          onCancel={() => setCreateOpen(false)}
          onSubmit={async (body) => {
            await run(() => createTask(body))
            setCreateOpen(false)
          }}
        />
      </Modal>

      {drawer !== undefined && (
        <Drawer card={drawer} busy={busy} onClose={() => setDrawerId(null)} onRun={run} />
      )}
    </div>
  )
}

function TaskCardView(props: {
  card: TaskCardView
  busy: boolean
  onOpen: () => void
  onRun: (action: () => Promise<unknown>) => Promise<void>
}): JSX.Element {
  const { card, busy } = props
  const primary = primaryActionOf(card)
  // 未接入执行器：把原因写在卡片正文里（不塞进 title/hover），
  // 仓库优先用服务端给出的 unservedRepo，旧服务端缺失时回退 task.repo。
  const unservedRepo = card.connectable ? undefined : card.unservedRepo ?? card.task.repo

  useEffect(() => {
    // 保留占位：卡片本身不做自动刷新，由外层轮询驱动。
  }, [])

  const trigger = (): void => {
    if (primary.kind === 'assign') void props.onRun(() => assignTask(card.task.id))
    else if (primary.kind === 'retry') void props.onRun(() => retryTask(card.task.id))
    else if (primary.kind === 'reopen') void props.onRun(() => reopenTask(card.task.id))
    else props.onOpen()
  }

  return (
    // tabIndex：卡片可键盘聚焦，Tab 进入后内部「详情/主操作」按钮可 Enter 触发
    // （polish-workbench-delivery T10；看板提案卡片此前已有同样处理）。
    <article className={`wm-task-card wm-task-${card.lane}`} tabIndex={0}>
      <button type="button" className="wm-task-open" onClick={props.onOpen}>
        <span className="wm-task-title">{card.task.title}</span>
        <span className="wm-task-meta">
          <Tag tone={TONE[card.lane]}>{SUBSTATE_LABEL[card.substate]}</Tag>
          <code className="wm-task-repo">{card.task.repo}</code>
          <span className="wm-task-time" title={card.task.updatedAt}>{compactTime(card.task.updatedAt)}</span>
        </span>
      </button>
      {card.note !== undefined && card.substate !== 'unassigned' && (
        <div className="wm-task-note">{card.note}</div>
      )}
      {unservedRepo !== undefined && (
        <div className="wm-task-note">未接入执行器（仓库 {unservedRepo}）</div>
      )}
      <div className="wm-task-actions">
        {primary.kind !== 'none' && (
          <Btn
            size="sm"
            variant={primary.kind === 'assign' || primary.kind === 'reply' ? 'primary' : undefined}
            type="button"
            disabled={busy || (primary.kind === 'assign' && !card.connectable)}
            onClick={trigger}
          >
            {primary.label}
          </Btn>
        )}
        <Btn size="sm" type="button" onClick={props.onOpen}>
          详情
        </Btn>
      </div>
    </article>
  )
}

function CreateForm(props: {
  busy: boolean
  onCancel: () => void
  onSubmit: (body: {
    intent: string
    repo?: string
    baseBranch?: string
    acceptance?: string
    priority?: 'P0' | 'P1' | 'P2'
    mode?: 'superagent' | 'proposal' | 'record'
  }) => Promise<void>
}): JSX.Element {
  const [intent, setIntent] = useState('')
  const [repo, setRepo] = useState('')
  const [baseBranch, setBaseBranch] = useState('main')
  const [acceptance, setAcceptance] = useState('')
  const [priority, setPriority] = useState<'P0' | 'P1' | 'P2'>('P2')
  const [mode, setMode] = useState<'superagent' | 'proposal' | 'record'>('superagent')
  const [error, setError] = useState('')

  return (
    <div className="wm-task-form">
      <label className="wm-context-field wm-task-form-wide">
        <span>目标</span>
        <textarea
          rows={3}
          value={intent}
          placeholder="例如：把任务面板的轮询改成事件推送"
          onChange={(event) => setIntent(event.target.value)}
        />
      </label>
      <div className="wm-task-form-row">
        <label className="wm-context-field">
          <span>目标仓库</span>
          <input value={repo} placeholder="留空用当前项目" onChange={(event) => setRepo(event.target.value)} />
        </label>
        <label className="wm-context-field">
          <span>基线分支</span>
          <input value={baseBranch} onChange={(event) => setBaseBranch(event.target.value)} />
        </label>
        <label className="wm-context-field">
          <span>优先级</span>
          <select value={priority} onChange={(event) => setPriority(event.target.value as typeof priority)}>
            <option>P0</option>
            <option>P1</option>
            <option>P2</option>
          </select>
        </label>
      </div>
      <label className="wm-context-field wm-task-form-wide">
        <span>验收标准（作为环境变量交给 worker）</span>
        <textarea rows={2} value={acceptance} onChange={(event) => setAcceptance(event.target.value)} />
      </label>
      <div className="wm-task-modes" role="radiogroup" aria-label="执行方式">
        {(
          [
            ['superagent', '指派给 Super-agent', '评估后接受才开工'],
            ['proposal', '生成 OpenSpec 提案', '先评审方案与 planHash'],
            ['record', '仅记录', '只入待办，稍后再指派'],
          ] as const
        ).map(([value, title, hint]) => (
          <label className={`wm-task-mode${mode === value ? ' active' : ''}`} key={value}>
            <input type="radio" name="task-mode" value={value} checked={mode === value} onChange={() => setMode(value)} />
            <span>
              <b>{title}</b>
              <small>{hint}</small>
            </span>
          </label>
        ))}
      </div>
      {error !== '' && <p className="wm-error" role="alert">{error}</p>}
      <div className="wm-task-form-actions">
        <Btn size="sm" type="button" onClick={props.onCancel} disabled={props.busy}>
          取消
        </Btn>
        <Btn
          size="sm"
          variant="primary"
          type="button"
          disabled={props.busy}
          onClick={() => {
            if (intent.trim() === '') {
              setError('先写一句目标')
              return
            }
            setError('')
            void props.onSubmit({
              intent: intent.trim(),
              ...(repo.trim() !== '' ? { repo: repo.trim() } : {}),
              ...(baseBranch.trim() !== '' ? { baseBranch: baseBranch.trim() } : {}),
              ...(acceptance.trim() !== '' ? { acceptance: acceptance.trim() } : {}),
              priority,
              mode,
            })
          }}
        >
          创建
        </Btn>
      </div>
    </div>
  )
}

function Drawer(props: {
  card: TaskCardView
  busy: boolean
  onClose: () => void
  onRun: (action: () => Promise<unknown>) => Promise<void>
}): JSX.Element {
  const { card, busy } = props
  const [answer, setAnswer] = useState('')
  const primary = primaryActionOf(card)
  const ticket = card.ticket

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [props])

  return (
    <div className="wm-drawer-mask" role="presentation" onMouseDown={props.onClose}>
      <aside
        className="wm-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={card.task.title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="wm-drawer-head">
          <div>
            <h3>{card.task.title}</h3>
            <div className="wm-task-meta">
              <Tag tone={TONE[card.lane]}>{SUBSTATE_LABEL[card.substate]}</Tag>
              <code className="wm-task-repo">{card.task.repo}</code>
              <span className="wm-task-time" title={card.task.updatedAt}>{compactTime(card.task.updatedAt)}</span>
            </div>
          </div>
          <button className="wm-btn mini" type="button" aria-label="关闭" onClick={props.onClose}>
            ✕
          </button>
        </header>

        <div className="wm-drawer-body">
          {ticket !== undefined && (
            <section className="wm-section">
              <div className="wm-section-title">执行 <span className="wm-src">来自 Super-agent</span></div>
              <dl className="wm-task-facts">
                <dt>Ticket</dt><dd><code>{ticket.id}</code></dd>
                <dt>阶段</dt><dd>{ticket.stage ?? '—'}{ticket.action !== undefined ? ` / ${ticket.action}` : ''}</dd>
                {ticket.directory !== undefined && (<><dt>目录</dt><dd><code>{ticket.directory}</code></dd></>)}
                {ticket.summary !== undefined && ticket.summary !== '' && (<><dt>最近报告</dt><dd>{ticket.summary}</dd></>)}
              </dl>
            </section>
          )}

          <section className="wm-section">
            <div className="wm-section-title">输入 <span className="wm-src">来自 WorkMate</span></div>
            <dl className="wm-task-facts">
              <dt>意图</dt><dd>{card.task.intent}</dd>
              <dt>基线</dt><dd><code>{card.task.baseBranch}</code></dd>
              <dt>验收</dt><dd>{card.task.acceptance !== '' ? card.task.acceptance : '未填写'}</dd>
              {card.task.proposalId !== undefined && (<><dt>提案</dt><dd><code>{card.task.proposalId}</code></dd></>)}
              {card.task.ports !== undefined && card.task.ports.length > 0 && (
                <><dt>端口</dt><dd><code>{card.task.ports.join(', ')}</code></dd></>
              )}
              <dt>尝试</dt><dd>{card.task.attempt}</dd>
            </dl>
          </section>

          {card.lane === 'attention' && (
            <section className="wm-section">
              <div className="wm-section-title">{SUBSTATE_LABEL[card.substate]}</div>
              {card.note !== undefined && <div className="wm-task-quote">{card.note}</div>}
              {card.substate === 'answer' && (
                <div className="wm-task-form">
                  <textarea
                    rows={3}
                    value={answer}
                    placeholder="给出决定或补充约束…"
                    onChange={(event) => setAnswer(event.target.value)}
                  />
                  <div className="wm-task-form-actions">
                    <span className="wm-kpi-note">作为该任务对话里的一条人消息送达 worker，不重走评估</span>
                    <Btn
                      size="sm"
                      variant="primary"
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (answer.trim() === '') return
                        void props.onRun(() => replyTask(card.task.id, answer.trim()))
                        setAnswer('')
                      }}
                    >
                      提交回答
                    </Btn>
                  </div>
                </div>
              )}
              {card.substate !== 'answer' && (
                <div className="wm-task-actions">
                  <Btn size="sm" type="button" disabled={busy} onClick={() => void props.onRun(() => retryTask(card.task.id))}>
                    重试
                  </Btn>
                  <Btn
                    size="sm"
                    type="button"
                    disabled={busy}
                    title="本地标记放弃（Source 不再投递）；若执行器里有对应 Ticket 会一并请求停止"
                    onClick={() =>
                      void props.onRun(async () => {
                        const result = await stopTask(card.task.id)
                        // 本地已标记，但执行器那边可能没停成功（Ticket 找不到或 stop 被拒）。
                        // 不说清就会让人以为 worker 已经停了（真机 2026-11-10）。
                        if (result.stopped === undefined) {
                          throw new Error('本地已标记为放弃，但执行器里没有找到可停止的 Ticket（worker 可能仍在运行）；请到 Super-agent 面板确认')
                        }
                        return result
                      })
                    }
                  >
                    停止
                  </Btn>
                </div>
              )}
            </section>
          )}

          {card.substate === 'review' && (
            <section className="wm-section">
              <div className="wm-kpi-note">
                代码与测试由 Super-agent 完成；合并与归档仍由你在提案页批准（G5）。
              </div>
              <div className="wm-task-actions">
                <Btn size="sm" type="button" disabled={busy} onClick={() => void props.onRun(() => retryTask(card.task.id))}>
                  退回修改
                </Btn>
              </div>
            </section>
          )}
        </div>

        <footer className="wm-drawer-foot">
          {primary.kind === 'assign' && (
            <Btn
              size="sm"
              variant="primary"
              type="button"
              disabled={busy || !card.connectable}
              onClick={() => void props.onRun(() => assignTask(card.task.id))}
            >
              指派给 Super-agent
            </Btn>
          )}
          {primary.kind === 'reopen' && (
            <Btn size="sm" variant="primary" type="button" disabled={busy} onClick={() => void props.onRun(() => reopenTask(card.task.id))}>
              重新打开
            </Btn>
          )}
          {card.lane === 'working' && (
            <Btn size="sm" type="button" disabled={busy} onClick={() => void props.onRun(() => stopTask(card.task.id))}>
              停止
            </Btn>
          )}
        </footer>
      </aside>
    </div>
  )
}
