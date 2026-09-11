/**
 * Card run panel — the live per-run timeline.
 *
 * Discipline (spec task-kanban 「冲突裁决与合并由用户决定」+ design D9): this
 * component NEVER offers an automatic merge / conflict-adjudication control.
 * Conflict rows are labels plus a jump-off to the existing diff view
 * (`/helmsman-diff`), where the USER compares and decides. The only write this
 * panel performs is promoting an already-merged run's impacted-service
 * candidates into card associations (an association write, not a merge).
 *
 * Live data comes from the change-A durable timeline: SSE first (address
 * configured via `streamUrlTemplate`, default = the dashboard mount), coarse
 * polling of `GET api/run/:taskId/events` as the fallback.
 */
import { useEffect, useState } from 'react'
import {
  api,
  ASSOCIATION_ICONS,
  runStreamUrl,
  subscribeRunStream,
  type AssociationType,
  type ApprovalPayload,
  type CardRunPayload,
  type RunStreamHandle,
  type RunStreamOptions,
} from './api'
import { isTerminalEvent, type ClientExecutionEvent, type RunStreamStatus } from './events'

export type TimelineStatus = RunStreamStatus | 'polling' | 'unavailable'

export interface TimelineRow {
  key: string
  ts: number
  kind: 'state' | 'log' | 'attempt' | 'start' | 'end' | 'merge' | 'conflict'
  text: string
  agent?: string
  /** Set on conflict rows: rendered as a jump-off, never as an action. */
  conflictPath?: string
}

/** Max retained timeline rows per run (a live log can be unbounded). */
const MAX_ROWS = 300

/**
 * Pure mapping from a durable event to display rows. Exported for tests.
 * Unknown kinds are ignored (forward compatible wire format).
 */
export function describeEvent(event: ClientExecutionEvent, index = 0): TimelineRow[] {
  const base = { ts: event.ts, key: `${event.taskId}:${event.seq}:${index}` }
  switch (event.kind) {
    case 'task-state': {
      const rows: TimelineRow[] = [{ ...base, kind: 'state', text: `任务状态 ${event.payload.status}` }]
      for (const [agent, run] of Object.entries(event.payload.agents ?? {})) {
        for (const path of run.conflictingFiles ?? []) {
          rows.push({
            ...base,
            key: `${base.key}:conflict:${agent}:${path}`,
            kind: 'conflict',
            agent,
            conflictPath: path,
            text: `真实冲突 ${path}(${agent})`,
          })
        }
      }
      return rows
    }
    case 'agent-log':
      return [{ ...base, kind: 'log', agent: event.agent, text: event.payload.text }]
    case 'agent-attempt':
      return [{ ...base, kind: 'attempt', agent: event.agent, text: `${event.agent} 重试 / 退避(第 ${event.payload.attempt} 次)` }]
    case 'run-start':
      return [{ ...base, kind: 'start', agent: event.agent, text: `${event.agent} 启动(第 ${event.payload.attempt} 次尝试)` }]
    case 'run-end': {
      const p = event.payload
      const bits = [`${event.agent} 结束:${p.state}`]
      if (typeof p.exitCode === 'number') bits.push(`exit ${p.exitCode}`)
      if (p.timedOut) bits.push('超时')
      if (p.error) bits.push(p.error)
      return [{ ...base, kind: 'end', agent: event.agent, text: bits.join(' · ') }]
    }
    case 'merge-decision': {
      const p = event.payload
      const adjudicated = Object.keys(p.resolutions ?? {}).length
      const rows: TimelineRow[] = [
        {
          ...base,
          kind: 'merge',
          text: `合并${p.outcome === 'merged' ? '已执行' : '已中止'} · 用户裁决 ${adjudicated} 个文件`,
        },
      ]
      for (const path of p.conflictFiles ?? []) {
        rows.push({ ...base, key: `${base.key}:mconflict:${path}`, kind: 'conflict', conflictPath: path, text: `真实冲突 ${path}` })
      }
      return rows
    }
    default:
      return []
  }
}

/**
 * Subscribes to one run's timeline: SSE when possible, polling otherwise.
 * Returns the accumulated rows plus the current transport status.
 */
