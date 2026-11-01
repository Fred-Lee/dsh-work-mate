import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PortAllocator } from '../worktree/port-allocator.ts'
import type { TaskRecord } from './files.ts'
import { leftoversOf, reclaimAll, reclaimOne, ticketIdsFromResults } from './reclaim.ts'
import { planTaskPorts } from './plan.ts'

const exec = promisify(execFile)
let dir: string
let repo: string

const task = (overrides: Partial<TaskRecord> = {}): TaskRecord => ({
  id: 'task-1',
  title: 'T',
  intent: 'i',
  repo: 'repo-a',
  baseBranch: 'main',
  acceptance: '',
  priority: 'P1',
  mode: 'superagent',
  dependsOn: [],
  assigned: true,
  abandoned: false,
  attempt: 1,
  createdBy: 'u',
  createdAt: 't',
  updatedAt: 't',
  proposalId: 'p1',
  ...overrides,
})

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wm-reclaim-'))
  repo = join(dir, 'repo-a')
  await mkdir(repo, { recursive: true })
  const run = (args: string[]): Promise<unknown> => exec('git', args, { cwd: repo })
  await run(['init', '-b', 'main'])
  await run(['config', 'user.email', 't@t'])
  await run(['config', 'user.name', 't'])
  await writeFile(join(repo, 'a.txt'), 'x', 'utf8')
  await run(['add', '-A'])
  await run(['commit', '-m', 'init'])
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const createWorktree = async (name: string, branch: string, commit = false): Promise<string> => {
  const path = join(repo, '.workmates', name)
  await mkdir(join(repo, '.workmates'), { recursive: true })
  await exec('git', ['worktree', 'add', '-b', branch, path, 'main'], { cwd: repo })
  if (commit) {
    await writeFile(join(path, `${name}.txt`), name, 'utf8')
    await exec('git', ['add', '-A'], { cwd: path })
    await exec('git', ['commit', '-m', `work on ${name}`], { cwd: path })
  }
  return path
}

const deps = (overrides: Record<string, unknown> = {}) => ({
  worktreeRoots: async (name: string) => (name === 'repo-a' ? repo : undefined),
  ticketAlive: async () => false,
  ...overrides,
})

describe('reclaimOne', () => {
  it('Ticket 还活着时拒绝', async () => {
    const directory = 'workmate/workmate-abc123'
    const outcome = await reclaimOne(
      { ...deps({ ticketAlive: async () => true }) },
      { task: task(), directory, ticketId: 'tkt-1' },
    )
    expect(outcome.removed).toBe(false)
    expect(outcome.reason).toMatch(/仍在执行/)
  })

  it('未合并时拒绝并指出分支', async () => {
    const name = 'workmate-abc123'
    await createWorktree(name, `workmate/${name}`, true)
    const outcome = await reclaimOne(deps(), { task: task(), directory: `workmate/${name}` })
    expect(outcome.removed).toBe(false)
    expect(outcome.reason).toMatch(/尚未合并/)
  })

  it('已合并时移除目录并释放端口', async () => {
    const name = 'workmate-merged1'
    const path = await createWorktree(name, `workmate/${name}`)
    await exec('git', ['merge', '--no-ff', '-m', 'm', `workmate/${name}`], { cwd: repo })
    const ports = new PortAllocator({ rootDir: dir, subdir: 'workmate' } as never, 3000, 10)
    await planTaskPorts(ports, { proposalId: 'p1', project: 'repo-a', taskId: 'task-1' })

    const outcome = await reclaimOne({ ...deps(), ports }, { task: task(), directory: `workmate/${name}` })
    expect(outcome.removed).toBe(true)
    expect(outcome.portsReleased).toBe(true)
    const list = await exec('git', ['worktree', 'list'], { cwd: repo })
    expect(String(list.stdout)).not.toContain(path)
  })

  it('force 允许回收未合并的分支', async () => {
    const name = 'workmate-force1'
    await createWorktree(name, `workmate/${name}`, true)
    const outcome = await reclaimOne(deps(), { task: task(), directory: `workmate/${name}` }, { force: true })
    expect(outcome.removed).toBe(true)
  })

  it('仓库未注册时拒绝并说明', async () => {
    const outcome = await reclaimOne(
      { ...deps({ worktreeRoots: async () => undefined }) },
      { task: task(), directory: 'workmate/x' },
    )
    expect(outcome.removed).toBe(false)
    expect(outcome.reason).toMatch(/未注册/)
  })
})

describe('reclaimAll', () => {
  it('单个失败不影响其余', async () => {
    const first = 'workmate-a'
    const second = 'workmate-b'
    await createWorktree(first, `workmate/${first}`, true)
    await createWorktree(second, `workmate/${second}`, true)
    const outcomes = await reclaimAll(deps(), [
      { task: task({ id: 'task-a' }), directory: `workmate/${first}` },
      { task: task({ id: 'task-b' }), directory: `workmate/${second}`, ticketId: 'tkt-b' },
    ])
    expect(outcomes).toHaveLength(2)
    expect(outcomes[0]?.removed).toBe(false)
    expect(outcomes[1]?.removed).toBe(false)
  })
})

describe('ticketIdsFromResults', () => {
  it('取最新一条带 ticketId 的记录', async () => {
    const file = join(dir, 'tasks.jsonl')
    await writeFile(
      file,
      [
        JSON.stringify({ seq: 1, taskId: 't1', kind: 'ack', ticketId: 'old', text: '', at: 't' }),
        JSON.stringify({ seq: 2, taskId: 't1', kind: 'reply', ticketId: 'new', text: '', at: 't' }),
        '{"seq":3,"taskId":"t2","tick',
      ].join('\n'),
      'utf8',
    )
    expect(await ticketIdsFromResults(file)).toEqual({ t1: 'new' })
  })

  it('文件不存在时返回空表', async () => {
    expect(await ticketIdsFromResults(join(dir, 'missing.jsonl'))).toEqual({})
  })
})

describe('leftoversOf', () => {
  it('只列有 Ticket 且目录仍在的项', () => {
    const entries = leftoversOf(
      [
        { task: task({ id: 'a' }), directory: 'workmate/x', ticketId: 't1' },
        { task: task({ id: 'b' }), directory: 'workmate/gone', ticketId: 't2' },
        { task: task({ id: 'c' }), directory: 'workmate/none' },
      ],
      (directory) => directory === 'workmate/x' || directory === 'workmate/none',
    )
    expect(entries.map((entry) => entry.taskId)).toEqual(['a'])
  })
})
