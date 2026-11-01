/**
 * `scripts/verify-superagent-offline.mjs` 的纯函数用例（change `adopt-superagent-openspec-source`）。
 *
 * 演练本体需要 Super-agent 源码仓库与真实 git，不进 `pnpm verify`；这里只钉住参数解析与
 * "真实 Ticket → 面板投影输入"的映射，避免脚本本身悄悄写错形状。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs, ticketView } from './verify-superagent-offline.mjs'

test('parseArgs reads --superagent/--keep and rejects unknown flags', () => {
  assert.deepEqual(parseArgs(['--superagent', '/p', '--keep']), { superagent: '/p', keep: true })
  assert.deepEqual(parseArgs([]), { superagent: process.env.SUPERAGENT_ROOT ?? '' })
  assert.throws(() => parseArgs(['--nope']), /未知参数/)
})

test('ticketView mirrors the management API summary shape', () => {
  const ticket = {
    id: 't1',
    title: '加一行',
    ended: { at: '2026-11-01T19:10:00.000Z', by: 'executor', outcome: 'merged' },
    execution: { name: 'readme-line-8045739609c6', directory: '/repo/.workmates/readme-line-8045739609c6', assignment: '' },
    attention: { id: 'a1', question: '用哪个分支？' },
    assignments: [],
  }
  const stage = () => ({ stage: 'ended' })
  const view = ticketView(ticket, stage)
  assert.equal(view.id, 't1')
  assert.equal(view.title, '加一行')
  assert.equal(view.ended.outcome, 'merged')
  assert.equal(view.directory, '/repo/.workmates/readme-line-8045739609c6')
  assert.equal(view.attention.question, '用哪个分支？')
  // 只投影面板真正读的字段：Ticket 的其它字段不该出现在视图里。
  assert.equal('execution' in view, false)
  assert.equal('assignments' in view, false)
})

test('ticketView maps a person stage through', () => {
  const view = ticketView(
    { id: 't1', title: 'x', attention: { id: 'a1', question: 'q' }, assignments: [] },
    () => ({ stage: 'person', action: 'answer' }),
  )
  assert.equal(view.stage, 'person')
  assert.equal(view.action, 'answer')
})
