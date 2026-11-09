import { describe, expect, it } from 'vitest'
import type { Trigger } from './contract.ts'
import type { InputRow, TaskRecord } from './files.ts'
import {
  buildInputTrigger,
  buildTaskTrigger,
  healthSummaryOf,
  normalizeRepoPath,
  repoMatches,
  scanOnce,
  type ScanOutcome,
  type WatchHost,
} from './watch.ts'
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

const base = {
  source: 'workmate',
  repos: [] as readonly string[],
  maxPerScan: 5,
  interactive: true,
  now: () => new Date('2026-11-02T00:10:00.000Z'),
}

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

  it('不传 source 时仍是默认实例（旧调用点语义不变）', () => {
    const trigger = buildTaskTrigger(task('task-1'), 't')
    expect(trigger.id).toBe('workmate:task-1:1')
    expect(trigger.source).toBe('workmate')
    expect(trigger.threads).toEqual([{ source: 'workmate', id: 'task-1' }])
    expect(trigger.channel?.source).toBe('workmate')
  })

  it('传 source 时 Trigger / Thread / Channel 全带实例前缀，但 actor 仍是 workmate 的人身份', () => {
    const trigger = buildTaskTrigger(task('task-1'), 't', 'workmate-b')
    expect(trigger.id).toBe('workmate-b:task-1:1')
    expect(trigger.source).toBe('workmate-b')
    expect(trigger.threads).toEqual([{ source: 'workmate-b', id: 'task-1' }])
    expect(trigger.channel?.source).toBe('workmate-b')
    // actor.source 不随实例走：触发者身份是「人」，policy.allowed 按它查名单（见 contract.ts）。
    expect(trigger.actor).toEqual({ source: 'workmate', id: 'workmate:fred' })
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

  it('传 source 时回答也投进实例自己的 Thread', () => {
    const trigger = buildInputTrigger(input(7, 'task-1'), task('task-1'), 'workmate-b')
    expect(trigger.id).toBe('workmate-b:task-1:in:7')
    expect(trigger.source).toBe('workmate-b')
    expect(trigger.threads).toEqual([{ source: 'workmate-b', id: 'task-1' }])
    expect(trigger.actor.source).toBe('workmate')
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
  const outcome = (overrides: Partial<ScanOutcome> = {}): ScanOutcome => ({
    submitted: [],
    replied: [],
    duplicates: [],
    deferred: 0,
    skippedByRepo: 0,
    waitingOnDependency: [],
    blockedByDependency: [],
    cycles: [],
    readOnly: 0,
    ...overrides,
  })

  it('只读模式给只读摘要', () => {
    const summary = healthSummaryOf(outcome({ waitingOnDependency: ['x'], readOnly: 3 }), [])
    expect(summary.detail).toContain('只读')
    expect(summary.detail).toContain('等待依赖')
  })

  it('正常投递给投递摘要', () => {
    const summary = healthSummaryOf(outcome({ submitted: ['a'], replied: [1], deferred: 2 }), [])
    expect(summary.detail).toContain('投递 1')
    expect(summary.detail).toContain('回答 1')
    expect(summary.detail).toContain('待投递 2')
    expect(summary.state).toBe('ready')
  })

  it('有环时暂停', () => {
    const summary = healthSummaryOf(outcome({ cycles: [['a', 'b', 'a']] }), [])
    expect(summary.state).toBe('paused')
  })

  it('跳过 N 条（非本实例仓库）写进摘要，投递与只读两种分支都有', () => {
    const delivered = healthSummaryOf(outcome({ submitted: ['a'], skippedByRepo: 2 }), [])
    expect(delivered.detail).toContain('跳过 2 条（非本实例仓库）')
    // 只读 + 全部被跳过：必须能看出"不是没活，是别人的活"。
    const idle = healthSummaryOf(outcome({ readOnly: 0, skippedByRepo: 3 }), [])
    expect(idle.detail).toContain('跳过 3 条（非本实例仓库）')
    const cycles = healthSummaryOf(outcome({ cycles: [['a', 'b', 'a']], skippedByRepo: 1 }), [])
    expect(cycles.detail).toContain('跳过 1 条（非本实例仓库）')
  })
})

describe('仓库匹配（repos 过滤）', () => {
  it('normalizeRepoPath 容忍末尾斜杠与重复分隔符，不做 basename 猜测', () => {
    expect(normalizeRepoPath('/srv/a/')).toBe('/srv/a')
    expect(normalizeRepoPath('/srv//a/./')).toBe('/srv/a')
    expect(normalizeRepoPath('  /srv/a  ')).toBe('/srv/a')
    expect(normalizeRepoPath('')).toBe('')
    // 同名不同路径不得相等（否则会把待办投给同名的另一个仓库）。
    expect(normalizeRepoPath('/srv/a/svc')).not.toBe(normalizeRepoPath('/srv/b/svc'))
  })

  it('repos 为空不限制；非空时按规范化路径相等匹配', () => {
    expect(repoMatches('/srv/a', [])).toBe(true)
    expect(repoMatches('/srv/a/', ['/srv/a'])).toBe(true)
    expect(repoMatches('/srv/a', ['/srv/a/'])).toBe(true)
    expect(repoMatches('/srv/b', ['/srv/a'])).toBe(false)
    // 待办没写仓库：无法归属，宁可跳过（会在 skippedByRepo 里可见）。
    expect(repoMatches('', ['/srv/a'])).toBe(false)
  })

  it('只投 repo 命中的待办，其余计入 skippedByRepo', async () => {
    const fake = fakeHost()
    const tasks = [task('a', { repo: '/srv/a' }), task('b', { repo: '/srv/b' }), task('c', { repo: '/srv/a/' })]
    const outcome = await scanOnce(fake.host, { ...base, repos: ['/srv/a'], tasks, inputs: [] })
    expect(outcome.submitted).toEqual(['a', 'c'])
    expect(outcome.skippedByRepo).toBe(1)
    expect(fake.received.map((trigger) => trigger.meta['taskId'])).toEqual(['a', 'c'])
  })

  it('repos 为空时不限制仓库', async () => {
    const fake = fakeHost()
    const outcome = await scanOnce(fake.host, {
      ...base,
      repos: [],
      tasks: [task('a', { repo: '/srv/a' }), task('b', { repo: '/srv/b' })],
      inputs: [],
    })
    expect(outcome.submitted).toEqual(['a', 'b'])
    expect(outcome.skippedByRepo).toBe(0)
  })

  it('只读模式下 readOnly 只数本实例的待办', async () => {
    const outcome = await scanOnce(fakeHost().host, {
      ...base,
      interactive: false,
      repos: ['/srv/a'],
      tasks: [task('a', { repo: '/srv/a' }), task('b', { repo: '/srv/b' })],
      inputs: [],
    })
    expect(outcome.readOnly).toBe(1)
    expect(outcome.skippedByRepo).toBe(1)
  })

  it('被跳过的待办不推进游标：换成本实例后下一轮照常投递', async () => {
    const fake = fakeHost()
    const tasks = [task('b', { repo: '/srv/b' })]
    const first = await scanOnce(fake.host, { ...base, repos: ['/srv/a'], tasks, inputs: [] })
    expect(first.submitted).toEqual([])
    expect(first.skippedByRepo).toBe(1)
    // 游标只服务 inputs 回答：没有回答行时一条都不写。
    expect(fake.cursorWrites).toEqual([])
    // 本实例接管该仓库后，同一份任务表立刻能投——说明跳过没有消费掉任何东西。
    const second = await scanOnce(fake.host, { ...base, repos: ['/srv/b'], tasks, inputs: [] })
    expect(second.submitted).toEqual(['b'])
  })

  it('依赖门控先算、仓库过滤后做：跳过的待办仍可能出现在 waiting 里', async () => {
    const fake = fakeHost()
    const outcome = await scanOnce(fake.host, {
      ...base,
      repos: ['/srv/a'],
      tasks: [task('a', { repo: '/srv/a' }), task('b', { repo: '/srv/b', dependsOn: ['a'] })],
      inputs: [],
    })
    // 门控是纯函数、语义单一（design D3）：它只回答"依赖满足了吗"，不知道也不该知道
    // b 归别的实例；归属由 skippedByRepo 单独表达，两种等待因此可区分。
    expect(outcome.submitted).toEqual(['a'])
    expect(outcome.waitingOnDependency).toEqual(['b'])
    expect(outcome.skippedByRepo).toBe(0)
  })

  it('两个实例用不相交 repos 扫描同一份任务表：各投各的、不重复', async () => {
    // spec 场景「同一待办不会被两个实例重复投递」在不限制 repos 时物理上不可能成立
    // （两个实例都会投同一条，这是配置问题，不是代码能去重的）。这里用**分区**表达它的
    // 可判定版本：不相交 repos 下，同一份任务表的每条待办只属于一个实例。
    const tasks = [task('a', { repo: '/srv/a' }), task('b', { repo: '/srv/b' }), task('c', { repo: '/srv/a///' })]
    const instanceA = fakeHost()
    const instanceB = fakeHost()
    const outcomeA = await scanOnce(instanceA.host, { ...base, source: 'workmate', repos: ['/srv/a'], tasks, inputs: [] })
    const outcomeB = await scanOnce(instanceB.host, { ...base, source: 'workmate-b', repos: ['/srv/b'], tasks, inputs: [] })
    expect(outcomeA.submitted).toEqual(['a', 'c'])
    expect(outcomeB.submitted).toEqual(['b'])
    // 两个实例投出的 Trigger ID 前缀不同，即便 taskId 相同也不会被宿主互相当成重复。
    expect(instanceA.received.map((trigger) => trigger.id)).toEqual(['workmate:a:1', 'workmate:c:1'])
    expect(instanceB.received.map((trigger) => trigger.id)).toEqual(['workmate-b:b:1'])
    // 并集恰好覆盖整张表，没有一条被投两次。
    const delivered = [...outcomeA.submitted, ...outcomeB.submitted]
    expect(delivered.sort()).toEqual(['a', 'b', 'c'])
    expect(new Set(delivered).size).toBe(delivered.length)
  })
})
