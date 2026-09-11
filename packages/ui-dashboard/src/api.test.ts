import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createApiRouter, type TopologyServiceLike } from './api.ts'

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

function fakeOrchestrator() {
  return {
    checkAgents: async () => ({ claude: { installed: true, version: '1.2.3' }, codex: { installed: false } }),
    runParallelTask: vi.fn(async ({ prompt, agents }: { prompt: string; agents: string[] }) => {
      if (!prompt) throw new Error('prompt must not be empty')
      return { taskId: `t-${agents.join('+')}` }
    }),
    cancelTask: vi.fn(async () => undefined),
    retryTask: vi.fn(async () => ({ taskId: 't1' })),
    getTaskStatus: () => undefined,
    listTasks: () => [],
    mergeTask: vi.fn(async () => ({ taskId: 't1', results: [] })),
    discardTask: vi.fn(async () => undefined),
    getUsage: () => ({ claude: { runs: 1, promptChars: 10, outputChars: 20, estimatedTokens: 8 } }),
    history: makeHistory(),
    // approval gate / audit / conflicts (additive surface)
    isConfirmRequired: vi.fn((op: string) => op === 'merge'),
    policyMode: vi.fn(() => 'confirm-required'),
    requestConfirmation: vi.fn((req: { op: string; taskId?: string; group?: string }, source = 'ui') => ({
      approvalId: 'ap-1',
      op: req.op,
      scope: `${req.op}:${req.taskId ? `task:${req.taskId}` : `group:${req.group ?? ''}`}`,
      source,
      requestedAt: 1000,
      expiresAt: 1000 + 300_000,
    })),
    decideConfirmation: vi.fn((_id: string, approve: boolean) =>
      approve ? { granted: true, token: 'tok-16byte-hex', expiresAt: 1000 + 300_000 } : { granted: false, reason: 'denied' }),
    listPendingConfirmations: vi.fn(() => []),
    assertApproved: vi.fn(async () => undefined),
    scopeKey: vi.fn((op: string, req: { taskId?: string; group?: string }) => `${op}:${req.taskId ? `task:${req.taskId}` : `group:${req.group ?? ''}`}`),
    getAudit: vi.fn(async () => []),
    getRealConflicts: vi.fn(async () => []),
  }
}

/** Default history stub: nothing stored, never pruned, no live subscribers. */
function makeHistory(overrides: Partial<{
  getTask: (taskId: string) => Promise<unknown>
  getEvents: (taskId: string, after: number) => Promise<{ events: unknown[]; pruned: boolean }>
  subscribe: (taskId: string, listener: (e: unknown) => void) => () => void
}> = {}) {
  const noop = async () => undefined
  return {
    getTask: overrides.getTask ?? noop,
    getEvents: overrides.getEvents ?? (async () => ({ events: [], pruned: false })),
    subscribe: overrides.subscribe ?? (() => () => undefined),
  }
}

/** Event emitter + write capture for the SSE route tests. */
function streamReqRes(): { req: IncomingMessage; res: ServerResponse & { write: (c: string) => void }; chunks: () => string; ended: () => boolean } {
  const req = new EventEmitter() as unknown as IncomingMessage
  Object.defineProperty(req, 'method', { value: 'GET' })
  const chunks: string[] = []
  let ended = false
  const res = new EventEmitter() as unknown as ServerResponse & { write: (c: string) => void }
  res.writeHead = (() => res) as unknown as ServerResponse['writeHead']
  res.write = (c: string | Uint8Array) => {
    chunks.push(typeof c === 'string' ? c : Buffer.from(c).toString())
    return true
  }
  res.end = () => {
    ended = true
    res.emit('close')
    return res
  }
  Object.defineProperty(res, 'writableEnded', { get: () => ended })
  return { req, res, chunks: () => chunks.join(''), ended: () => ended }
}

/** One versioned event for the timeline payloads used below. */
function makeEvent(seq: number, kind: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { v: 1, seq, ts: seq * 1000, taskId: 't1', kind, payload: extra, ...(kind === 'task-state' ? {} : { agent: 'claude' }) }
}

const terminalRecord = {
  id: 't1',
  prompt: 'fix',
  cascade: false,
  timeoutSec: 300,
  status: 'COMPLETED',
  createdAt: 1,
  endedAt: 2,
  agents: { claude: { agent: 'claude', state: 'completed', attempts: 1, log: '' } },
}

