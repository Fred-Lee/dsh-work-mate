import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChannelRef } from './contract.ts'
import { createChannel, resultKindOf, taskIdOf } from './channel.ts'
import { artifactMessages, threadContextOf } from './context.ts'
import type { TaskRecord } from './files.ts'
import { appendInput } from './files.ts'
import { taskPaths } from './paths.ts'

let dir: string
let taskFile: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wm-channel-'))
  taskFile = join(dir, 'tasks.json')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const task = (id: string, overrides: Partial<TaskRecord> = {}): TaskRecord => ({
  id,
  title: id,
  intent: `做 ${id}`,
  repo: 'dsh-Helmsman',
  baseBranch: 'main',
  acceptance: 'ok',
  priority: 'P1',
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

const writeTasks = async (tasks: TaskRecord[]): Promise<void> => {
  await writeFile(taskFile, JSON.stringify({ version: 1, tasks }, null, 2), 'utf8')
}

const channelRef = (taskId: string): ChannelRef => ({ source: 'workmate', thread: taskId, address: { taskId } })
const messageId = (seed: string): string => seed.repeat(32).slice(0, 32).replace(/[^a-f0-9]/g, 'a')

describe('resultKindOf / taskIdOf', () => {
  it('三种 kind 固定映射，不猜文本', () => {
    expect(resultKindOf('acknowledgement')).toBe('ack')
    expect(resultKindOf('reply')).toBe('reply')
    expect(resultKindOf('notice')).toBe('notice')
  })

  it('从 address 取 taskId', () => {
    expect(taskIdOf(channelRef('task-1'))).toBe('task-1')
    expect(taskIdOf(undefined)).toBeUndefined()
    expect(taskIdOf({ source: 'workmate', thread: 't', address: {} })).toBeUndefined()
  })
})

describe('channel.send', () => {
  it('写回 tasks.jsonl，seq 递增', async () => {
    const tasks = [task('task-1')]
    await writeTasks(tasks)
    const channel = createChannel({ taskFile: () => taskFile, currentTasks: () => tasks })
    const first = await channel.send({}, { id: messageId('a'), channel: channelRef('task-1'), text: '已收到', kind: 'acknowledgement' })
    const second = await channel.send({}, { id: messageId('b'), channel: channelRef('task-1'), text: '结果', kind: 'reply' })
    expect(first).toBe('sent')
    expect(second).toBe('sent')
    const { readResults } = await import('./files.ts')
    const rows = (await readResults(taskPaths(taskFile).results)).rows
    expect(rows.map((row) => row.kind)).toEqual(['ack', 'reply'])
    expect(rows.map((row) => row.seq)).toEqual([1, 2])
  })

  it('同一 messageId 幂等', async () => {
    const tasks = [task('task-1')]
    await writeTasks(tasks)
    const channel = createChannel({ taskFile: () => taskFile, currentTasks: () => tasks })
    const message = { id: messageId('a'), channel: channelRef('task-1'), text: '已收到', kind: 'acknowledgement' as const }
    await channel.send({}, message)
    await channel.send({}, message)
    const { readResults } = await import('./files.ts')
    expect((await readResults(taskPaths(taskFile).results)).rows).toHaveLength(1)
  })

  it('待办已删除时返回 gone', async () => {
    await writeTasks([])
    const channel = createChannel({ taskFile: () => taskFile, currentTasks: () => [] })
    const result = await channel.send({}, { id: messageId('a'), channel: channelRef('task-1'), text: 'x', kind: 'reply' })
    expect(result).toBe('gone')
  })

  it('没有 taskId 的消息返回 gone', async () => {
    const channel = createChannel({ taskFile: () => taskFile, currentTasks: () => [task('a')] })
    const result = await channel.send({}, { id: messageId('a'), channel: { source: 'workmate', thread: 't', address: {} }, text: 'x', kind: 'reply' })
    expect(result).toBe('gone')
  })

  it('非法 messageId 被拒绝写入并上报', async () => {
    const tasks = [task('task-1')]
    await writeTasks(tasks)
    const reported: string[] = []
    const channel = createChannel({
      taskFile: () => taskFile,
      currentTasks: () => tasks,
      onInvalidMessageId: (value) => reported.push(value),
    })
    const result = await channel.send({}, { id: 'zzz', channel: channelRef('task-1'), text: 'x', kind: 'reply' })
    expect(result).toBe('sent')
    expect(reported).toEqual(['zzz'])
    const { readResults } = await import('./files.ts')
    expect((await readResults(taskPaths(taskFile).results)).rows).toHaveLength(0)
  })

  it('allowed 只对存在的待办返回 true', async () => {
    const channel = createChannel({ taskFile: () => taskFile, currentTasks: () => [task('a')] })
    expect(channel.allowed?.({ taskId: 'a' }, {})).toBe(true)
    expect(channel.allowed?.({ taskId: 'b' }, {})).toBe(false)
  })

  it('link 给出面板深链；无面板时返回空 url', async () => {
    const withPanel = createChannel({ taskFile: () => taskFile, currentTasks: () => [], panelBase: 'http://127.0.0.1:3080/workmate' })
    const link = withPanel.link({ taskId: 'task 1' }, {})
    expect(link.url).toBe('http://127.0.0.1:3080/workmate/?task=task%201')
    const without = createChannel({ taskFile: () => taskFile, currentTasks: () => [] })
    expect(without.link({ taskId: 'a' }, {}).url).toBe('')
  })
})

describe('artifactMessages', () => {
  it('带路径与行号', () => {
    const result = artifactMessages('# 标题\n\n## 为什么\n第 3 行', 'p/proposal.md', 100)
    expect(result.messages[0]?.path).toBe('p/proposal.md')
    expect(result.messages[0]?.line).toBe(1)
    expect(result.truncated).toBe(false)
  })

  it('超出上限时截断并可续读', () => {
    const content = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join('\n')
    const first = artifactMessages(content, 'p/design.md', 100, 0)
    expect(first.truncated).toBe(true)
    const second = artifactMessages(content, 'p/design.md', 100, 100)
    expect(second.messages[0]?.line).toBeGreaterThan(1)
  })
})

describe('threadContext', () => {
  const build = (root: string | undefined) =>
    threadContextOf({ taskFile: () => taskFile, changesRoot: () => root, pageSize: 3 })

  it('root 返回原始意图与验收标准', async () => {
    await writeTasks([task('task-1')])
    const context = build(undefined)
    const part = await context.read(null, {
      id: 'x', source: 'workmate', threads: [{ source: 'workmate', id: 'task-1' }], actor: { source: 'workmate', id: 'u' },
      human: true, at: 't', text: 'x', meta: { taskId: 'task-1' },
    }, 'root', undefined, {})
    expect(part.messages[0]?.text).toBe('做 task-1')
    expect(part.messages.some((message) => message.text.includes('验收标准'))).toBe(true)
    expect(part.body['repo']).toBe('dsh-Helmsman')
  })

  it('关联提案且配置了 changesRoot 时读到工件', async () => {
    const changesRoot = join(dir, 'changes')
    await writeTasks([task('task-1', { proposalId: 'add-thing' })])
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(changesRoot, 'add-thing'), { recursive: true })
    await writeFile(join(changesRoot, 'add-thing', 'proposal.md'), '# 方案\n目标：异步化', 'utf8')
    const context = build(changesRoot)
    const part = await context.read(null, {
      id: 'x', source: 'workmate', threads: [{ source: 'workmate', id: 'task-1' }], actor: { source: 'workmate', id: 'u' },
      human: true, at: 't', text: 'x', meta: {},
    }, 'root', undefined, {})
    const artifacts = part.messages.filter((message) => message.path?.includes('proposal.md'))
    expect(artifacts.map((message) => message.text)).toContain('目标：异步化')
    expect(artifacts.every((message) => message.bot === true)).toBe(true)
  })

  it('非法 proposalId 不读任何工件', async () => {
    const changesRoot = join(dir, 'changes')
    await writeTasks([task('task-1', { proposalId: '../evil' })])
    const context = build(changesRoot)
    const part = await context.read(null, {
      id: 'x', source: 'workmate', threads: [{ source: 'workmate', id: 'task-1' }], actor: { source: 'workmate', id: 'u' },
      human: true, at: 't', text: 'x', meta: {},
    }, 'root', undefined, {})
    expect(part.messages.every((message) => message.path === undefined)).toBe(true)
  })

  it('未关联提案不扫仓库', async () => {
    await writeTasks([task('task-1')])
    const context = build(join(dir, 'changes'))
    const part = await context.read(null, {
      id: 'x', source: 'workmate', threads: [{ source: 'workmate', id: 'task-1' }], actor: { source: 'workmate', id: 'u' },
      human: true, at: 't', text: 'x', meta: {},
    }, 'root', undefined, {})
    expect(part.messages.every((message) => message.path === undefined)).toBe(true)
  })

  it('thread 分页，机器行标 bot', async () => {
    await writeTasks([task('task-1')])
    const paths = taskPaths(taskFile)
    for (let seq = 1; seq <= 5; seq += 1) {
      await appendInput(paths.inputs, { seq, taskId: 'task-1', text: `人 ${seq}`, by: 'workmate:fred' })
    }
    const context = build(undefined)
    const trigger = {
      id: 'x', source: 'workmate', threads: [{ source: 'workmate', id: 'task-1' }], actor: { source: 'workmate', id: 'u' },
      human: true, at: 't', text: 'x', meta: {},
    }
    const page = await context.read(null, trigger, 'thread', undefined, {})
    expect(page.messages).toHaveLength(3)
    expect(page.next).toBe('2')
    const earlier = await context.read(null, trigger, 'thread', page.next, {})
    expect(earlier.messages).toHaveLength(2)
  })

  it('parent 找到被回复的人消息；找不到时返回 gone', async () => {
    await writeTasks([task('task-1')])
    const paths = taskPaths(taskFile)
    await appendInput(paths.inputs, { seq: 1, taskId: 'task-1', text: '原文', by: 'workmate:fred' })
    const context = build(undefined)
    const base = { id: 'x', source: 'workmate', threads: [{ source: 'workmate', id: 'task-1' }], actor: { source: 'workmate', id: 'u' }, human: true, at: 't', text: 'x', meta: {} }
    const found = await context.read(null, { ...base, meta: { replyTo: 'in:1' } }, 'parent', undefined, {})
    expect(found.messages[0]?.text).toBe('原文')
    const gone = await context.read(null, { ...base, meta: { replyTo: 'in:99' } }, 'parent', undefined, {})
    expect(gone.status).toBe('gone')
  })

  it('messageId 用 Trigger 自己的 id', () => {
    const context = build(undefined)
    expect(context.messageId({ id: 'workmate:task-1:1' } as never)).toBe('workmate:task-1:1')
  })
})
