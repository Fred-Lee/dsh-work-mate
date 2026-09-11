import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TaskRecord } from '../types.ts'
import { JsonlHistoryStore, defaultHistoryRootDir } from './jsonl.ts'

function makeTask(id: string, status: TaskRecord['status'], createdAt = 1000): TaskRecord {
  return {
    id,
    prompt: `prompt ${id}`,
    cascade: false,
    timeoutSec: 300,
    status,
    createdAt,
    agents: {
      claude: { agent: 'claude', state: 'completed', attempts: 1, startedAt: 1001, endedAt: 1002, exitCode: 0, log: 'hello' },
    },
  }
}

async function makeRoot(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'helmsman-hist-'))
  return join(base, 'history')
}

const roots: string[] = []
async function storeFor(): Promise<{ root: string; store: JsonlHistoryStore }> {
  const root = await makeRoot()
  roots.push(root)
  return { root, store: new JsonlHistoryStore({ rootDir: root }) }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
})

describe('JsonlHistoryStore', () => {
  it('persists events + snapshot and replays through a fresh instance (restart)', async () => {
    const { root, store } = await storeFor()
    const task = makeTask('t-a', 'RUNNING')
    await store.upsertTask(task)
    await store.append({ ts: 1, taskId: 't-a', kind: 'task-state', payload: { id: 't-a', prompt: 'p', status: 'RUNNING', cascade: false, timeoutSec: 300, createdAt: task.createdAt, agents: {} } })
    await store.append({ ts: 2, taskId: 't-a', agent: 'claude', kind: 'agent-log', payload: { text: 'line 1' } })
    task.status = 'COMPLETED'
    task.endedAt = 5
    await store.upsertTask(task)

    // "host restart": a brand-new store instance over the same directory
    const reborn = new JsonlHistoryStore({ rootDir: root })
    expect((await reborn.getTask('t-a'))?.status).toBe('COMPLETED')
    expect((await reborn.getTask('t-a'))?.endedAt).toBe(5)
    const page = await reborn.eventsAfter('t-a', 0)
    expect(page.pruned).toBe(false)
    expect(page.events.map((e) => e.seq)).toEqual([1, 2])
    expect(page.events.map((e) => e.kind)).toEqual(['task-state', 'agent-log'])

    // seq continues across the restart
    const e = await reborn.append({ ts: 3, taskId: 't-a', agent: 'claude', kind: 'agent-log', payload: { text: 'line 2' } })
    expect(e.seq).toBe(3)
  })

  it('ignores a torn trailing line (crash mid-append)', async () => {
    const { root, store } = await storeFor()
    await store.append({ ts: 1, taskId: 't', kind: 'task-state', payload: { id: 't', prompt: 'p', status: 'RUNNING', cascade: false, timeoutSec: 300, createdAt: 0, agents: {} } })
    await store.append({ ts: 2, taskId: 't', agent: 'x', kind: 'agent-log', payload: { text: 'ok' } })
    // simulate a crash while appending the next line: partial JSON, no newline
    await writeFile(join(root, 'tasks', 't.jsonl'), '{"v":1,"seq":3,"ts":3,"taskId":"t","kind":"agent-log",', { flag: 'a' })

    const reborn = new JsonlHistoryStore({ rootDir: root })
    const page = await reborn.eventsAfter('t', 0)
    expect(page.events.map((e) => e.seq)).toEqual([1, 2])
    // seq hydration skips the torn tail → the next append reuses seq 3
    const e = await reborn.append({ ts: 4, taskId: 't', agent: 'x', kind: 'agent-log', payload: { text: 'after crash' } })
    expect(e.seq).toBe(3)
  })

  it('upsert is atomic and snapshot survives a corrupt read as empty', async () => {
    const { root, store } = await storeFor()
    const task = makeTask('t-snap', 'COMPLETED', 7)
    await store.upsertTask(task)
    const snap = JSON.parse(await readFile(join(root, 'tasks.json'), 'utf8'))
    expect(snap.v).toBe(1)
    expect(snap.tasks).toHaveLength(1)

    // corrupt the snapshot file → degrades to empty, never crashes
    await writeFile(join(root, 'tasks.json'), '{"v":1,"tasks": [{"truncated"', 'utf8')
    const reborn = new JsonlHistoryStore({ rootDir: root })
    expect(await reborn.listTasks()).toEqual([])
  })

  it('prune removes old tasks (only Helmsman files) and signals old cursors', async () => {
    const { root, store } = await storeFor()
    const old = makeTask('t-old', 'COMPLETED', 1)
    await store.upsertTask(old)
    for (let i = 0; i < 3; i++) {
      await store.append({ ts: i, taskId: 't-old', kind: 'task-state', payload: { id: 't-old', prompt: 'p', status: 'COMPLETED', cascade: false, timeoutSec: 300, createdAt: 1, agents: {} } })
    }
    const fresh = makeTask('t-fresh', 'COMPLETED', 2)
    await store.upsertTask(fresh)

    const result = await store.prune({ maxTasks: 1, maxEventRowsPerTask: 2000 })
    expect(result.removedTasks).toBe(1)
    expect(await store.getTask('t-old')).toBeUndefined()
    expect(await store.getTask('t-fresh')).not.toBeUndefined()

    const stale = await store.eventsAfter('t-old', 1)
    expect(stale.events).toEqual([])
    expect(stale.pruned).toBe(true)
    const satisfied = await store.eventsAfter('t-old', 3)
    expect(satisfied.pruned).toBe(false)

    // fresh task untouched
    expect((await store.eventsAfter('t-fresh', 0)).events).toEqual([])
  })

  it('prune trims the per-task JSONL head and reports gaps for old cursors', async () => {
    const { root, store } = await storeFor()
    const task = makeTask('t-long', 'RUNNING')
    await store.upsertTask(task)
    for (let i = 1; i <= 5; i++) {
      await store.append({ ts: i, taskId: 't-long', kind: 'task-state', payload: { id: 't-long', prompt: 'p', status: 'RUNNING', cascade: false, timeoutSec: 300, createdAt: task.createdAt, agents: {} } })
    }
    const result = await store.prune({ maxEventRowsPerTask: 2, maxTasks: 10 })
    expect(result.removedEventRows).toBe(3)

    const page = await store.eventsAfter('t-long', 3)
    expect(page.events.map((e) => e.seq)).toEqual([4, 5])
    expect(page.pruned).toBe(false)

    const gap = await store.eventsAfter('t-long', 1)
    expect(gap.events.map((e) => e.seq)).toEqual([4, 5])
    expect(gap.pruned).toBe(true)

    // continuation after trim: new appends must not resurrect trimmed seqs
    const e = await store.append({ ts: 6, taskId: 't-long', kind: 'task-state', payload: { id: 't-long', prompt: 'p', status: 'COMPLETED', cascade: false, timeoutSec: 300, createdAt: task.createdAt, agents: {} } })
    expect(e.seq).toBe(6)
    const lines = (await readFile(join(root, 'tasks', 't-long.jsonl'), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(3)
  })

  it('subscribe fires after the event is durably appended', async () => {
    const { root, store } = await storeFor()
    const seen: number[] = []
    store.subscribe('t-sub', (e) => seen.push(e.seq))
    await store.append({ ts: 1, taskId: 't-sub', agent: 'x', kind: 'agent-log', payload: { text: 'a' } })
    expect(seen).toEqual([1])
    // event really is on disk when the listener runs
    const text = await readFile(join(root, 'tasks', 't-sub.jsonl'), 'utf8')
    expect(text.trim().split('\n')).toHaveLength(1)
  })
})

describe('defaultHistoryRootDir', () => {
  it('honors HELMSMAN_HOME and falls back to ~/.helmsman', async () => {
    const base = await mkdtemp(join(tmpdir(), 'helmsman-home-'))
    roots.push(base)
    const prev = process.env.HELMSMAN_HOME
    process.env.HELMSMAN_HOME = base
    try {
      expect(defaultHistoryRootDir()).toBe(join(base, 'history'))
    } finally {
      if (prev === undefined) delete process.env.HELMSMAN_HOME
      else process.env.HELMSMAN_HOME = prev
    }
  })
})
