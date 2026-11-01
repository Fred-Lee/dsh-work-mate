import { describe, expect, it } from 'vitest'
import type { Trigger } from './contract.ts'
import type { InputRow, TaskRecord } from './files.ts'
import { buildInputTrigger, buildTaskTrigger, healthSummaryOf, scanOnce, type WatchHost } from './watch.ts'
import type { TaskGateStatus } from './gate.ts'

const task = (id: string, overrides: Partial<TaskRecord> = {}): TaskRecord => ({
  id,
  title: id,
  intent: `做 ${id}`,
  repo: 'dsh-Helmsman',
  baseBranch: 'main',
  acceptance: 'ok',
  priority: 'P2',
  mode: 'superagent',
  dependsOn: [],
  assigned: true,
  abandoned: false,
  attempt: 1,
  createdBy: 'workmate:fred',
  createdAt: '2026-11-02T00:00:00.000Z',
  updatedAt: '2026-11-02T00:00:00.000Z',
  ...overrides,
})

const input = (seq: number, taskId: string, text = `回答 ${seq}`): InputRow => ({
  seq,
  taskId,
  text,
  by: 'workmate:fred',
  at: '2026-11-02T00:00:00.000Z',
})

function fakeHost(options: { terminals?: Record<string, TaskGateStatus>; cursor?: number } = {}): {
  host: WatchHost
  received: Trigger[]
  duplicates: string[]
  cursorWrites: number[]
} {
  const received: Trigger[] = []
  const duplicates: string[] = []
  const cursorWrites: number[] = []
  let cursor = options.cursor ?? 0
  const host: WatchHost = {
    async receive(trigger) {
      const duplicate = received.some((entry) => entry.id === trigger.id)
      if (duplicate) {
        duplicates.push(trigger.id)
        return { stored: false, duplicate: true }
      }
      received.push(trigger)
      return { stored: true }
    },
    terminalOf: (taskId) => options.terminals?.[taskId],
    readCursor: () => cursor,
    writeCursor: (seq) => {
      cursor = seq
      cursorWrites.push(seq)
    },
  }
  return { host, received, duplicates, cursorWrites }
}

const base = { maxPerScan: 5, interactive: true, now: () => new Date('2026-11-02T00:10:00.000Z') }

describe('buildTaskTrigger', () => {
  it('字段与 spec 一致', () => {
    const trigger = buildTaskTrigger(task('task-1', { attempt: 2, ports: [3000, 3001] }), '2026-11-02T00:00:00.000Z')
    expect(trigger.id).toBe('workmate:task-1:2')
    expect(trigger.threads).toEqual([{ source: 'workmate', id: 'task-1' }])
    expect(trigger.actor).toEqual({ source: 'workmate', id: 'workmate:fred' })
    expect(trigger.human).toBe(true)
    expect(trigger.addressed).toBe('mention')
    expect(trigger.channel?.address).toEqual({ taskId: 'task-1' })
    expect(trigger.meta['ports']).toEqual([3000, 3001])
    expect(trigger.text).toBe('做 task-1')
  })

  it('带提案时写入 meta.proposalId', () => {
    const trigger = buildTaskTrigger(task('task-1', { proposalId: 'add-thing' }), 't')
    expect(trigger.meta['proposalId']).toBe('add-thing')
  })
})

describe('buildInputTrigger', () => {
  it('同一 Thread、确定性 ID、带 replyTo', () => {
    const trigger = buildInputTrigger(input(7, 'task-1', '允许升级'), task('task-1'))
    expect(trigger.id).toBe('workmate:task-1:in:7')
    expect(trigger.threads).toEqual([{ source: 'workmate', id: 'task-1' }])
    expect(trigger.human).toBe(true)
    expect(trigger.addressed).toBe('mention')
    expect(trigger.text).toBe('允许升级')
  })

  it('agent 的 from 用行的 by', () => {
    const trigger = buildInputTrigger({ ...input(1, 'task-1'), by: 'workmate:lisi' }, task('task-1'))
    expect(trigger.actor).toEqual({ source: 'workmate', id: 'workmate:lisi' })
  })
})

