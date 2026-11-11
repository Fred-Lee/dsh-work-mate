/**
 * 任务投影的判定顺序（整体体检 #5）。
 *
 * 关键区分：**「从未指派」与「本地点了停止」是两种事实**，但 `stop()` 把
 * `abandoned=true` 与 `assigned=false` 一起写，旧实现把两者压进 `unassigned`，
 * 于是卡片同时显示「未指派」徽标和「重新打开」主按钮（自相矛盾）。
 *
 * 这里锁三件事：
 *   1. abandoned 且**没有** Ticket → 待办·stopped（可重新打开）；
 *   2. 只是没指派 → 待办·unassigned；
 *   3. abandoned 但 Ticket 已结束 → **已完成**（Ticket 事实优先，不能因为本地标记
 *      还在就把它拉回待办列）。
 */
import { describe, expect, it } from 'vitest'
import { LANES, projectTask, SUBSTATE_LABEL } from './project.ts'

const task = (overrides: Partial<{ assigned: boolean; abandoned: boolean; attempt: number }> = {}) => ({
  id: 'task-1',
  assigned: true,
  abandoned: false,
  attempt: 1,
  ...overrides,
})

describe('projectTask 的停止/未指派判定', () => {
  it('停止且没有 Ticket → 待办·已停止（不是「未指派」）', () => {
    const projection = projectTask({ task: task({ assigned: false, abandoned: true }), submitted: false })
    expect(projection).toEqual({ lane: 'todo', substate: 'stopped' })
    // 徽标与主按钮因此自洽：已停止 + 重新打开。
    expect(SUBSTATE_LABEL[projection.substate]).toBe('已停止')
  })

  it('只是没有指派 → 待办·未指派', () => {
    const projection = projectTask({ task: task({ assigned: false }), submitted: false })
    expect(projection).toEqual({ lane: 'todo', substate: 'unassigned' })
  })

  it('停止但 Ticket 已结束 → 已完成（Ticket 事实优先）', () => {
    const projection = projectTask({
      task: task({ assigned: false, abandoned: true }),
      submitted: true,
      ticket: { id: 't-1', title: 'x', stage: 'ended', ended: { outcome: 'stopped' } },
    })
    expect(projection.lane).toBe('done')
    expect(projection.substate).toBe('stopped')
  })
})

describe('列定义只有一份真源', () => {
  it('待办列头同时提到「未指派」与「已停止」', () => {
    const todo = LANES.find((lane) => lane.key === 'todo')
    expect(todo?.hint).toBe('未指派 / 已停止')
  })

  it('已完成列头不承诺时间窗', () => {
    const done = LANES.find((lane) => lane.key === 'done')
    // 文案比实现多承诺一件事就是误导：done 判定没有 24 小时过滤（#6）。
    expect(done?.hint).toBe('Ticket 已结束')
    expect(done?.hint).not.toContain('24')
  })
})
