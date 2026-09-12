import { describe, expect, it, vi } from 'vitest'
import { OrchestratorCore } from './core.ts'
import { classifyFailure, type AgentAdapter, type AgentExecuteResult, type TaskRecord } from './types.ts'

function makeWorktree() {
  const removed: string[] = []
  const created: Array<{ id: string; agent: string; taskId: string; path: string }> = []
  return {
    removed,
    impl: {
      createWorktree: async ({ taskId, agent }: { taskId: string; agent: string }) => {
        const rec = { id: `wt-${taskId}-${agent}`, agent, taskId, path: `/tmp/wt-${taskId}-${agent}` }
        created.push(rec)
        return { ...rec, branch: `helmsman/${taskId}-${agent}`, baseSha: 'abc123' }
      },
      removeWorktree: async (id: string) => {
        removed.push(id)
      },
      listWorktrees: async () => [...created],
      getDiff: async (id: string) => ({
        worktreeId: id,
        files: [
          {
            path: id.includes('claude') ? 'shared.txt' : 'codex-only.txt',
            status: 'modified' as const,
            additions: 10,
            deletions: 2,
            diff: `diff --git a/${id.includes('claude') ? 'shared.txt' : 'codex-only.txt'} b/x\n@@ -1,1 +1,10 @@\n`,
          },
        ],
        additions: 10,
        deletions: 2,
      }),
      mergeWorktree: async ({ worktreeId }: { worktreeId: string }) => ({
        ok: true,
        committed: true,
        message: `merged ${worktreeId}`,
        conflictFiles: [],
      }),
      removeTaskWorktrees: async (taskId: string) => {
        for (const rec of created.filter((r) => r.taskId === taskId)) removed.push(rec.id)
      },
      mergeDryRun: async () => ({ ok: true, conflictFiles: [] }),
    },
  }
}

function adapter(name: string, behavior: (attempt: number, req: Parameters<AgentAdapter['execute']>[0]) => Promise<AgentExecuteResult>): AgentAdapter {
  let attempt = 0
  return {
    name,
    checkInstalled: async () => ({ installed: true, version: '1.0' }),
    execute: async (req) => {
      attempt += 1
      req.onOutput(`[attempt ${attempt}] `)
      return await behavior(attempt, req)
    },
  }
}

const ok = (stdout = 'done'): AgentExecuteResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false })
const rateLimited = (): AgentExecuteResult => ({ exitCode: 1, stdout: '', stderr: 'Error: 429 rate limit exceeded', timedOut: false })
const authFail = (): AgentExecuteResult => ({ exitCode: 1, stdout: '', stderr: '401 Unauthorized: invalid api key', timedOut: false })

async function runTask(core: OrchestratorCore, agents: string[], opts: Record<string, unknown> = {}): Promise<{ taskId: string }> {
  const { taskId } = await core.runParallelTask({ prompt: 'do it', agents, repoPath: '/repo', ...opts })
  await core.waitForTask(taskId)
  return { taskId }
}

