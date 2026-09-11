import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { OrchestratorService } from '@helmsman/orchestrator'
import { createDiffApiRouter } from './api.ts'

function fakeReq(method: string, body?: unknown): IncomingMessage {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    method,
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c
    },
  } as unknown as IncomingMessage
}

function fakeRes(): { res: ServerResponse; status: () => number; body: () => string } {
  let status = 0
  let out = ''
  const res = {
    writeHead: (code: number) => {
      status = code
      return res
    },
    end: (b?: string) => {
      out = b ?? ''
    },
  } as unknown as ServerResponse
  return { res, status: () => status, body: () => out }
}

function fakeOrchestrator(): OrchestratorService {
  const task = {
    id: 't-1',
    prompt: '修复登录验证',
    projectGroupId: '订单中台',
    cascade: false,
    timeoutSec: 300,
    status: 'COMPLETED' as const,
    createdAt: 1_700_000_000_000,
    agents: {
      claude: {
        agent: 'claude',
        state: 'completed' as const,
        attempts: 1,
        log: '',
        stats: { files: 1, additions: 23, deletions: 7 },
        conflictingFiles: ['src/LoginForm.tsx'],
        diffs: [
          {
            path: 'src/LoginForm.tsx',
            status: 'modified' as const,
            additions: 23,
            deletions: 7,
            diff: 'diff --git a/src/LoginForm.tsx b/src/LoginForm.tsx\n@@ -1,1 +1,2 @@\n+const validateEmail = 1\n',
          },
        ],
      },
      codex: {
        agent: 'codex',
        state: 'completed' as const,
        attempts: 1,
        log: '',
        stats: { files: 1, additions: 31, deletions: 5 },
        conflictingFiles: ['src/LoginForm.tsx'],
        diffs: [
          {
            path: 'src/LoginForm.tsx',
            status: 'modified' as const,
            additions: 31,
            deletions: 5,
            diff: 'diff --git a/src/LoginForm.tsx b/src/LoginForm.tsx\n@@ -1,1 +1,2 @@\n+const validateInput = 1\n',
          },
        ],
      },
    },
  }
  return {
    registerAdapter: () => undefined,
    checkAgents: async () => ({}),
    runParallelTask: async () => ({ taskId: 't' }),
    cancelTask: async () => undefined,
    getTaskStatus: (id: string) => (id === 't-1' ? task : undefined),
    listTasks: () => [task],
    retryTask: async () => ({ taskId: 't' }),
    mergeTask: vi.fn(async ({ taskId, agents }: { taskId: string; agents?: string[]; files?: string[] }) => ({
      taskId,
      results: (agents ?? ['claude', 'codex']).map((agent) => ({ agent, ok: true, committed: true, message: 'merged', conflictFiles: [] })),
    })),
    discardTask: vi.fn(async () => undefined),
    getUsage: () => ({}),
    // approval gate / conflicts surface (additive)
    isConfirmRequired: vi.fn((op: string) => op === 'merge'),
    policyMode: vi.fn(() => 'confirm-required'),
    requestConfirmation: vi.fn((req: { op: string; taskId?: string; group?: string }, source = 'ui') => ({
      approvalId: 'ap-diff',
      op: req.op,
      scope: `${req.op}:task:${req.taskId ?? ''}`,
      source,
      requestedAt: 1,
      expiresAt: 2,
    })),
    decideConfirmation: vi.fn((_id: string, approve: boolean) =>
      approve ? { granted: true, token: 'tok', expiresAt: 2 } : { granted: false, reason: 'denied' }),
    listPendingConfirmations: vi.fn(() => []),
    assertApproved: vi.fn(async () => undefined),
    scopeKey: vi.fn((op: string) => op),
    getAudit: vi.fn(async () => []),
    getRealConflicts: vi.fn(async () => ['src/LoginForm.tsx']),
    history: {
      getTask: async () => undefined,
      getEvents: async () => ({ events: [], pruned: false }),
      subscribe: () => () => undefined,
    },
  } as unknown as OrchestratorService
}

