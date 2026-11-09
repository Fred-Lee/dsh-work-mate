import { describe, expect, it } from 'vitest'
import { evaluateGate, findCycles, selectForScan, type GateTask, type TaskGateStatus } from './gate.ts'

const task = (id: string, overrides: Partial<GateTask> = {}): GateTask & { priority?: string; createdAt?: string } => ({
  id,
  dependsOn: [],
  assigned: true,
  abandoned: false,
  repo: '',
  ...overrides,
})

const terminalMap = (entries: Record<string, TaskGateStatus>) => (id: string) => entries[id]

describe('evaluateGate', () => {
  it('无依赖且已指派即可投递', () => {
    const gate = evaluateGate({ tasks: [task('a')], terminalOf: () => undefined })
    expect(gate.ready.map((entry) => entry.id)).toEqual(['a'])
    expect(gate.waiting).toEqual([])
  })

  it('未指派不投递', () => {
    const gate = evaluateGate({ tasks: [task('a', { assigned: false })], terminalOf: () => undefined })
    expect(gate.ready).toEqual([])
  })

  it('放弃的待办永不投递', () => {
    const gate = evaluateGate({ tasks: [task('a', { abandoned: true })], terminalOf: () => undefined })
    expect(gate.ready).toEqual([])
  })

  it('前置未完成时等待', () => {
    const gate = evaluateGate({
      tasks: [task('a'), task('b', { dependsOn: ['a'] })],
      terminalOf: terminalMap({}),
    })
    expect(gate.ready.map((entry) => entry.id)).toEqual(['a'])
    expect(gate.waiting).toHaveLength(1)
    expect(gate.waiting[0]?.pending).toEqual(['a'])
  })

  it('前置 completed/merged/closed 都算完成', () => {
    for (const status of ['completed', 'merged', 'closed'] as const) {
      const gate = evaluateGate({
        tasks: [task('a'), task('b', { dependsOn: ['a'] })],
        terminalOf: terminalMap({ a: status }),
      })
      expect(gate.ready.map((entry) => entry.id)).toEqual(['a', 'b'])
    }
  })

  it('前置 stopped/dropped 不会被当成完成', () => {
    for (const status of ['stopped', 'dropped'] as const) {
      const gate = evaluateGate({
        tasks: [task('a'), task('b', { dependsOn: ['a'] })],
        terminalOf: terminalMap({ a: status }),
      })
      expect(gate.ready.map((entry) => entry.id)).toEqual(['a'])
      expect(gate.waiting[0]?.dead).toEqual(['a'])
    }
  })

  it('前置不存在时列出 missing', () => {
    const gate = evaluateGate({
      tasks: [task('b', { dependsOn: ['ghost'] })],
      terminalOf: () => undefined,
    })
    expect(gate.waiting[0]?.missing).toEqual(['ghost'])
  })

  it('repo 随 ready 一起带出，但门控本身不按仓库过滤（design D3：过滤在 scanOnce）', () => {
    const gate = evaluateGate({
      tasks: [task('a', { repo: '/srv/a' }), task('b', { repo: '/srv/b' })],
      terminalOf: () => undefined,
    })
    // 两条都放行——"这个仓库归不归我"不是依赖门控的问题。
    expect(gate.ready.map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(gate.ready.map((entry) => entry.repo)).toEqual(['/srv/a', '/srv/b'])
  })

  it('链式依赖逐级放行', () => {
    const tasks = [task('a'), task('b', { dependsOn: ['a'] }), task('c', { dependsOn: ['b'] })]
    const first = evaluateGate({ tasks, terminalOf: terminalMap({}) })
    expect(first.ready.map((entry) => entry.id)).toEqual(['a'])
    const second = evaluateGate({ tasks, terminalOf: terminalMap({ a: 'merged' }) })
    expect(second.ready.map((entry) => entry.id)).toEqual(['a', 'b'])
    const third = evaluateGate({ tasks, terminalOf: terminalMap({ a: 'merged', b: 'completed' }) })
    expect(third.ready.map((entry) => entry.id)).toEqual(['a', 'b', 'c'])
  })

  it('检测依赖环', () => {
    const tasks = [task('a', { dependsOn: ['b'] }), task('b', { dependsOn: ['a'] })]
    const gate = evaluateGate({ tasks, terminalOf: () => undefined })
    expect(gate.ready).toEqual([])
    expect(gate.cycles).toHaveLength(1)
    expect(gate.cycles[0]).toEqual(['a', 'b', 'a'])
  })

  it('自环也被检出', () => {
    expect(findCycles([task('a', { dependsOn: ['a'] })])).toHaveLength(1)
  })
})

describe('selectForScan', () => {
  const options = { maxPerScan: 2, priorityOf: (t: GateTask & { priority?: string }) => t.priority ?? 'P2', createdAtOf: (t: GateTask & { createdAt?: string }) => t.createdAt ?? '' }

  it('按 P0 > P1 > P2 排序并截断', () => {
    const ready = [
      { ...task('c'), priority: 'P2', createdAt: '2026-01-01' },
      { ...task('a'), priority: 'P0', createdAt: '2026-01-03' },
      { ...task('b'), priority: 'P1', createdAt: '2026-01-02' },
    ]
    expect(selectForScan(ready, options).map((entry) => entry.id)).toEqual(['a', 'b'])
  })

  it('同优先级按创建时间再按 id', () => {
    const ready = [
      { ...task('z'), priority: 'P1', createdAt: '2026-01-02' },
      { ...task('y'), priority: 'P1', createdAt: '2026-01-01' },
      { ...task('x'), priority: 'P1', createdAt: '2026-01-01' },
    ]
    expect(selectForScan(ready, { ...options, maxPerScan: 10 }).map((entry) => entry.id)).toEqual(['x', 'y', 'z'])
  })

  it('30 条积压只投 5 条', () => {
    const ready = Array.from({ length: 30 }, (_, index) => ({
      ...task(`t-${String(index).padStart(2, '0')}`),
      priority: 'P2',
      createdAt: '2026-01-01',
    }))
    expect(selectForScan(ready, { ...options, maxPerScan: 5 })).toHaveLength(5)
  })

  it('上限为 0 时不投递', () => {
    expect(selectForScan([{ ...task('a'), priority: 'P0', createdAt: '' }], { ...options, maxPerScan: 0 })).toEqual([])
  })
})