const fakeTopology: TopologyServiceLike = {
  listGroups: async () => ['订单中台'],
  loadTopology: async () => null,
  saveTopology: async () => undefined,
  deleteGroup: async () => true,
  createGroup: async (group) => {
    return {
      projectGroupId: group,
      name: group,
      description: '',
      defaultBranch: 'main',
      projects: {},
      services: {},
      mavenParents: {},
      restDependencies: {},
    }
  },
  scanRestApis: async () => [{ method: 'GET', path: '/api/users' }],
  importPreview: async (_s, text) => (text.includes('api-gateway') ? { source: 'docker-compose', services: [{ name: 'api-gateway', selected: true, endpoints: [] }], dependencies: [], warnings: [] } : { source: 'docker-compose', services: [], dependencies: [], warnings: ['未在 compose 文件中发现 services 定义'] }),
  importApply: async (group) => {
    return {
      projectGroupId: group,
      name: group,
      description: '',
      defaultBranch: 'main',
      projects: {},
      services: { 'api-gateway': { name: 'api-gateway', projectId: 'api-gateway', techStack: [], apiEndpoints: [] } },
      mavenParents: {},
      restDependencies: {},
    }
  },
  exportYaml: async () => 'projectGroup:\n  name: 订单中台\n',
}

describe('dashboard API router', () => {
  it('GET api/state aggregates agents, groups, usage', async () => {
    const router = createApiRouter({ orchestrator: fakeOrchestrator(), topology: fakeTopology })
    const { res, status, body } = fakeRes()
    const handled = await router.handle(fakeReq('GET'), res, '/api/state')
    expect(handled).toBe(true)
    expect(status()).toBe(200)
    const data = JSON.parse(body())
    expect(data.groups).toEqual(['订单中台'])
    expect(data.agents.claude).toEqual({ installed: true, version: '1.2.3' })
    expect(data.usage.claude.estimatedTokens).toBe(8)
  })

  it('POST api/task forwards prompt/agents and returns taskId', async () => {
    const orch = fakeOrchestrator()
    const router = createApiRouter({ orchestrator: orch, topology: fakeTopology })
    const { res, status, body } = fakeRes()
    await router.handle(fakeReq('POST', { prompt: '修复登录', agents: ['claude', 'codex'] }), res, '/api/task')
    expect(status()).toBe(200)
    expect(JSON.parse(body()).taskId).toBe('t-claude+codex')
    expect(orch.runParallelTask).toHaveBeenCalledWith(expect.objectContaining({ prompt: '修复登录', agents: ['claude', 'codex'] }))
  })

  it('POST api/task with bad input returns 500 + error json', async () => {
    const router = createApiRouter({ orchestrator: fakeOrchestrator(), topology: fakeTopology })
    const { res, status, body } = fakeRes()
    await router.handle(fakeReq('POST', { prompt: '', agents: ['claude'] }), res, '/api/task')
    expect(status()).toBe(500)
    expect(JSON.parse(body()).error).toContain('prompt')
  })

  it('cancel/retry/merge/discard routes map to orchestrator calls', async () => {
    const orch = fakeOrchestrator()
    const router = createApiRouter({ orchestrator: orch, topology: fakeTopology })
    let r = fakeRes()
    await router.handle(fakeReq('POST', { confirmationToken: 'tok' }), r.res, '/api/task/t1/cancel')
    expect(orch.cancelTask).toHaveBeenCalledWith('t1', 'tok', 'ui')
    r = fakeRes()
    await router.handle(fakeReq('POST', { agents: ['claude'] }), r.res, '/api/task/t1/retry')
    expect(orch.retryTask).toHaveBeenCalledWith('t1', ['claude'])
    r = fakeRes()
    await router.handle(fakeReq('POST', { agents: ['claude'], files: ['a.ts'] }), r.res, '/api/task/t1/merge')
    expect(orch.mergeTask).toHaveBeenCalledWith({ taskId: 't1', agents: ['claude'], files: ['a.ts'], source: 'ui' })
    r = fakeRes()
    await router.handle(fakeReq('POST', { confirmationToken: 'tok2' }), r.res, '/api/task/t1/discard')
    expect(orch.discardTask).toHaveBeenCalledWith('t1', 'tok2', 'ui')
  })

  it('dashboard cancel attributes the audit source ui even without a token (C)', async () => {
    const orch = fakeOrchestrator()
    const router = createApiRouter({ orchestrator: orch })
    const { res } = fakeRes()
    await router.handle(fakeReq('POST', {}), res, '/api/task/t1/cancel')
    expect(orch.cancelTask).toHaveBeenCalledWith('t1', undefined, 'ui')
  })

  it('dashboard discard attributes the audit source ui even without a token', async () => {
    const orch = fakeOrchestrator()
    const router = createApiRouter({ orchestrator: orch })
    const { res } = fakeRes()
    await router.handle(fakeReq('POST', {}), res, '/api/task/t1/discard')
    expect(orch.discardTask).toHaveBeenCalledWith('t1', undefined, 'ui')
  })

  it('gated merge/discard forward confirmationToken and resolutions', async () => {
    const orch = fakeOrchestrator()
    const router = createApiRouter({ orchestrator: orch, topology: fakeTopology })
    const { res, status } = fakeRes()
    await router.handle(
      fakeReq('POST', {
        agents: ['claude'],
        confirmationToken: 'merge-token',
        resolutions: { 'a.ts': { kind: 'agent', agent: 'claude' } },
      }),
      res,
      '/api/task/t1/merge',
    )
    expect(status()).toBe(200)
    expect(orch.mergeTask).toHaveBeenCalledWith({
      taskId: 't1',
      agents: ['claude'],
      confirmationToken: 'merge-token',
      resolutions: { 'a.ts': { kind: 'agent', agent: 'claude' } },
      source: 'ui',
    })
  })

  it('topology delete is gated via assertApproved before deleting', async () => {
    const orch = fakeOrchestrator()
    const deleteGroup = vi.fn(async () => true)
    const router = createApiRouter({ orchestrator: orch, topology: { ...fakeTopology, deleteGroup } })
    let r = fakeRes()
    await router.handle(fakeReq('POST', { group: '订单中台' }), r.res, '/api/topology/delete')
    expect(orch.assertApproved).toHaveBeenCalledWith({ op: 'topology-delete', group: '订单中台' }, undefined, 'ui')
    expect(deleteGroup).toHaveBeenCalledWith('订单中台')
    expect(JSON.parse(r.body()).ok).toBe(true)
    // token passes through the gate when provided
    deleteGroup.mockClear()
    orch.assertApproved.mockClear()
    r = fakeRes()
    await router.handle(fakeReq('POST', { group: 'g', confirmationToken: 'del-tok' }), r.res, '/api/topology/delete')
    expect(orch.assertApproved).toHaveBeenCalledWith({ op: 'topology-delete', group: 'g' }, 'del-tok', 'ui')
  })

  it('topology routes: create, scan-api, import-preview, import-apply', async () => {
    const router = createApiRouter({ orchestrator: fakeOrchestrator(), topology: fakeTopology })
    let r = fakeRes()
    await router.handle(fakeReq('POST', { group: '支付中台' }), r.res, '/api/topology/create')
    expect(JSON.parse(r.body()).topology.projectGroupId).toBe('支付中台')

    r = fakeRes()
    await router.handle(fakeReq('POST', { localPath: '/repo' }), r.res, '/api/topology/scan-api')
    expect(JSON.parse(r.body()).total).toBe(1)

    r = fakeRes()
    await router.handle(fakeReq('POST', { source: 'docker-compose', text: 'services:\n  api-gateway: {}' }), r.res, '/api/topology/import-preview')
    expect(JSON.parse(r.body()).services).toHaveLength(1)

    r = fakeRes()
    await router.handle(fakeReq('POST', { group: 'g1', preview: { services: [{ name: 'api-gateway', selected: true, endpoints: [] }], dependencies: [], warnings: [] } }), r.res, '/api/topology/import-apply')
    expect(JSON.parse(r.body()).topology.services['api-gateway']).toBeDefined()
  })

  it('unknown api route returns false (host answers 404)', async () => {
    const router = createApiRouter({ orchestrator: fakeOrchestrator(), topology: fakeTopology })
    const handled = await router.handle(fakeReq('GET'), fakeRes().res, '/api/unknown')
    expect(handled).toBe(false)
  })
})