describe('scanOnce', () => {
  it('投递已指派、依赖满足的待办', async () => {
    const fake = fakeHost()
    const outcome = await scanOnce(fake.host, { ...base, tasks: [task('a'), task('b')], inputs: [] })
    expect(outcome.submitted).toEqual(['a', 'b'])
    expect(fake.received).toHaveLength(2)
  })

  it('跳过未指派与已放弃', async () => {
    const fake = fakeHost()
    const outcome = await scanOnce(fake.host, {
      ...base,
      tasks: [task('a', { assigned: false }), task('b', { abandoned: true })],
      inputs: [],
    })
    expect(outcome.submitted).toEqual([])
  })

  it('依赖未满足时不投递', async () => {
    const fake = fakeHost()
    const outcome = await scanOnce(fake.host, {
      ...base,
      tasks: [task('a'), task('b', { dependsOn: ['a'] })],
      inputs: [],
    })
    expect(outcome.submitted).toEqual(['a'])
    expect(outcome.waitingOnDependency).toEqual(['b'])
  })

  it('依赖完成后再投递', async () => {
    const fake = fakeHost({ terminals: { a: 'merged' } })
    const outcome = await scanOnce(fake.host, {
      ...base,
      tasks: [task('a'), task('b', { dependsOn: ['a'] })],
      inputs: [],
    })
    expect(outcome.submitted).toEqual(['a', 'b'])
  })

  it('依赖受阻时列入 blockedByDependency', async () => {
    const fake = fakeHost({ terminals: { a: 'stopped' } })
    const outcome = await scanOnce(fake.host, {
      ...base,
      tasks: [task('a'), task('b', { dependsOn: ['a'] })],
      inputs: [],
    })
    expect(outcome.blockedByDependency).toEqual(['b'])
  })

  it('同一轮重复不产生第二个 Trigger（由 receive 去重）', async () => {
    const fake = fakeHost()
    await scanOnce(fake.host, { ...base, tasks: [task('a')], inputs: [] })
    const second = await scanOnce(fake.host, { ...base, tasks: [task('a')], inputs: [] })
    expect(second.duplicates).toEqual(['a'])
    expect(fake.received).toHaveLength(1)
  })

  it('回答优先于新任务且不受 maxPerScan 限制', async () => {
    const fake = fakeHost()
    const outcome = await scanOnce(fake.host, {
      ...base,
      maxPerScan: 1,
      tasks: [task('a'), task('b'), task('c')],
      inputs: [input(1, 'a'), input(2, 'b')],
    })
    expect(outcome.replied).toEqual([1, 2])
    expect(outcome.submitted).toHaveLength(1)
    expect(outcome.deferred).toBe(2)
    // 前两条是回答，最后一条才是新任务
    expect(fake.received.slice(0, 2).map((t) => t.id)).toEqual(['workmate:a:in:1', 'workmate:b:in:2'])
  })

  it('游标持久化：已消费的回答不重放', async () => {
    const fake = fakeHost()
    await scanOnce(fake.host, { ...base, tasks: [task('a')], inputs: [input(1, 'a')] })
    const second = await scanOnce(fake.host, { ...base, tasks: [task('a')], inputs: [input(1, 'a')] })
    expect(second.replied).toEqual([])
    expect(fake.cursorWrites).toEqual([1])
  })

  it('只读模式不投递但推进游标', async () => {
    const fake = fakeHost()
    const outcome = await scanOnce(fake.host, {
      ...base,
      interactive: false,
      tasks: [task('a')],
      inputs: [input(1, 'a')],
    })
    expect(outcome.submitted).toEqual([])
    expect(outcome.replied).toEqual([])
    expect(outcome.readOnly).toBe(1)
    expect(fake.received).toHaveLength(0)
    expect(fake.cursorWrites).toEqual([1])
  })

  it('待办被删除时跳过该行但仍推进游标', async () => {
    const fake = fakeHost()
    const outcome = await scanOnce(fake.host, { ...base, tasks: [], inputs: [input(1, 'ghost')] })
    expect(outcome.replied).toEqual([])
    expect(fake.cursorWrites).toEqual([1])
    expect(fake.received).toHaveLength(0)
  })

  it('环被报告', async () => {
    const fake = fakeHost()
    const outcome = await scanOnce(fake.host, {
      ...base,
      tasks: [task('a', { dependsOn: ['b'] }), task('b', { dependsOn: ['a'] })],
      inputs: [],
    })
    expect(outcome.cycles.length).toBeGreaterThan(0)
    expect(outcome.submitted).toEqual([])
  })
})

describe('healthSummaryOf', () => {
  it('只读模式给只读摘要', () => {
    const summary = healthSummaryOf(
      { submitted: [], replied: [], duplicates: [], deferred: 0, waitingOnDependency: ['x'], blockedByDependency: [], cycles: [], readOnly: 3 },
      [],
    )
    expect(summary.detail).toContain('只读')
    expect(summary.detail).toContain('等待依赖')
  })

  it('正常投递给投递摘要', () => {
    const summary = healthSummaryOf(
      { submitted: ['a'], replied: [1], duplicates: [], deferred: 2, waitingOnDependency: [], blockedByDependency: [], cycles: [], readOnly: 0 },
      [],
    )
    expect(summary.detail).toContain('投递 1')
    expect(summary.detail).toContain('回答 1')
    expect(summary.detail).toContain('待投递 2')
    expect(summary.state).toBe('ready')
  })

  it('有环时暂停', () => {
    const summary = healthSummaryOf(
      { submitted: [], replied: [], duplicates: [], deferred: 0, waitingOnDependency: [], blockedByDependency: [], cycles: [['a', 'b', 'a']], readOnly: 0 },
      [],
    )
    expect(summary.state).toBe('paused')
  })
})