export function useRunTimeline(args: {
  taskId: string
  enabled: boolean
  streamUrlTemplate: string
  pollMs: number
  historyAvailable: boolean
  streamOptions?: RunStreamOptions
}): { rows: TimelineRow[]; status: TimelineStatus; pruned: boolean } {
  const [rows, setRows] = useState<TimelineRow[]>([])
  const [status, setStatus] = useState<TimelineStatus>('unavailable')
  const [pruned, setPruned] = useState(false)
  const { taskId, enabled, streamUrlTemplate, pollMs, historyAvailable } = args
  const { eventSource, minReconnectMs, maxReconnectMs } = args.streamOptions ?? {}

  useEffect(() => {
    setRows([])
    setPruned(false)
    if (!enabled) {
      setStatus('unavailable')
      return
    }
    let cancelled = false
    let cursor = 0
    let failures = 0
    let handle: RunStreamHandle | null = null
    let timer: ReturnType<typeof setInterval> | null = null

    const append = (event: ClientExecutionEvent): void => {
      if (event.seq > cursor) cursor = event.seq
      const described = describeEvent(event)
      if (described.length === 0) return
      setRows((prev) => [...prev, ...described].slice(-MAX_ROWS))
    }

    const startPolling = (): void => {
      if (timer !== null || cancelled) return
      setStatus('polling')
      const tick = async (): Promise<void> => {
        try {
          const page = await api.getRunEvents(taskId, cursor)
          if (cancelled) return
          if (page.pruned) setPruned(true)
          for (const event of page.events) append(event)
        } catch {
          // transient failure — the next tick retries
        }
      }
      void tick()
      timer = setInterval(() => void tick(), pollMs)
    }

    // SSE when the timeline is reachable AND EventSource exists; otherwise
    // fall back to polling (design 风险: SSE 不可用时回退轮询).
    const canStream = historyAvailable && streamUrlTemplate !== '' && typeof EventSource !== 'undefined'
    if (!canStream) {
      if (historyAvailable) startPolling()
      else setStatus('unavailable')
    } else {
      const streamOptions: RunStreamOptions = {}
      if (eventSource) streamOptions.eventSource = eventSource
      if (minReconnectMs !== undefined) streamOptions.minReconnectMs = minReconnectMs
      if (maxReconnectMs !== undefined) streamOptions.maxReconnectMs = maxReconnectMs
      handle = subscribeRunStream(runStreamUrl(streamUrlTemplate, taskId), 0, {
        onEvent: append,
        onPruned: () => setPruned(true),
        onStatus: (next) => {
          if (cancelled) return
          setStatus(next)
          if (next === 'reconnecting') {
            failures += 1
            // Persistent SSE failure → degrade to polling instead of hammering.
            if (failures > 2) {
              handle?.close()
              handle = null
              startPolling()
            }
          }
        },
        shouldStop: isTerminalEvent,
      }, streamOptions)
    }

    return () => {
      cancelled = true
      handle?.close()
      if (timer !== null) clearInterval(timer)
    }
  }, [taskId, enabled, streamUrlTemplate, pollMs, historyAvailable, eventSource, minReconnectMs, maxReconnectMs])

  return { rows, status, pruned }
}

export interface RunPanelProps {
  runs: CardRunPayload[]
  approvals?: ApprovalPayload[]
  streamUrlTemplate: string
  pollMs: number
  historyAvailable: boolean
  /** Conflict jump-off mount (from the runs payload / config). */
  diffMount?: string
  /** SSE transport/timing overrides (used by tests; production keeps defaults). */
  streamOptions?: RunStreamOptions
  onAssociate?: (association: { type: AssociationType; refId: string; label?: string }) => Promise<void> | void
  onToast?: (message: string) => void
}