describe('approval gate + audit routes', () => {
  it('GET api/approvals/pending lists pending confirmations', async () => {
    const orch = fakeOrchestrator()
    const pending = [{ approvalId: 'ap-1', op: 'merge', scope: 'merge:task:t-1', source: 'ui', requestedAt: 1, expiresAt: 2 }]
    orch.listPendingConfirmations = vi.fn(() => pending)
    const router = createApiRouter({ orchestrator: orch })
    const { res, body } = fakeRes()
    await router.handle(fakeReq('GET'), res, '/api/approvals/pending')
    expect(JSON.parse(body()).approvals).toEqual(pending)
  })

  it('POST api/approvals mints a request bound to op + task scope', async () => {
    const orch = fakeOrchestrator()
    const router = createApiRouter({ orchestrator: orch })
    const { res, status, body } = fakeRes()
    await router.handle(fakeReq('POST', { op: 'merge', taskId: 't-1' }), res, '/api/approvals')
    expect(status()).toBe(200)
    expect(orch.requestConfirmation).toHaveBeenCalledWith({ op: 'merge', taskId: 't-1' }, 'ui')
    expect(JSON.parse(body()).approvalId).toBe('ap-1')
  })

  it('POST api/approvals/:id/decision approves and returns a token', async () => {
    const orch = fakeOrchestrator()
    const router = createApiRouter({ orchestrator: orch })
    const { res, body } = fakeRes()
    await router.handle(fakeReq('POST', { approve: true }), res, '/api/approvals/ap-1/decision')
    expect(orch.decideConfirmation).toHaveBeenCalledWith('ap-1', true)
    expect(JSON.parse(body()).granted).toBe(true)
    expect(JSON.parse(body()).token).toBe('tok-16byte-hex')
  })

  it('POST api/approvals/:id/decision denying returns granted:false', async () => {
    const orch = fakeOrchestrator()
    const router = createApiRouter({ orchestrator: orch })
    const { res, body } = fakeRes()
    await router.handle(fakeReq('POST', { approve: false }), res, '/api/approvals/ap-1/decision')
    expect(JSON.parse(body())).toEqual({ granted: false, reason: 'denied' })
  })

  it('GET api/audit returns entries and forwards filters', async () => {
    const orch = fakeOrchestrator()
    const entries = [{ v: 1, ts: 1, type: 'decision', operation: 'merge', scope: 'merge:task:t-1', source: 'tool', decision: 'granted' }]
    orch.getAudit = vi.fn(async () => entries)
    const router = createApiRouter({ orchestrator: orch })
    const { res, body } = fakeRes()
    await router.handle(fakeReq('GET'), res, '/api/audit?op=merge&taskId=t-1&from=10&to=20')
    expect(orch.getAudit).toHaveBeenCalledWith({ op: 'merge', taskId: 't-1', from: 10, to: 20 })
    expect(JSON.parse(body()).entries).toEqual(entries)
  })
})

