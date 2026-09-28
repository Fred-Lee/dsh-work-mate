/**
 * 「🚀 转为提案」— the conversation→WorkMate scene switch (change
 * `rework-panel-ux-and-chat-entry`). Rendered on BOTH the assistant-message
 * action row (`conversation.chat.assistant-actions`) and the input tool area
 * (`conversation.input.left`, the Codingns4DSH quick-phrase position): after a
 * brainstorm, one click opens a small form, the proposal is created through
 * the same REST the panel uses, and "打开面板" lands the user on the kanban.
 *
 * No session content is read — the form only asks for a title (id is
 * auto-generated host-side), so the action stays honest about what it does.
 */
import { useState } from 'react'
import type { FormEvent } from 'react'
import type { AssistantActionInjected } from './slot-types'
import { createProposal } from './api'
import { PANEL_STYLE } from './styles'

export interface ChatProposalActionProps extends Partial<AssistantActionInjected> {
  /** Injection seam for tests. */
  create?: typeof createProposal
  /** Where "打开面板" navigates (overridable in tests). */
  panelUrl?: string
}

export function ChatProposalAction(props: ChatProposalActionProps): JSX.Element {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [projectRoot, setProjectRoot] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [createdId, setCreatedId] = useState<string | null>(null)
  const create = props.create ?? createProposal
  const panelUrl = props.panelUrl ?? '/workmate/'

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (!title.trim() || busy) return
    setBusy(true)
    setError('')
    const result = await create({
      title: title.trim(),
      ...(projectRoot.trim() ? { projectRoot: projectRoot.trim() } : {}),
    }).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
      return undefined
    })
    if (result === undefined) return
    setCreatedId(result.proposal.id)
    setBusy(false)
  }

  function reset(): void {
    setOpen(false)
    setTitle('')
    setProjectRoot('')
    setCreatedId(null)
    setError('')
    setBusy(false)
  }

  return (
    <>
      <button
        type="button"
        className="wm-chat-trigger"
        data-role="wm-chat-trigger"
        title="把这段讨论转为 WorkMate 提案，进入开发流程"
        onClick={() => setOpen(true)}
      >
        🚀 转为提案
      </button>

      {open && (
        <div className="wm-modal" onClick={reset}>
          <form
            className="wm-modal-box"
            onClick={(event) => event.stopPropagation()}
            onSubmit={(event) => void submit(event)}
          >
            <style dangerouslySetInnerHTML={{ __html: PANEL_STYLE }} />
            <h3>🚀 转为提案</h3>
            <div className="wm-field">
              <label>标题（必填）</label>
              <input
                autoFocus
                value={title}
                placeholder="比如：批量批改 v2.1"
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>
            <div className="wm-field">
              <label>项目根（可选）</label>
              <input
                value={projectRoot}
                placeholder="/abs/path/to/project"
                onChange={(event) => setProjectRoot(event.target.value)}
              />
            </div>
            {error !== '' && <div className="wm-error" style={{ margin: '0 0 8px' }}>{error}</div>}
            {createdId !== null ? (
              <div className="wm-ok-note">
                ✓ 已创建 <code>{createdId}</code> —{' '}
                <a href={panelUrl} target="_blank" rel="noreferrer" onClick={reset}>
                  打开面板
                </a>
              </div>
            ) : (
              <div className="wm-modal-foot">
                <button className="wm-btn" type="button" onClick={reset}>
                  取消
                </button>
                <button className="wm-btn primary" type="submit" disabled={busy}>
                  创建提案
                </button>
              </div>
            )}
          </form>
        </div>
      )}
    </>
  )
}