export function RunPanel(props: RunPanelProps): JSX.Element {
  const { runs, approvals = [], streamUrlTemplate, pollMs, historyAvailable } = props
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)

  if (runs.length === 0) {
    return <p className="muted small" data-role="run-empty">该卡片尚无执行记录。</p>
  }

  return (
    <div className="run-panel" data-role="run-panel">
      {runs.map((run) => {
        const expanded = openTaskId === run.taskId
        const approval = approvals.find((a) => a.scope.includes(run.taskId) || (a as { taskId?: string }).taskId === run.taskId)
        return (
          <div className="run-row" key={run.taskId} data-run={run.taskId} data-role="run-row">
            <button
              type="button"
              className="run-head"
              data-role="run-toggle"
              aria-expanded={expanded}
              onClick={() => setOpenTaskId(expanded ? null : run.taskId)}
            >
              <span className={`run-dot ${run.state}`} aria-hidden="true" />
              <span className="run-id">{run.taskId}</span>
              <span className={`run-state state-${run.state}`}>{run.stateLabel}</span>
              <span className="muted small">{expanded ? '收起时间线' : '展开时间线'}</span>
            </button>
            {expanded && (
              <RunBody
                run={run}
                approval={approval}
                streamUrlTemplate={streamUrlTemplate}
                pollMs={pollMs}
                historyAvailable={historyAvailable}
                diffMount={props.diffMount ?? '/helmsman-diff'}
                streamOptions={props.streamOptions}
                {...(props.onAssociate ? { onAssociate: props.onAssociate } : {})}
                {...(props.onToast ? { onToast: props.onToast } : {})}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

function RunBody(props: {
  run: CardRunPayload
  approval: ApprovalPayload | undefined
  streamUrlTemplate: string
  pollMs: number
  historyAvailable: boolean
  diffMount: string
  streamOptions?: RunStreamOptions
  onAssociate?: (association: { type: AssociationType; refId: string; label?: string }) => Promise<void> | void
  onToast?: (message: string) => void
}): JSX.Element {
  const { run, approval } = props
  const { rows, status, pruned } = useRunTimeline({
    taskId: run.taskId,
    enabled: true,
    streamUrlTemplate: props.streamUrlTemplate,
    pollMs: props.pollMs,
    historyAvailable: props.historyAvailable,
    streamOptions: props.streamOptions,
  })
  const [checked, setChecked] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)

  async function confirmCandidates(): Promise<void> {
    const chosen = run.serviceCandidates.filter((c) => checked[c.refId])
    if (chosen.length === 0) return
    setBusy(true)
    try {
      for (const candidate of chosen) {
        await props.onAssociate?.({ type: 'service', refId: candidate.refId, label: candidate.label })
      }
      props.onToast?.(`已确认 ${chosen.length} 个受影响服务`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="run-body">
      <div className="run-meta muted small">
        {run.prompt ? <span className="run-prompt">{run.prompt}</span> : null}
        <span>
          开始 {new Date(run.startedAt).toLocaleString('zh-CN')}
          {run.mergedAt ? ` · 合并于 ${new Date(run.mergedAt).toLocaleString('zh-CN')}` : ''}
        </span>
        <span data-role="timeline-status">时间线:{statusLabel(status)}</span>
      </div>

      {approval ? (
        <div className="run-approval" data-role="approval-pending">
          ⏳ 待审批令牌:<strong>{approval.op}</strong>({approval.scope})
          {approval.expiresAt ? ` · ${new Date(approval.expiresAt).toLocaleTimeString('zh-CN')} 前有效` : ''}
          <span className="muted small"> — 请在仪表盘审批面板中决定</span>
        </div>
      ) : null}

      {pruned ? (
        <div className="run-pruned" data-role="history-pruned">
          历史已裁剪:游标之前的事件不再可用(时间线自断点续传)。
        </div>
      ) : null}

      {run.conflicts.length > 0 ? (
        <ul className="run-conflicts" data-role="conflicts">
          {run.conflicts.map((conflict) => (
            <li className="conflict-row" data-role="conflict-row" key={`${conflict.agent}:${conflict.path}`}>
              <span className="conflict-label">⚠ 冲突文件 {conflict.path}</span>
              {/* The ONLY control on a conflict row: go compare. Never adjudicate here. */}
              <a className="btn btn-sm" data-role="conflict-jump" href={conflict.href} target="_blank" rel="noreferrer">
                跳转对比
              </a>
            </li>
          ))}
        </ul>
      ) : null}

      <ol className="run-timeline" data-role="run-timeline">
        {rows.length === 0 ? (
          <li className="muted small tl-empty">等待执行事件…</li>
        ) : (
          rows.map((row) => (
            <li className={`tl-row tl-${row.kind}`} key={row.key}>
              {row.kind === 'log' ? (
                <pre className="tl-log-text">{row.text}</pre>
              ) : row.kind === 'conflict' ? (
                <span className="tl-conflict" data-role="timeline-conflict">
                  {row.text}
                  <a className="tl-jump" href={jumpHref(run, props.diffMount)} target="_blank" rel="noreferrer">
                    跳转对比
                  </a>
                </span>
              ) : (
                <span className="tl-text">{row.text}</span>
              )}
            </li>
          ))
        )}
      </ol>

      {run.merged && run.serviceCandidates.length > 0 ? (
        <div className="run-candidates" data-role="service-candidates">
          <div className="muted small">按 diff × topology 给出的受影响服务候选(勾选后写入卡片关联):</div>
          {run.serviceCandidates.map((candidate) => (
            <label className="candidate-row" key={candidate.refId}>
              <input
                type="checkbox"
                data-role="candidate-check"
                checked={checked[candidate.refId] === true}
                onChange={(e) => setChecked((prev) => ({ ...prev, [candidate.refId]: e.target.checked }))}
              />
              <span>
                {ASSOCIATION_ICONS.service} {candidate.label}
              </span>
              <span className="muted small">{candidate.reason}</span>
            </label>
          ))}
          <button type="button" className="btn btn-sm" data-role="confirm-candidates" disabled={busy} onClick={() => void confirmCandidates()}>
            确认影响服务
          </button>
        </div>
      ) : null}
      {run.merged ? <div className="muted small">该 run 已合并;冲突裁决在对比界面完成。</div> : null}
    </div>
  )
}

/** Conflict rows are jump-offs only — the user compares and decides there. */
function jumpHref(run: CardRunPayload, diffMount: string): string {
  return run.conflicts[0]?.href ?? `${diffMount.replace(/\/+$/, '')}/?task=${encodeURIComponent(run.taskId)}`
}

export function statusLabel(status: TimelineStatus): string {
  switch (status) {
    case 'open':
      return '实时(SSE)'
    case 'connecting':
      return '连接中…'
    case 'reconnecting':
      return '重连中…'
    case 'polling':
      return '轮询'
    case 'unavailable':
      return '不可用'
    default:
      return '已停止'
  }
}
