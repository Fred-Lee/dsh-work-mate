import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  TaskFileError,
  appendInput,
  appendResult,
  compactResults,
  findTask,
  normalizeTask,
  readInputs,
  readResults,
  readTaskFile,
  unconsumedInputs,
  type ResultRow,
} from './files.ts'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wm-files-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const taskJson = (tasks: unknown[]): string => JSON.stringify({ version: 1, tasks }, null, 2)

describe('readTaskFile', () => {
  it('文件不存在视为空表', async () => {
    expect(await readTaskFile(join(dir, 'missing.json'))).toEqual({ version: 1, tasks: [] })
  })

  it('损坏的 JSON fail-closed，不返回空表', async () => {
    const file = join(dir, 'tasks.json')
    await writeFile(file, '{ not json', 'utf8')
    await expect(readTaskFile(file)).rejects.toBeInstanceOf(TaskFileError)
  })

  it('版本或结构不对时拒绝', async () => {
    const file = join(dir, 'tasks.json')
    await writeFile(file, JSON.stringify({ tasks: [] }), 'utf8')
    await expect(readTaskFile(file)).rejects.toThrowError(/version: 1/)
  })

  it('缺 id 的记录让整份文件判为损坏', async () => {
    const file = join(dir, 'tasks.json')
    await writeFile(file, taskJson([{ title: '没有 id' }]), 'utf8')
    await expect(readTaskFile(file)).rejects.toThrowError(/缺少 id/)
  })

  it('归一出完整记录', async () => {
    const file = join(dir, 'tasks.json')
    await writeFile(
      file,
      taskJson([
        {
          id: 'task-1',
          title: '异步化',
          intent: '把同步调用改成 start/stop',
          repo: 'dsh-Helmsman',
          baseBranch: 'main',
          acceptance: '立即返回',
          priority: 'P1',
          mode: 'superagent',
          dependsOn: ['task-0'],
          assigned: true,
          abandoned: false,
          attempt: 2,
          createdBy: 'workmate:fred',
          ports: [3000, 3001],
          createdAt: '2026-11-01T00:00:00.000Z',
          updatedAt: '2026-11-01T00:01:00.000Z',
        },
      ]),
      'utf8',
    )
    const parsed = await readTaskFile(file)
    const task = findTask(parsed, 'task-1')
    expect(task).toBeDefined()
    expect(task?.priority).toBe('P1')
    expect(task?.dependsOn).toEqual(['task-0'])
    expect(task?.ports).toEqual([3000, 3001])
    expect(task?.attempt).toBe(2)
  })

  it('坏字段回落默认值而不是整份失败', () => {
    const task = normalizeTask({ id: 'x', priority: 'P9', mode: 'weird', attempt: -3, dependsOn: ['a', 2, ''] })
    expect(task?.priority).toBe('P2')
    expect(task?.mode).toBe('record')
    expect(task?.attempt).toBe(0)
    expect(task?.dependsOn).toEqual(['a'])
    expect(task?.createdBy).toBe('workmate:panel')
  })
})

