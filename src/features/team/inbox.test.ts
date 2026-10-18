import { describe, expect, it } from 'vitest'
import { TeamInbox, validateWorkerDone } from './inbox.ts'

const task = { id: 't1', role: 'backend-dev' as const }

describe('validateWorkerDone', () => {
  it('requires a summary or report for every done claim', () => {
    expect(validateWorkerDone(task, { status: 'done' })).toHaveLength(1)
    expect(validateWorkerDone(task, { status: 'done', outcome: 'tests pass' })).toEqual([])
  })

  it('requires reportPath for tester/reviewer', () => {
    expect(validateWorkerDone({ id: 't1', role: 'integration-tester' }, { status: 'done', outcome: 'ok' })[0]).toContain(
      'reportPath',
    )
    expect(
      validateWorkerDone({ id: 't1', role: 'reviewer' }, { status: 'done', reportPath: 'REVIEW.md' }),
    ).toEqual([])
  })

  it('does not demand proof for failed/blocked outcomes', () => {
    expect(validateWorkerDone(task, { status: 'failed' })).toEqual([])
    expect(validateWorkerDone(task, { status: 'blocked' })).toEqual([])
  })
})

describe('TeamInbox', () => {
  it('posts, answers and acks a question without closing it silently', () => {
    const inbox = new TeamInbox(() => new Date('2026-10-19T00:00:00.000Z'))
    const question = inbox.post({ runId: 'r1', kind: 'question', taskId: 't1', body: '用哪个分支？' })
    expect(inbox.hasBlocking('r1')).toBe(true)
    expect(inbox.take('r1')?.id).toBe(question.id)

    const answered = inbox.answer(question.id, '用 feature/p1')
    expect(answered.status).toBe('answered')
    expect(inbox.hasBlocking('r1')).toBe(false)
    expect(inbox.ack(question.id).status).toBe('acked')
  })

  it('rejects invalid messages', () => {
    const inbox = new TeamInbox()
    expect(() => inbox.post({ runId: 'r1', kind: 'question', body: '  ' })).toThrow()
    expect(() => inbox.post({ runId: 'r1', kind: 'worker_done', body: 'done' })).toThrow('taskId')
    const done = inbox.post({ runId: 'r1', kind: 'worker_done', taskId: 't1', body: 'done' })
    expect(() => inbox.answer(done.id, 'ok')).toThrow('not a question')
  })

  it('keeps runs isolated and answers only once', () => {
    const inbox = new TeamInbox()
    const q = inbox.post({ runId: 'r1', kind: 'escalation', body: '需要人决定' })
    inbox.post({ runId: 'r2', kind: 'question', body: '别的 run' })
    expect(inbox.open('r1')).toHaveLength(1)
    inbox.answer(q.id, '决定 A')
    expect(() => inbox.answer(q.id, 'again')).toThrow('already answered')
  })
})