describe('OrchestratorCore', () => {
  it('happy path: parallel success reaches COMPLETED with aggregation', async () => {
    const wt = makeWorktree()
    const core = new OrchestratorCore({
      worktree: wt.impl,
      delay: async () => undefined,
      onTaskUpdated: vi.fn(),
    })
    core.registerAdapter(adapter('claude', async () => ok()))
    core.registerAdapter(adapter('codex', async () => ok()))

    const { taskId } = await runTask(core, ['claude', 'codex'])
    const task = core.getTaskStatus(taskId)
    expect(task?.status).toBe('COMPLETED')
    expect(task?.agents['claude']?.state).toBe('completed')
    expect(task?.agents['claude']?.attempts).toBe(1)
    expect(task?.agents['claude']?.log).toContain('attempt 1')
    expect(task?.agents['claude']?.stats).toEqual({ files: 1, additions: 10, deletions: 2 })
    // conflict: shared.txt changed only by claude here → no conflicts
    expect(task?.agents['claude']?.conflictingFiles).toBeUndefined()
  })

  it('rate-limited agent retries with backoff then completes', async () => {
    const wt = makeWorktree()
    const delays: number[] = []
    const core = new OrchestratorCore({
      worktree: wt.impl,
      delay: async (ms) => {
        delays.push(ms)
      },
    })
    core.registerAdapter(adapter('claude', async (attempt) => (attempt < 3 ? rateLimited() : ok())))
    core.registerAdapter(adapter('codex', async () => ok()))

    const { taskId } = await runTask(core, ['claude', 'codex'])
    const task = core.getTaskStatus(taskId)
    expect(task?.status).toBe('COMPLETED')
    expect(task?.agents['claude']?.attempts).toBe(3)
    expect(delays).toEqual([2_000, 8_000])
  })

  it('rate-limited beyond max attempts ends PARTIAL_FAILED', async () => {
    const wt = makeWorktree()
    const core = new OrchestratorCore({ worktree: wt.impl, delay: async () => undefined })
    core.registerAdapter(adapter('claude', async () => rateLimited()))
    core.registerAdapter(adapter('codex', async () => ok()))

    const { taskId } = await runTask(core, ['claude', 'codex'])
    const task = core.getTaskStatus(taskId)
    expect(task?.status).toBe('PARTIAL_FAILED')
    expect(task?.agents['claude']?.state).toBe('rate-limited')
    expect(task?.agents['claude']?.attempts).toBe(4) // initial + 3 retries
  })

  it('auth failure does not retry', async () => {
    const wt = makeWorktree()
    const core = new OrchestratorCore({ worktree: wt.impl, delay: async () => undefined })
    core.registerAdapter(adapter('claude', async () => authFail()))
    core.registerAdapter(adapter('codex', async () => ok()))

    const { taskId } = await runTask(core, ['claude', 'codex'])
    const task = core.getTaskStatus(taskId)
    expect(task?.status).toBe('PARTIAL_FAILED')
    expect(task?.agents['claude']?.state).toBe('auth-failed')
    expect(task?.agents['claude']?.attempts).toBe(1)
  })

  it('circuit breaker blocks calls after repeated failures', async () => {
    const wt = makeWorktree()
    let now = Date.now()
    const core = new OrchestratorCore({
      worktree: wt.impl,
      delay: async () => undefined,
      now: () => now,
      circuitBreakerThreshold: 2,
      circuitBreakerCooldownMs: 30_000,
    })
    core.registerAdapter(adapter('claude', async () => authFail()))
    core.registerAdapter(adapter('codex', async () => ok()))

    for (let i = 0; i < 2; i++) {
      const { taskId } = await runTask(core, ['claude'])
      const task = core.getTaskStatus(taskId)
      expect(task?.status).toBe('ALL_FAILED')
    }
    // third task: breaker is open → fast-fail without calling the adapter
    const { taskId } = await runTask(core, ['claude'])
    const task = core.getTaskStatus(taskId)!
    expect(task.agents['claude']?.error).toContain('断路器')
    expect(task.agents['claude']?.attempts).toBe(0)

    now += 60_000 // cooldown elapsed
    const { taskId: t2 } = await runTask(core, ['claude'])
    expect(core.getTaskStatus(t2)?.agents['claude']?.attempts).toBe(1)
  })

  it('cancelTask aborts running agents', async () => {
    const wt = makeWorktree()
    const core = new OrchestratorCore({ worktree: wt.impl, delay: async () => undefined })
    core.registerAdapter(
      adapter('claude', async (_attempt, req) => {
        await new Promise<void>((resolve) => {
          const check = setInterval(() => {
            if (req.signal.aborted) {
              clearInterval(check)
              resolve()
            }
          }, 10)
        })
        return { exitCode: null, stdout: '', stderr: 'SIGTERM', timedOut: false }
      }),
    )
    core.registerAdapter(adapter('codex', async (req) => {
      await new Promise((r) => setTimeout(r, 50))
      expect(req.signal.aborted).toBe(true)
      return ok()
    }))

    const { taskId } = await core.runParallelTask({ prompt: 'do it', agents: ['claude', 'codex'], repoPath: '/repo' })
    await new Promise((r) => setTimeout(r, 30)) // let agents start
    core.cancelTask(taskId)
    await core.waitForTask(taskId)
    expect(core.getTaskStatus(taskId)?.status).toBe('CANCELLED')
  })

  it('aggregate no longer flags files touched by multiple agents (conflicts are real apply failures, D5)', async () => {
    const wt = makeWorktree()
    const core = new OrchestratorCore({ worktree: wt.impl, delay: async () => undefined })
    core.registerAdapter(adapter('claude', async () => ok()))
    core.registerAdapter(adapter('codex', async () => ok()))
    // both agents produce a diff for the SAME file — under the pre-D5 heuristic
    // this used to be flagged as a conflict; now aggregation only collects diffs
    // and a merge decides conflicts by actual patch-apply failure.
    wt.impl.getDiff = async (id: string) => ({
      worktreeId: id,
      files: [
        {
          path: 'shared.txt',
          status: 'modified' as const,
          additions: 5,
          deletions: 1,
          diff: 'diff --git a/shared.txt b/shared.txt\n@@ -1,1 +1,5 @@\n',
        },
      ],
      additions: 5,
      deletions: 1,
    })

    const { taskId } = await runTask(core, ['claude', 'codex'])
    const task = core.getTaskStatus(taskId)!
    expect(task.agents['claude']?.state).toBe('completed')
    expect(task.agents['claude']?.diffs?.map((d) => d.path)).toEqual(['shared.txt'])
    expect(task.agents['claude']?.conflictingFiles).toBeUndefined()
    expect(task.agents['codex']?.conflictingFiles).toBeUndefined()
  })

  it('mergeTask and discardTask delegate to the worktree service', async () => {
    const wt = makeWorktree()
    const core = new OrchestratorCore({ worktree: wt.impl, delay: async () => undefined })
    core.registerAdapter(adapter('claude', async () => ok()))
    const { taskId } = await runTask(core, ['claude'])

    const merge = await core.mergeTask({ taskId, discardAfterMerge: true })
    expect(merge.results[0]).toMatchObject({ agent: 'claude', ok: true, committed: true })
    expect(wt.removed.length).toBeGreaterThan(0)
    expect(wt.removed[0]).toMatch(/^wt-t-.*-claude$/)
  })

  it('emits task events and enforces validation', async () => {
    const events: TaskRecord[] = []
    const wt = makeWorktree()
    const core = new OrchestratorCore({ worktree: wt.impl, delay: async () => undefined, onTaskUpdated: (t) => events.push(structuredClone(t)) })
    core.registerAdapter(adapter('claude', async () => ok()))
    await runTask(core, ['claude'])
    expect(events.length).toBeGreaterThan(1)
    expect(events.every((t) => t.id && t.createdAt > 0)).toBe(true)

    await expect(core.runParallelTask({ prompt: '', agents: ['claude'], repoPath: '/repo' })).rejects.toThrow(/prompt/)
    await expect(core.runParallelTask({ prompt: 'x', agents: [], repoPath: '/repo' })).rejects.toThrow(/no agent/)
    await expect(core.runParallelTask({ prompt: 'x', agents: ['ghost'], repoPath: '/repo' })).rejects.toThrow(/no adapter/)
    await expect(core.runParallelTask({ prompt: 'x', agents: ['claude'] })).rejects.toThrow(/repoPath/)
  })

  it('cascade injects topology context from the topology service', async () => {
    const wt = makeWorktree()
    let receivedPrompt = ''
    const core = new OrchestratorCore({
      worktree: wt.impl,
      delay: async () => undefined,
      topology: {
        loadTopology: async () => ({
          services: { 'user-service': { name: 'user-service', localPath: '/repo' } },
          restDependencies: { 'user-service': [{ toServiceId: 'order-service', endpoints: ['/api/orders'], method: 'GET' }] },
        }),
        getDownstream: async () => ({ direct: [], calledBy: [], transitive: [], cyclic: false }),
      },
    })
    core.registerAdapter(
      adapter('claude', async (_attempt, req) => {
        receivedPrompt = req.prompt
        return ok()
      }),
    )
    await runTask(core, ['claude'], { projectGroupId: '订单中台', cascade: true })
    expect(receivedPrompt).toContain('项目拓扑上下文')
    expect(receivedPrompt).toContain('user-service')
  })

  // simplify-service-dependencies：无端点明细的服务级边注入文本退化为 `- A --▶ B`，
  // 不带方法名也不留尾随空格；带明细的边保持历史形态。
  it('cascade injects service-level edges as `- A --▶ B` (no method, no trailing space)', async () => {
    const wt = makeWorktree()
    let receivedPrompt = ''
    const core = new OrchestratorCore({
      worktree: wt.impl,
      delay: async () => undefined,
      topology: {
        loadTopology: async () => ({
          services: { 'user-service': { name: 'user-service', localPath: '/repo' } },
          restDependencies: {
            'user-service': [
              { toServiceId: 'order-service', endpoints: [], method: '*' },
              { toServiceId: 'stock-service', endpoints: ['/api/stock'], method: 'GET' },
            ],
          },
        }),
        getDownstream: async () => ({ direct: [], calledBy: [], transitive: [], cyclic: false }),
      },
    })
    core.registerAdapter(
      adapter('claude', async (_attempt, req) => {
        receivedPrompt = req.prompt
        return ok()
      }),
    )
    await runTask(core, ['claude'], { projectGroupId: '订单中台', cascade: true })

    expect(receivedPrompt).toContain('- user-service --▶ order-service')
    expect(receivedPrompt).not.toContain('--*-->')
    expect(receivedPrompt).not.toMatch(/--▶ order-service +$/m)
    expect(receivedPrompt).toContain('- user-service --GET--> stock-service /api/stock')
  })
})

describe('classifyFailure', () => {
  it.each([
    [{ exitCode: null, stderr: '', timedOut: true }, 'timeout'],
    [{ exitCode: 1, stderr: 'HTTP 429 Too Many Requests', timedOut: false }, 'rate-limited'],
    [{ exitCode: 1, stderr: 'Error: invalid api key', timedOut: false }, 'auth-failed'],
    [{ exitCode: 1, stderr: 'something exploded', timedOut: false }, 'failed'],
  ] as const)('classifies %j → %s', (input, expected) => {
    expect(classifyFailure(input).state).toBe(expected)
  })
})
