import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrchestratorCore } from './core.ts'
import { JsonlHistoryStore } from './history/jsonl.ts'
import type { AgentAdapter, AgentExecuteResult, TaskRecord } from './types.ts'

function makeWorktree() {
  const created: Array<{ id: string; taskId: string; agent: string; path: string }> = []
  return {
    impl: {
      createWorktree: async ({ taskId, agent }: { taskId: string; agent: string }) => {
        const rec = { id: `wt-${taskId}-${agent}`, taskId, agent, path: `/tmp/wt-${taskId}-${agent}` }
        created.push(rec)
        return { ...rec, branch: `helmsman/${taskId}-${agent}`, baseSha: 'abc123' }
      },
      removeWorktree: async () => undefined,
      listWorktrees: async () => [...created],
      getDiff: async (id: string) => ({
        worktreeId: id,
        files: [{ path: 'a.txt', status: 'modified' as const, additions: 1, deletions: 0, diff: 'diff --git a/a.txt b/a.txt' }],
        additions: 1,
        deletions: 0,
      }),
      mergeWorktree: async () => ({ ok: true, committed: true, message: 'merged', conflictFiles: [] }),
      removeTaskWorktrees: async () => undefined,
      mergeDryRun: async () => ({ ok: true, conflictFiles: [] }),
    },
  }
}

function adapter(name: string): AgentAdapter {
  return {
    name,
    checkInstalled: async () => ({ installed: true }),
    execute: async (req) => {
      req.onOutput(`[${name}] hello from ${name}\n`)
      req.onOutput(`[${name}] second line\n`)
      const result: AgentExecuteResult = { exitCode: 0, stdout: `[${name}] done`, stderr: '', timedOut: false }
      return result
    },
  }
}

const roots: string[] = []
async function tmpRoot(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'helmsman-restart-'))
  const root = join(base, 'history')
  roots.push(base)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })))
})

describe('durable history across a host restart', () => {
  it('reloads terminal state and the full event timeline through the same store', async () => {
    const root = await tmpRoot()
    const store = new JsonlHistoryStore({ rootDir: root })
    const core = new OrchestratorCore({ worktree: makeWorktree().impl, history: store, delay: async () => undefined })
    core.registerAdapter(adapter('claude'))

    const { taskId } = await core.runParallelTask({ prompt: 'do it', agents: ['claude'], repoPath: '/repo' })
    await core.waitForTask(taskId)
    await store.flush()
    expect(core.getTaskStatus(taskId)?.status).toBe('COMPLETED')

    // "restart": a fresh core + a fresh store over the same directory
    const rebornStore = new JsonlHistoryStore({ rootDir: root })
    const restored = await rebornStore.listTasks()
    expect(restored.map((t) => t.id)).toEqual([taskId])
    const rebornCore = new OrchestratorCore({ worktree: makeWorktree().impl, history: rebornStore, delay: async () => undefined })
    rebornCore.restoreTasks(restored)

    const task = rebornCore.getTaskStatus(taskId)
    expect(task?.status).toBe('COMPLETED')
    expect(task?.agents.claude?.state).toBe('completed')

    const page = await rebornStore.eventsAfter(taskId, 0)
    expect(page.pruned).toBe(false)
    expect(page.events.length).toBeGreaterThan(0)
    // ordered seq from the first event
    expect(page.events[0]!.seq).toBe(1)
    const seqs = page.events.map((e) => e.seq)
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs)
    // timeline contains agent log lines and a terminal task-state
    const logTexts = page.events.filter((e) => e.kind === 'agent-log').map((e) => e.payload.text)
    expect(logTexts.some((t) => t.includes('hello from claude'))).toBe(true)
    const terminal = page.events.filter((e) => e.kind === 'task-state' && e.payload.status === 'COMPLETED')
    expect(terminal.length).toBeGreaterThan(0)
    // empty result when the cursor is at the latest seq
    const atLatest = await rebornStore.eventsAfter(taskId, seqs[seqs.length - 1]!)
    expect(atLatest.events).toEqual([])
    expect(atLatest.pruned).toBe(false)
  })

  it('marks restored non-terminal records as interrupted, terminal ones not', () => {
    const core = new OrchestratorCore({ worktree: makeWorktree().impl, delay: async () => undefined })
    const running: TaskRecord = {
      id: 't-running',
      prompt: 'x',
      cascade: false,
      timeoutSec: 300,
      status: 'RUNNING',
      createdAt: 1,
      agents: { claude: { agent: 'claude', state: 'running', attempts: 1, log: '' } },
    }
    const completed: TaskRecord = { ...running, id: 't-done', status: 'COMPLETED' }
    core.restoreTasks([running, completed])
    expect(core.getTaskStatus('t-running')?.interrupted).toBe(true)
    expect(core.getTaskStatus('t-done')?.interrupted).toBeUndefined()
  })

  it('still emits task-updated events when history is enabled', async () => {
    const root = await tmpRoot()
    const store = new JsonlHistoryStore({ rootDir: root })
    const seen: TaskRecord[] = []
    const core = new OrchestratorCore({
      worktree: makeWorktree().impl,
      history: store,
      delay: async () => undefined,
      onTaskUpdated: (t) => seen.push(t.id),
    })
    core.registerAdapter(adapter('claude'))
    const { taskId } = await core.runParallelTask({ prompt: 'do it', agents: ['claude'], repoPath: '/repo' })
    await core.waitForTask(taskId)
    expect(seen.length).toBeGreaterThan(1)
    expect(seen.every((id) => id === taskId)).toBe(true)
  })
})
