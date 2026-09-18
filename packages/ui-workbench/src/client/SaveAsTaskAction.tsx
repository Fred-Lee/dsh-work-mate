/**
 * 「保存为任务」 — the chat-message action registered at
 * `conversation.chat.assistant-actions` (change `add-task-kanban-board` task 5.4).
 *
 * Renders an action button on the assistant-message action row; clicking it
 * opens a small dialog that cuts a task card from the CURRENT conversation.
 * The dialog does not ask for a repo: the host resolves it from the session's
 * own cwd (see `save-as-task.ts`), and a failure to do so comes back as a
 * specific refusal shown verbatim.
 *
 * Hidden (returns `null`) when there is no usable session context — the slot is
 * session-scoped so this is rare, but an action that cannot name its
 * conversation must not offer itself.
 */
import { useState } from 'react'
import type { FormEvent } from 'react'
import type { AssistantActionInjected } from './slot-types'
import { DEFAULT_WORKBENCH_BASE, saveAsTask, type SaveAsTaskOutcome } from './save-as-task'

/** Default mount of the kanban page, for the "open the new card" link. */
const DEFAULT_BOARD_MOUNT = '/helmsman-board'

export interface SaveAsTaskActionProps extends AssistantActionInjected {
  /** Overridable for tests / non-default mounts. */
  workbenchBase?: string
  boardMount?: string
  /** Injection seam so tests drive the pure logic without a network. */
  save?: typeof saveAsTask
}

export function SaveAsTaskAction(props: SaveAsTaskActionProps): JSX.Element | null {
  const { sessionId } = props
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<SaveAsTaskOutcome | null>(null)

  // No conversation ⇒ nothing to file. (The slot's scope already guarantees a
  // session, but a blank id is not a conversation either.)
  if (typeof sessionId !== 'string' || sessionId === '') return null

  const save = props.save ?? saveAsTask
  const boardMount = (props.boardMount ?? DEFAULT_BOARD_MOUNT).replace(/\/+$/, '')

  function close(): void {
    setOpen(false)
    setTitle('')
    setOutcome(null)
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    setBusy(true)
    setOutcome(null)
    const result = await save(
      { title, sessionId },
      props.workbenchBase ? { base: props.workbenchBase } : {},
    )
    setOutcome(result)
    setBusy(false)
  }

  return (
    <>
      <button
        type="button"
        className="hls-mini"
        data-role="save-as-task"
        title="把这段对话存成一张看板卡片"
        onClick={() => setOpen(true)}
      >
        💾 保存为任务
      </button>

      {open && (
        <div className="hls-modal" data-role="save-as-task-form" onClick={close}>
          <form
            className="hls-modal-box"
            data-role="save-as-task-body"
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => void submit(event)}
          >
            <div className="hls-modal-head">
              <h3 className="hls-drawer-title">💾 保存为任务</h3>
              <button type="button" className="hls-close" data-role="save-as-task-cancel" onClick={close}>
                ✕
              </button>
            </div>
            <div className="hls-body">
              <p className="hls-empty" data-role="save-as-task-source">
                来源会话:<code>{sessionId}</code>
              </p>

              {outcome?.ok ? (
                <div data-role="save-as-task-done">
                  <p data-role="save-as-task-id">
                    已建档:<strong>{outcome.id}</strong>
                    {outcome.stageLabel ? ` · ${outcome.stageLabel}` : ''}
                  </p>
                  <p className="hls-empty" data-role="save-as-task-summary-source">
                    {outcome.summarySource === 'model'
                      ? `摘要由模型生成(读了 ${outcome.contextMessages ?? 0} 条消息)`
                      : `摘要未走模型(generatedBy=${outcome.summarySource ?? '—'}),可在卡片内手工改写`}
                  </p>
                  {outcome.warnings && outcome.warnings.length > 0 && (
                    <p className="hls-empty" data-role="save-as-task-warnings">
                      ⚠️ 卡片已建立,但:{outcome.warnings.join(';')}
                    </p>
                  )}
                  <div className="hls-actions">
                    <a
                      className="hls-btn"
                      data-role="save-as-task-open-card"
                      href={`${boardMount}/?card=${encodeURIComponent(outcome.id ?? '')}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      去看看板卡片
                    </a>
                    <button type="button" className="hls-btn" onClick={close}>
                      完成
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <label className="hls-field">
                    <span>卡片标题</span>
                    <input
                      className="hls-input"
                      data-role="save-as-task-title"
                      value={title}
                      placeholder="用一句话描述这个任务"
                      onChange={(event) => setTitle(event.target.value)}
                    />
                  </label>
                  <p className="hls-empty" data-role="save-as-task-repo-hint">
                    仓库取该会话的工作目录;若会话没有可解析的 cwd,宿主会明确拒绝而不是猜一个。
                  </p>
                  {outcome && (
                    <p className="hls-form-error" data-role="save-as-task-error">
                      {outcome.reason}
                    </p>
                  )}
                  <div className="hls-actions">
                    <button
                      type="submit"
                      className="hls-btn"
                      data-role="save-as-task-submit"
                      disabled={busy || title.trim() === ''}
                    >
                      {busy ? '建档中…' : '建立卡片'}
                    </button>
                    <button type="button" className="hls-btn" onClick={close}>
                      取消
                    </button>
                  </div>
                </>
              )}
            </div>
          </form>
        </div>
      )}
    </>
  )
}