describe('diff API router', () => {
  it('GET api/task/:id returns per-agent diffs incl. conflict files', async () => {
    const router = createDiffApiRouter(fakeOrchestrator())
    const { res, status, body } = fakeRes()
    await router.handle(fakeReq('GET'), res, '/api/task/t-1')
    expect(status()).toBe(200)
    const data = JSON.parse(body())
    expect(data.found).toBe(true)
    expect(data.task.agents.claude.stats.additions).toBe(23)
    expect(data.task.agents.claude.diffs[0].diff).toContain('validateEmail')
    expect(data.task.agents.claude.conflictingFiles).toContain('src/LoginForm.tsx')
  })

  it('GET api/task/:id for unknown id → found: false', async () => {
    const router = createDiffApiRouter(fakeOrchestrator())
    const { res, body } = fakeRes()
    await router.handle(fakeReq('GET'), res, '/api/task/nope')
    expect(JSON.parse(body()).found).toBe(false)
  })

  it('GET api/task/:id/conflicts returns REAL conflicts from the dry-run', async () => {
    const orch = fakeOrchestrator()
    const router = createDiffApiRouter(orch)
    const { res, body } = fakeRes()
    await router.handle(fakeReq('GET'), res, '/api/task/t-1/conflicts')
    expect(orch.getRealConflicts).toHaveBeenCalledWith('t-1')
    expect(JSON.parse(body()).conflictFiles).toEqual(['src/LoginForm.tsx'])
  })

  it('POST merge forwards agents/files, confirmationToken and resolutions', async () => {
    const orch = fakeOrchestrator()
    const router = createDiffApiRouter(orch)
    const { res, body } = fakeRes()
    await router.handle(
      fakeReq('POST', {
        agents: ['claude'],
        files: ['src/LoginForm.tsx'],
        confirmationToken: 'tok',
        resolutions: { 'src/LoginForm.tsx': { kind: 'agent', agent: 'claude' } },
      }),
      res,
      '/api/task/t-1/merge',
    )
    expect(orch.mergeTask).toHaveBeenCalledWith({
      taskId: 't-1',
      agents: ['claude'],
      files: ['src/LoginForm.tsx'],
      confirmationToken: 'tok',
      resolutions: { 'src/LoginForm.tsx': { kind: 'agent', agent: 'claude' } },
      source: 'ui',
    })
    const data = JSON.parse(body())
    expect(data.results).toHaveLength(1)
    expect(data.results[0].committed).toBe(true)
  })

  it('POST discard forwards the confirmation token with ui source', async () => {
    const orch = fakeOrchestrator()
    const router = createDiffApiRouter(orch)
    const { res, body } = fakeRes()
    await router.handle(fakeReq('POST', { confirmationToken: 'd' }), res, '/api/task/t-1/discard')
    expect(orch.discardTask).toHaveBeenCalledWith('t-1', 'd', 'ui')
    expect(JSON.parse(body()).ok).toBe(true)
  })

  it('GET api/tasks lists task summaries', async () => {
    const router = createDiffApiRouter(fakeOrchestrator())
    const { res, body } = fakeRes()
    await router.handle(fakeReq('GET'), res, '/api/tasks')
    const data = JSON.parse(body())
    expect(data.tasks).toHaveLength(1)
    expect(data.tasks[0].prompt).toBe('修复登录验证')
  })

  it('approval endpoints: request, decision, policy', async () => {
    const orch = fakeOrchestrator()
    const router = createDiffApiRouter(orch)
    let r = fakeRes()
    await router.handle(fakeReq('POST', { op: 'merge', taskId: 't-1' }), r.res, '/api/approvals')
    expect(orch.requestConfirmation).toHaveBeenCalledWith({ op: 'merge', taskId: 't-1' }, 'ui')
    expect(JSON.parse(r.body()).approvalId).toBe('ap-diff')
    r = fakeRes()
    await router.handle(fakeReq('POST', { approve: true }), r.res, '/api/approvals/ap-diff/decision')
    expect(JSON.parse(r.body()).granted).toBe(true)
    r = fakeRes()
    await router.handle(fakeReq('GET'), r.res, '/api/approvals/policy?op=merge')
    expect(orch.policyMode).toHaveBeenCalledWith('merge')
    expect(JSON.parse(r.body()).confirmRequired).toBe(true)
  })
})