describe('history timeline + SSE routes', () => {
  it('GET api/task/:id/events returns ordered events after the cursor', async () => {
    const history = makeHistory({
      getTask: async () => terminalRecord,
      getEvents: async () => ({
        events: [
          makeEvent(3, 'agent-log', { text: 'a' }),
          makeEvent(4, 'task-state', { status: 'COMPLETED', id: 't1', createdAt: 1, agents: {} }),
        ],
        pruned: false,
      }),
    })
    const orch = fakeOrchestrator()
    orch.history = history
    const router = createApiRouter({ orchestrator: orch })
    const { res, status, body } = fakeRes()
    await router.handle(fakeReq('GET'), res, '/api/task/t1/events?after=2')
    const data = JSON.parse(body())
    expect(status()).toBe(200)
    expect(data.pruned).toBe(false)
    expect(data.after).toBe(2)
    expect(data.nextCursor).toBe(4)
    expect(data.events.map((e: { seq: number }) => e.seq)).toEqual([3, 4])
    expect(data.task.status).toBe('COMPLETED')
  })

  it('events route surfaces history-pruned and holds the cursor when empty', async () => {
    const history = makeHistory({
      getTask: async () => undefined,
      getEvents: async () => ({ events: [], pruned: true }),
    })
    const orch = fakeOrchestrator()
    orch.history = history
    const router = createApiRouter({ orchestrator: orch })
    const { res, body } = fakeRes()
    await router.handle(fakeReq('GET'), res, '/api/task/t1/events?after=5')
    const data = JSON.parse(body())
    expect(data.pruned).toBe(true)
    expect(data.events).toEqual([])
    expect(data.nextCursor).toBe(5)
    expect(data.task).toBeNull()
  })

  it('SSE stream replays after the cursor, merges in-flight events without dup, tails live, heartbeats', async () => {
    vi.useFakeTimers()
    try {
      let listener: ((e: unknown) => void) | undefined
      const history = makeHistory({
        getTask: async () => ({ ...terminalRecord, status: 'RUNNING' }),
        getEvents: async () => {
          // an event landing after subscribe but before the replay resolves
          listener?.({ ...makeEvent(6, 'agent-log', { text: 'racing' }) })
          return {
            events: [
              makeEvent(5, 'agent-log', { text: 'replayed' }),
              makeEvent(6, 'task-state', { status: 'RUNNING', id: 't1', createdAt: 1, agents: {} }),
            ],
            pruned: false,
          }
        },
        subscribe: (_id: string, l: (e: unknown) => void) => {
          listener = l
          return () => {
            listener = undefined
          }
        },
      })
      const orch = fakeOrchestrator()
      orch.history = history
      const router = createApiRouter({ orchestrator: orch })
      const { req, res, chunks, ended } = streamReqRes()
      const handled = await router.handle(req, res, '/api/task/t1/stream?after=4')
      expect(handled).toBe(true)
      expect(ended()).toBe(false) // task still running → connection stays open

      const out = chunks()
      expect(out).toContain(': connected\n\n')
      // seq 6 raced into the live buffer AND came back in the durable page —
      // the merge must not duplicate it.
      expect(out.match(/data: .*"seq":6/g)?.length).toBe(1)
      expect(out).toContain('"seq":5')
      expect(out).not.toContain('"seq":4')

      // live tail after the initial replay
      listener?.({ ...makeEvent(7, 'agent-log', { text: 'live' }) })
      expect(chunks()).toContain('"seq":7')

      // long quiet period → heartbeat lines keep the connection alive
      await vi.advanceTimersByTimeAsync(15_000)
      expect(chunks()).toContain(': hb\n\n')
    } finally {
      vi.useRealTimers()
    }
  })

  it('SSE stream closes after the replay when the task is already terminal', async () => {
    vi.useFakeTimers()
    try {
      const history = makeHistory({
        getTask: async () => terminalRecord,
        getEvents: async () => ({
          events: [makeEvent(2, 'task-state', { status: 'COMPLETED', id: 't1', createdAt: 1, agents: {} })],
          pruned: false,
        }),
      })
      const orch = fakeOrchestrator()
      orch.history = history
      const router = createApiRouter({ orchestrator: orch })
      const { req, res, chunks, ended } = streamReqRes()
      await router.handle(req, res, '/api/task/t1/stream?after=0')
      expect(ended()).toBe(true)
      expect(chunks()).toContain('"status":"COMPLETED"')
      // no heartbeats after close
      await vi.advanceTimersByTimeAsync(30_000)
      expect(chunks()).not.toContain(': hb')
    } finally {
      vi.useRealTimers()
    }
  })

  it('SSE emits an explicit history-pruned signal for a stale cursor', async () => {
    const history = makeHistory({
      getTask: async () => undefined,
      getEvents: async () => ({ events: [], pruned: true }),
    })
    const orch = fakeOrchestrator()
    orch.history = history
    const router = createApiRouter({ orchestrator: orch })
    const { req, res, chunks, ended } = streamReqRes()
    await router.handle(req, res, '/api/task/t1/stream?after=1')
    expect(chunks()).toContain('event: history-pruned')
    expect(ended()).toBe(true)
  })

  it('a live terminal task-state event closes the stream after delivery', async () => {
    vi.useFakeTimers()
    try {
      let listener: ((e: unknown) => void) | undefined
      const history = makeHistory({
        getTask: async () => ({ ...terminalRecord, status: 'RUNNING' }),
        getEvents: async () => ({ events: [], pruned: false }),
        subscribe: (_id: string, l: (e: unknown) => void) => {
          listener = l
          return () => {
            listener = undefined
          }
        },
      })
      const orch = fakeOrchestrator()
      orch.history = history
      const router = createApiRouter({ orchestrator: orch })
      const { req, res, chunks, ended } = streamReqRes()
      await router.handle(req, res, '/api/task/t1/stream?after=0')
      expect(ended()).toBe(false)
      // task reaches COMPLETED live → final event delivered, then closed
      listener?.({ ...makeEvent(3, 'task-state', { status: 'COMPLETED', id: 't1', createdAt: 1, agents: {} }) })
      expect(chunks()).toContain('"status":"COMPLETED"')
      expect(ended()).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
