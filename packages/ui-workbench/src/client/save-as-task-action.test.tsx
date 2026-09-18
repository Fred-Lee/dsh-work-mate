// @vitest-environment jsdom
/**
 * 「保存为任务」 chat-message action tests (jsdom + @testing-library).
 *
 * Locked behaviours (change `add-task-kanban-board` task 5.4):
 *  1. Renders on the assistant action row and opens its dialog.
 *  2. Hidden when there is no session context — an action that cannot name its
 *     conversation must not offer itself.
 *  3. Submits `{ title, sessionId }` through the EXISTING host route; the repo
 *     is never guessed by the browser.
 *  4. A refusal is shown verbatim, and the dialog stays open so it can be fixed.
 *  5. Success reports the new card id and links to it.
 */
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SaveAsTaskAction } from './SaveAsTaskAction'
import { saveAsTask, type SaveAsTaskOutcome } from './save-as-task'

configure({ asyncUtilTimeout: 5_000 })
afterEach(cleanup)

/** The injectable save seam, typed as the real function so `mock.calls` is checked. */
type SaveFn = typeof saveAsTask

function renderAction(over: Partial<Parameters<typeof SaveAsTaskAction>[0]> = {}) {
  const save = vi.fn<SaveFn>(async (): Promise<SaveAsTaskOutcome> => ({ ok: true, id: 'wi_new' }))
  render(<SaveAsTaskAction sessionId="sess-1" save={save} {...over} />)
  return { save }
}

/** Types a title and submits the dialog. */
async function submitWith(title: string): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: /保存为任务/ }))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: title } })
  fireEvent.click(screen.getByRole('button', { name: '建立卡片' }))
}

describe('SaveAsTaskAction: entry', () => {
  it('renders the action on the assistant action row', () => {
    renderAction()
    expect(screen.getByRole('button', { name: /保存为任务/ })).toBeTruthy()
  })

  it('is hidden when the injected session context is empty', () => {
    renderAction({ sessionId: '' })
    expect(screen.queryByRole('button', { name: /保存为任务/ })).toBeNull()
  })

  it('does not render the dialog until the action is clicked', () => {
    renderAction()
    expect(screen.queryByText('来源会话:', { exact: false })).toBeNull()
  })

  it('shows which conversation the card will be cut from', () => {
    renderAction()
    fireEvent.click(screen.getByRole('button', { name: /保存为任务/ }))
    expect(screen.getByText('sess-1')).toBeTruthy()
  })
})

describe('SaveAsTaskAction: submit', () => {
  it('keeps submit disabled until a title is entered', () => {
    renderAction()
    fireEvent.click(screen.getByRole('button', { name: /保存为任务/ }))
    const submit = screen.getByRole('button', { name: '建立卡片' }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '实现检索' } })
    expect(submit.disabled).toBe(false)
  })

  it('sends the trimmed title with the current session id', async () => {
    const { save } = renderAction()
    await submitWith('  实现检索  ')

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(save).toHaveBeenCalledWith(
      { title: '  实现检索  ', sessionId: 'sess-1' },
      expect.anything(),
    )
  })

  // The repo comes from the session's cwd on the host side (TASK-MODEL §9).
  // Sending a repo from the browser would be a second, divergent guess.
  it('never sends a repo of its own', async () => {
    const { save } = renderAction()
    await submitWith('实现检索')

    await waitFor(() => expect(save).toHaveBeenCalled())
    const [input] = save.mock.calls[0]!
    expect(Object.keys(input).sort()).toEqual(['sessionId', 'title'])
  })
})

describe('SaveAsTaskAction: outcome', () => {
  it('reports the new card and links to it', async () => {
    renderAction({ save: async () => ({ ok: true, id: 'wi_42', stageLabel: '需求分析' }) })
    await submitWith('实现检索')

    await waitFor(() => expect(screen.getByText(/wi_42/)).toBeTruthy())
    expect(screen.getByText(/需求分析/)).toBeTruthy()
    const link = screen.getByRole('link', { name: '去看看板卡片' }) as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('/helmsman-board/?card=wi_42')
  })

  it('says plainly when the summary did not come from a model', async () => {
    renderAction({
      save: async () => ({ ok: true, id: 'wi_1', summarySource: 'fallback', contextMessages: 0 }),
    })
    await submitWith('实现检索')

    await waitFor(() => expect(screen.getByText(/generatedBy=fallback/)).toBeTruthy())
  })

  it('surfaces host warnings without pretending the card failed', async () => {
    renderAction({
      save: async () => ({ ok: true, id: 'wi_1', warnings: ['摘要回写失败'] }),
    })
    await submitWith('实现检索')

    await waitFor(() => expect(screen.getByText(/摘要回写失败/)).toBeTruthy())
    expect(screen.getByRole('link', { name: '去看看板卡片' })).toBeTruthy()
  })

  // A refusal is the host's wording ("invalid repo: 需要 repo 或
  // projectGroup…"), which is what tells the user how to unblock themselves.
  it('shows a refusal verbatim and keeps the dialog usable', async () => {
    renderAction({
      save: async () => ({ ok: false, reason: 'invalid repo: 需要 repo 或 projectGroup' }),
    })
    await submitWith('实现检索')

    await waitFor(() => expect(screen.getByText('invalid repo: 需要 repo 或 projectGroup')).toBeTruthy())
    expect(screen.getByRole('textbox')).toBeTruthy()
    expect(screen.queryByRole('link', { name: '去看看板卡片' })).toBeNull()
  })

  it('can be retried after a refusal', async () => {
    const save = vi
      .fn<SaveFn>()
      .mockResolvedValueOnce({ ok: false, reason: 'invalid repo' })
      .mockResolvedValueOnce({ ok: true, id: 'wi_1' })
    renderAction({ save })

    await submitWith('实现检索')
    await waitFor(() => expect(screen.getByText('invalid repo')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: '建立卡片' }))
    await waitFor(() => expect(screen.getByRole('link', { name: '去看看板卡片' })).toBeTruthy())
    expect(save).toHaveBeenCalledTimes(2)
  })
})
