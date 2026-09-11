import { describe, expect, it } from 'vitest'
import type { TaskRecord } from '../types.ts'
import { InMemoryHistoryStore } from './in-memory.ts'
import type { ExecutionEvent } from './types.ts'

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

function taskStateEvent(store: InMemoryHistoryStore, task: TaskRecord): Promise<ExecutionEvent> {
  return store.append({ ts: Date.now(), taskId: task.id, kind: 'task-state', payload: { id: task.id, prompt: task.prompt, status: task.status, cascade: false, timeoutSec: 300, createdAt: task.createdAt, agents: {} } })
}

describe('InMemoryHistoryStore', () => {
  it('assigns per-task monotonic seq, restarting per task', async () => {
    const store = new InMemoryHistoryStore()
    const a = makeTask('t-a', 'RUNNING')
    const b = makeTask('t-b', 'RUNNING')
    const e1 = await taskStateEvent(store, a)
    const e2 = await taskStateEvent(store, a)
    const e3 = await taskStateEvent(store, b)
    expect(e1.seq).toBe(1)
    expect(e2.seq).toBe(2)
    expect(e3.seq).toBe(1)
    expect([e1, e2, e3].every((e) => e.v === 1)).toBe(true)
    expect(e1.taskId).toBe('t-a')
    expect(e3.taskId).toBe('t-b')
  })

  it('eventsAfter pages forward and returns empty at latest without error', async () => {
    const store = new InMemoryHistoryStore()
    const task = makeTask('t-a', 'RUNNING')
    await taskStateEvent(store, task)
    await taskStateEvent(store, task)
    await taskStateEvent(store, task)

    const all = await store.eventsAfter('t-a', 0)
    expect(all.pruned).toBe(false)
    expect(all.events.map((e) => e.seq)).toEqual([1, 2, 3])

    const page = await store.eventsAfter('t-a', 1)
    expect(page.events.map((e) => e.seq)).toEqual([2, 3])

    const atLatest = await store.eventsAfter('t-a', 3)
    expect(atLatest.events).toEqual([])
    expect(atLatest.pruned).toBe(false)

    // unknown task: empty, not an error
    const unknown = await store.eventsAfter('t-ghost', 0)
    expect(unknown.events).toEqual([])
    expect(unknown.pruned).toBe(false)
  })

  it('keeps event order when several agents interleave appends', async () => {
    const store = new InMemoryHistoryStore()
    const appends = Promise.all([
      store.append({ ts: 1, taskId: 't', agent: 'claude', kind: 'agent-log', payload: { text: 'c1' } }),
      store.append({ ts: 2, taskId: 't', agent: 'codex', kind: 'agent-log', payload: { text: 'x1' } }),
      store.append({ ts: 3, taskId: 't', agent: 'claude', kind: 'agent-log', payload: { text: 'c2' } }),
    ])
    const events = await appends
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3])
    const page = await store.eventsAfter('t', 0)
    expect(page.events.map((e) => `${e.agent}:${(e as { payload: { text: string } }).payload.text}`)).toEqual(['claude:c1', 'codex:x1', 'claude:c2'])
  })

  it('upsertTask/getTask/listTasks round-trip a deep snapshot', async () => {
    const store = new InMemoryHistoryStore()
    const task = makeTask('t-a', 'COMPLETED', 5)
    await store.upsertTask(task)
    // mutating the caller's record afterwards must not leak into the store
    task.status = 'ALL_FAILED'
    task.agents.claude!.state = 'failed'
    expect((await store.getTask('t-a'))?.status).toBe('COMPLETED')
    expect((await store.getTask('t-a'))?.agents.claude?.state).toBe('completed')
    expect((await store.listTasks()).map((t) => t.id)).toEqual(['t-a'])
  })

  it('subscribe fires after durable append in seq order and unsubscribes', async () => {
    const store = new InMemoryHistoryStore()
    const seen: number[] = []
    const off = store.subscribe('t-a', (e) => seen.push(e.seq))
    await taskStateEvent(store, makeTask('t-a', 'RUNNING'))
    await taskStateEvent(store, makeTask('t-a', 'COMPLETED'))
    await new Promise((r) => setTimeout(r, 0))
    expect(seen).toEqual([1, 2])
    off()
    await taskStateEvent(store, makeTask('t-a', 'CANCELLED'))
    await new Promise((r) => setTimeout(r, 0))
    expect(seen).toEqual([1, 2])
  })

  it('does not notify subscribers of other tasks', async () => {
    const store = new InMemoryHistoryStore()
    const seen: string[] = []
    store.subscribe('t-a', () => seen.push('a'))
    await taskStateEvent(store, makeTask('t-b', 'RUNNING'))
    await new Promise((r) => setTimeout(r, 0))
    expect(seen).toEqual([])
  })

  it('prune keeps recent tasks and tombstones old cursors as history-pruned', async () => {
    const store = new InMemoryHistoryStore()
    // t-old: fully pruned later; give it 3 events
    const old = makeTask('t-old', 'COMPLETED', 1)
    await store.upsertTask(old)
    for (let i = 0; i < 3; i++) await taskStateEvent(store, old)
    const fresh = makeTask('t-fresh', 'COMPLETED', 2)
    await store.upsertTask(fresh)
    for (let i = 0; i < 2; i++) await taskStateEvent(store, fresh)

    const result = await store.prune({ maxTasks: 1 })
    expect(result.removedTasks).toBe(1)

    const tasks = await store.listTasks()
    expect(tasks.map((t) => t.id)).toEqual(['t-fresh'])
    expect(await store.getTask('t-old')).toBeUndefined()

    // cursor before the pruned task's last seq → explicit history-pruned signal
    const stale = await store.eventsAfter('t-old', 1)
    expect(stale.events).toEqual([])
    expect(stale.pruned).toBe(true)
    // cursor at/after the last known seq → nothing missing, no error
    const satisfied = await store.eventsAfter('t-old', 3)
    expect(satisfied.events).toEqual([])
    expect(satisfied.pruned).toBe(false)
  })

  it('prune trims the per-task event ring and reports gaps for old cursors', async () => {
    const store = new InMemoryHistoryStore()
    const task = makeTask('t-long', 'RUNNING')
    await store.upsertTask(task)
    for (let i = 0; i < 5; i++) await taskStateEvent(store, task)

    const result = await store.prune({ maxEventRowsPerTask: 2, maxTasks: 10 })
    expect(result.removedEventRows).toBe(3)

    const page = await store.eventsAfter('t-long', 3)
    expect(page.events.map((e) => e.seq)).toEqual([4, 5])
    expect(page.pruned).toBe(false) // cursor 3 == first retained - 1

    const gap = await store.eventsAfter('t-long', 1)
    expect(gap.events.map((e) => e.seq)).toEqual([4, 5])
    expect(gap.pruned).toBe(true)
  })
})
