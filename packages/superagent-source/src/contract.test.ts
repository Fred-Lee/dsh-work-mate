/**
 * 结构契约的用例（task 2）。夹具是**手写的 JSON**，不是从对方代码生成的——
 * 这份文件的职责就是在对方字段漂移时先红，所以它必须独立于对方实现。
 */
import { describe, expect, it } from 'vitest'
import {
  ContractError,
  channelRef,
  inputTriggerId,
  parseTicket,
  threadKey,
  threadRef,
  triggerId,
} from './contract.ts'

const ticketFixture = {
  id: 'tkt-1',
  title: '把团队 Run 的同步调用改成 start / stop',
  channels: [{ source: 'workmate', thread: 'task-1', address: { taskId: 'task-1' } }],
  assignments: [{ id: 'asg-1', state: 'running', createdAt: '2026-11-01T00:00:00.000Z' }],
  execution: { name: 'workmate-task-1-abcdef123456', directory: '/repo/.workmates/workmate-task-1-abcdef123456', assignment: 'do it' },
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:05:00.000Z',
}

describe('parseTicket', () => {
  it('读出一条在执行的 Ticket', () => {
    const ticket = parseTicket(ticketFixture)
    expect(ticket.id).toBe('tkt-1')
    expect(ticket.ended).toBeUndefined()
    expect(ticket.attention).toBeUndefined()
    expect(ticket.execution?.directory).toBe('/repo/.workmates/workmate-task-1-abcdef123456')
    expect(ticket.assignments).toHaveLength(1)
  })

  it('接受管理 API 拍平的 directory 字段', () => {
    const { execution: _drop, ...flat } = ticketFixture
    const ticket = parseTicket({ ...flat, directory: '/repo/.workmates/workmate-x-1234' })
    expect(ticket.execution?.directory).toBe('/repo/.workmates/workmate-x-1234')
  })

  it('空 directory 不合成 execution', () => {
    const { execution: _drop, ...flat } = ticketFixture
    expect(parseTicket({ ...flat, directory: '' }).execution).toBeUndefined()
  })

  it('读出待回答的提问', () => {
    const ticket = parseTicket({
      ...ticketFixture,
      attention: { id: 'att-1', question: '测试依赖是否允许升级？' },
    })
    expect(ticket.attention?.question).toBe('测试依赖是否允许升级？')
  })

  it('覆盖五种终态', () => {
    for (const outcome of ['completed', 'merged', 'closed', 'dropped', 'stopped'] as const) {
      const ticket = parseTicket({
        ...ticketFixture,
        ended: { at: '2026-11-01T01:00:00.000Z', by: 'executor', outcome },
      })
      expect(ticket.ended?.outcome).toBe(outcome)
    }
  })

  it('未知终态视为契约漂移', () => {
    expect(() =>
      parseTicket({ ...ticketFixture, ended: { at: 'x', by: 'executor', outcome: 'finished' } }),
    ).toThrowError(ContractError)
  })

  it('缺少 id 时报可读错误并带字段路径', () => {
    expect(() => parseTicket({ title: 'no id' })).toThrowError(/ticket\.id/)
  })

  it('非对象输入被拒绝', () => {
    expect(() => parseTicket(null)).toThrowError(/ticket/)
    expect(() => parseTicket([1, 2])).toThrowError(/ticket/)
  })

  it('保留未知字段，不因对方新增而失败', () => {
    const ticket = parseTicket({ ...ticketFixture, mandate: { strength: 'explicit' }, inputs: [] })
    expect(ticket['mandate']).toEqual({ strength: 'explicit' })
  })
})

describe('确定性 ID', () => {
  it('同一 attempt 得到同一个 Trigger ID', () => {
    expect(triggerId('task-1', 1)).toBe('workmate:task-1:1')
    expect(triggerId('task-1', 1)).toBe(triggerId('task-1', 1))
    expect(triggerId('task-1', 2)).not.toBe(triggerId('task-1', 1))
  })

  it('回答按 seq 生成 ID', () => {
    expect(inputTriggerId('task-1', 7)).toBe('workmate:task-1:in:7')
  })

  it('Thread key 与 ref 一致', () => {
    expect(threadKey('task-1')).toBe('workmate:task-1')
    expect(threadRef('task-1')).toEqual({ source: 'workmate', id: 'task-1' })
    expect(channelRef('task-1').address['taskId']).toBe('task-1')
  })
})