describe('inputs.jsonl 与 tasks.jsonl', () => {
  it('撕裂尾行被忽略并计数', async () => {
    const file = join(dir, 'inputs.jsonl')
    await writeFile(
      file,
      [
        JSON.stringify({ seq: 1, taskId: 'task-1', text: '先做 A', by: 'workmate:fred', at: 't1' }),
        '{"seq":2,"taskId":"task-1","text":"半',
      ].join('\n'),
      'utf8',
    )
    const read = await readInputs(file)
    expect(read.rows).toHaveLength(1)
    expect(read.skipped).toBe(1)
    expect(read.maxSeq).toBe(1)
  })

  it('非法行被忽略，不影响合法行', async () => {
    const file = join(dir, 'inputs.jsonl')
    await writeFile(
      file,
      [
        JSON.stringify({ seq: 1, taskId: 'task-1', text: 'ok', by: 'x', at: 't' }),
        JSON.stringify({ seq: 'NaN', taskId: 'task-1', text: 'bad' }),
        JSON.stringify({ seq: 3, text: 'no taskId' }),
        JSON.stringify({ seq: 4, taskId: 'task-1', text: 'ok2', by: 'x', at: 't' }),
      ].join('\n'),
      'utf8',
    )
    const read = await readInputs(file)
    expect(read.rows.map((row) => row.seq)).toEqual([1, 4])
    expect(read.skipped).toBe(2)
  })

  it('未消费行按游标取，且游标超过最大 seq 时自愈', async () => {
    const file = join(dir, 'inputs.jsonl')
    await appendInput(file, { seq: 1, taskId: 'task-1', text: 'a', by: 'x' })
    await appendInput(file, { seq: 2, taskId: 'task-1', text: 'b', by: 'x' })
    const read = await readInputs(file)
    expect(unconsumedInputs(read, 1).rows.map((row) => row.seq)).toEqual([2])
    const healed = unconsumedInputs(read, 99)
    expect(healed.cursorReset).toBe(true)
    expect(healed.rows.map((row) => row.seq)).toEqual([1, 2])
  })

  it('同一 messageId 只追加一次', async () => {
    const file = join(dir, 'tasks.jsonl')
    const row: ResultRow = { seq: 1, taskId: 'task-1', kind: 'ack', messageId: 'a'.repeat(32), text: '已收到', at: 't' }
    expect((await appendResult(file, row)).appended).toBe(true)
    expect((await appendResult(file, { ...row })).appended).toBe(false)
    const read = await readResults(file)
    expect(read.rows).toHaveLength(1)
  })

  it('同一待办内 seq 必须递增，倒退的追加被拒', async () => {
    const file = join(dir, 'tasks.jsonl')
    await appendResult(file, { seq: 5, taskId: 'task-1', kind: 'notice', text: 'a', at: 't' })
    expect((await appendResult(file, { seq: 3, taskId: 'task-1', kind: 'notice', text: 'b', at: 't' })).appended).toBe(false)
    expect((await appendResult(file, { seq: 6, taskId: 'task-1', kind: 'notice', text: 'c', at: 't' })).appended).toBe(true)
  })

  it('未知 kind 的行被忽略', async () => {
    const file = join(dir, 'tasks.jsonl')
    await writeFile(
      file,
      [JSON.stringify({ seq: 1, taskId: 'task-1', kind: 'progress', text: 'x', at: 't' })].join('\n'),
      'utf8',
    )
    const read = await readResults(file)
    expect(read.rows).toHaveLength(0)
    expect(read.skipped).toBe(1)
  })
})

describe('compactResults', () => {
  const build = (count: number): ResultRow[] =>
    Array.from({ length: count }, (_, index) => ({
      seq: index + 1,
      taskId: 'task-1',
      kind: index === 0 ? 'ack' : index === count - 1 ? 'reply' : 'notice',
      text: `row ${index + 1}`,
      at: 't',
    }))

  it('未超限不压缩', async () => {
    const file = join(dir, 'tasks.jsonl')
    for (const row of build(5)) await appendResult(file, row)
    expect((await compactResults(file, 200)).removed).toBe(0)
  })

  it('超限时保留尾部、首条 ack 与末条结果', async () => {
    const file = join(dir, 'tasks.jsonl')
    const rows = build(30)
    await writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
    const { removed } = await compactResults(file, 10)
    expect(removed).toBeGreaterThan(0)
    const after = await readResults(file)
    expect(after.rows.length).toBeLessThanOrEqual(11)
    expect(after.rows.some((row) => row.kind === 'ack')).toBe(true)
    expect(after.rows.at(-1)?.text).toBe('row 30')
    // 保持 seq 升序
    const seqs = after.rows.map((row) => row.seq)
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs)
  })

  it('只压缩超限的待办，其他待办原样保留', async () => {
    const file = join(dir, 'tasks.jsonl')
    const many = build(30)
    const few: ResultRow[] = [
      { seq: 1, taskId: 'task-2', kind: 'ack', text: 'k', at: 't' },
      { seq: 2, taskId: 'task-2', kind: 'reply', text: 'done', at: 't' },
    ]
    await writeFile(file, [...many, ...few].map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
    await compactResults(file, 10)
    const after = await readResults(file)
    expect(after.rows.filter((row) => row.taskId === 'task-2')).toHaveLength(2)
  })

  it('压缩结果可被再次读取（原子替换后文件完好）', async () => {
    const file = join(dir, 'tasks.jsonl')
    const rows = build(50)
    await writeFile(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
    await compactResults(file, 5)
    const raw = await readFile(file, 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(raw.split('\n').filter((line) => line.trim() !== '')).toHaveLength(
      (await readResults(file)).rows.length,
    )
  })
})
