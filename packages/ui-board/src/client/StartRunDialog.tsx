/**
 * 发起执行 dialog — 第 ③ 列卡片的「▶ 发起执行」入口 (change
 * `enable-card-start-run`, design D3/D4).
 *
 * It is deliberately a START dialog and not an operations panel: it submits to
 * the EXISTING `runParallelTask` through `POST api/item/:id/run`, the card does
 * not move, and cancel / retry / approval / merge are NOT offered here — the
 * dialog links to the execution dashboard for those (spec 「只发起、不复制操作」).
 *
 * Prefill (design D3 + product decision ①): title from the card, prompt
 * skeleton from the card's summary (empty textarea when there is no summary),
 * 「级联注入拓扑」 checked by default, agent = 按场景自适应. The submitted prompt
 * is the title + the skeleton ({@link composePrompt}).
 */
import { useState } from 'react'
import type { FormEvent } from 'react'
import { api, type BoardCardPayload } from './api'
import {
  AGENT_CHOICES,
  AGENT_CHOICE_LABELS,
  composePrompt,
  resolveChoice,
  type AgentChoice,
} from './start-run'

export interface StartRunDialogProps {
  card: BoardCardPayload
  /** `${dashboardMount}/` — where the run's lifecycle lives (design D4). */
  dashboardMount: string
  onCancel: () => void
  /** Called once with the new taskId; the parent refreshes (nothing moves). */
  onStarted: (taskId: string) => Promise<void> | void
  /** Closes the dialog and opens the card drawer, where the run panel streams. */
  onOpenCard: () => void
}

export function StartRunDialog(props: StartRunDialogProps): JSX.Element {
  const { card } = props
  const installed = card.startRun.installed
  const [title, setTitle] = useState(card.title)
  const [promptDraft, setPromptDraft] = useState(card.summary?.text ?? '')
  const [cascade, setCascade] = useState(true)
  const [choice, setChoice] = useState<AgentChoice>('auto')
  const [error, setError] = useState<string | null>(null)
  const [linkWarning, setLinkWarning] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [startedTaskId, setStartedTaskId] = useState<string | null>(null)

  const prompt = composePrompt(title, promptDraft)
  const resolved = resolveChoice(choice, prompt, installed)
  const agentMissing = resolved.agent !== null && !installed.includes(resolved.agent)
  const dashboardHref = `${props.dashboardMount.replace(/\/+$/, '')}/`

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (resolved.agent === null) {
      setError('没有可用的 agent,请先在执行看板发起')
      return
    }
    // An explicit pick is never silently swapped for another agent — an
    // impossible one is reported instead of started.
    if (agentMissing) {
      setError(`agent 未安装:${resolved.agent}`)
      return
    }
    if (prompt.trim() === '') {
      setError('提示词不能为空')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await api.startRun(card.id, { prompt, agents: [resolved.agent], cascade })
      if (!res.ok || !res.taskId) {
        setError(res.reason ?? '发起失败')
        return
      }
      setStartedTaskId(res.taskId)
      // 关联失败不回滚 run:如实告诉用户它已起跑但没挂到卡片(可在卡片内重试关联)。
      if (res.linked === false && res.linkError) setLinkWarning(res.linkError)
      await props.onStarted(res.taskId)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="board-modal" data-role="start-run-form">
      <form className="board-modal-box" onSubmit={(event) => void submit(event)}>
        <h3>▶ 发起执行</h3>

        {startedTaskId ? (
          <div className="create-done" data-role="start-run-done">
            <p data-role="start-run-started">
              已发起执行:<strong>{startedTaskId}</strong>
            </p>
            <p className="muted small">
              卡片留在「{card.stageLabel}」原地不动;run 会挂到本卡片,卡片内的 run 面板经 SSE 实时滚动。
            </p>
            {linkWarning && (
              <p className="muted small" data-role="start-run-link-warning">
                ⚠️ run 已起跑,但未挂到本卡片:{linkWarning}
                ——可在执行看板查看该 run,或稍后在卡片内重新关联。
              </p>
            )}
            <div className="drawer-actions">
              <button type="button" className="btn btn-primary" data-role="start-run-open-card" onClick={props.onOpenCard}>
                查看卡片时间线
              </button>
              <button type="button" className="btn" onClick={props.onCancel}>
                完成
              </button>
              <a className="btn" data-role="start-run-dashboard" href={dashboardHref} target="_blank" rel="noreferrer">
                去执行看板
              </a>
            </div>
            <p className="muted small">取消 / 重试 / 审批 / 合并仍在执行看板完成。</p>
          </div>
        ) : (
          <>
            <label className="field">
              <span>标题(来自卡片,可改)</span>
              <input data-role="start-run-title" value={title} onChange={(event) => setTitle(event.target.value)} />
            </label>

            <label className="field">
              <span>提示词骨架(来自卡片摘要,可改)</span>
              <textarea
                className="summary-input"
                data-role="start-run-prompt"
                rows={5}
                value={promptDraft}
                onChange={(event) => setPromptDraft(event.target.value)}
              />
            </label>
            <pre className="prompt-preview" data-role="start-run-prompt-preview">
              {prompt === '' ? '(提示词为空)' : prompt}
            </pre>

            <label className="field field-check">
              <input
                type="checkbox"
                data-role="start-run-cascade"
                checked={cascade}
                onChange={(event) => setCascade(event.target.checked)}
              />
              <span>级联注入拓扑</span>
            </label>

            <label className="field">
              <span>agent</span>
              <select
                data-role="start-run-agent"
                value={choice}
                onChange={(event) => setChoice(event.target.value as AgentChoice)}
              >
                {AGENT_CHOICES.map((value) => (
                  <option key={value} value={value}>
                    {AGENT_CHOICE_LABELS[value]}
                  </option>
                ))}
              </select>
            </label>
            <p className="muted small" data-role="start-run-resolved">
              将使用:{resolved.agent ?? '—'} · {resolved.reason}
            </p>
            <p className="muted small" data-role="start-run-installed">
              已装 agent:{installed.length > 0 ? installed.join('、') : '无'}(按场景推荐是本地近似规则,可在上方改选)
            </p>
            {agentMissing ? (
              <p className="form-error" data-role="start-run-agent-warning">
                {resolved.agent} 未安装,请改选已装 agent 或去执行看板发起
              </p>
            ) : null}
            {error ? (
              <p className="form-error" data-role="start-run-error">
                {error}
              </p>
            ) : null}

            <div className="drawer-actions">
              <button
                type="submit"
                className="btn btn-primary"
                data-role="start-run-submit"
                disabled={busy || resolved.agent === null || agentMissing}
              >
                ▶ 发起执行
              </button>
              <button type="button" className="btn" onClick={props.onCancel}>
                取消
              </button>
              <a className="btn" data-role="start-run-dashboard" href={dashboardHref} target="_blank" rel="noreferrer">
                去执行看板
              </a>
            </div>
            <p className="muted small" data-role="start-run-boundary">
              看板只负责「发起」;取消 / 重试 / 审批 / 合并仍在执行看板完成。
            </p>
          </>
        )}
      </form>
    </div>
  )
}
