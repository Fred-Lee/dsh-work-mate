import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
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
  checkHealth: async () => ({ cyclic: false, cycles: [], dangling: [], isolated: [] }),
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

  // 依赖图体检（design D3）：只读路由，转发到拓扑服务面。
  it('GET api/topology/health forwards the group and returns the health report', async () => {
    const health = { cyclic: true, cycles: [['b', 'a']], dangling: [{ from: 'c', to: 'ghost' }], isolated: ['d'] }
    const checkHealth = vi.fn(async () => health)
    const router = createApiRouter({ orchestrator: fakeOrchestrator(), topology: { ...fakeTopology, checkHealth } })
    const { res, status, body } = fakeRes()
    const handled = await router.handle(fakeReq('GET'), res, `/api/topology/health?group=${encodeURIComponent('作业服务群')}`)
    expect(handled).toBe(true)
    expect(status()).toBe(200)
    expect(checkHealth).toHaveBeenCalledWith('作业服务群')
    expect(JSON.parse(body())).toEqual({ group: '作业服务群', available: true, health })
  })

  it('health route degrades to available:false when the installed service has no checkHealth', async () => {
    const router = createApiRouter({ orchestrator: fakeOrchestrator(), topology: { ...fakeTopology, checkHealth: undefined } })
    const { res, status, body } = fakeRes()
    const handled = await router.handle(fakeReq('GET'), res, '/api/topology/health?group=g')
    expect(handled).toBe(true)
    expect(status()).toBe(200)
    expect(JSON.parse(body())).toEqual({ group: 'g', health: null, available: false })
  })

  it('health route is not mounted without the topology plugin (host answers 404)', async () => {
    const router = createApiRouter({ orchestrator: fakeOrchestrator() })
    expect(await router.handle(fakeReq('GET'), fakeRes().res, '/api/topology/health?group=g')).toBe(false)
  })

  // 推导候选（derive-dependencies-from-calls）：只读 GET + 确认 POST，语义与 health 路由一致。
  it('GET api/topology/derive forwards the group and returns the candidate result', async () => {
    const result = {
      candidates: [
        {
          from: 'homework-server',
          to: 'internal-bc-es',
          confidence: 'high' as const,
          evidence: [{ kind: 'feign', file: 'src/main/java/InternalBcEsClient.java', line: 3, detail: '@FeignClient(name = "${…internal-bc-es.name}")' }],
          endpoints: [],
          targetDeclared: false,
          alreadyDeclared: false,
          wouldCreateCycle: false,
        },
      ],
      scannedAt: 1700000000000,
      scanned: ['homework-server'],
      skipped: [{ serviceId: 'internal-homework', reason: '未配置本地路径（localPath）' }],
      ignored: [{ key: 'homework-server→oss', at: 1 }],
    }
    const deriveDependencies = vi.fn(async () => result)
    const router = createApiRouter({ orchestrator: fakeOrchestrator(), topology: { ...fakeTopology, deriveDependencies } })
    const { res, status, body } = fakeRes()
    const handled = await router.handle(fakeReq('GET'), res, `/api/topology/derive?group=${encodeURIComponent('作业服务群')}`)
    expect(handled).toBe(true)
    expect(status()).toBe(200)
    expect(deriveDependencies).toHaveBeenCalledWith('作业服务群', { scope: 'config' })
    expect(JSON.parse(body())).toEqual({ group: '作业服务群', result, available: true, ignored: result.ignored })
  })

  it('derive route degrades to available:false when the installed service has no deriveDependencies', async () => {
    const router = createApiRouter({ orchestrator: fakeOrchestrator(), topology: { ...fakeTopology, deriveDependencies: undefined } })
    const { res, status, body } = fakeRes()
    const handled = await router.handle(fakeReq('GET'), res, '/api/topology/derive?group=g')
    expect(handled).toBe(true)
    expect(status()).toBe(200)
    expect(JSON.parse(body())).toEqual({ group: 'g', result: null, available: false, ignored: [] })
  })

  it('derive route is not mounted without the topology plugin (host answers 404)', async () => {
    const router = createApiRouter({ orchestrator: fakeOrchestrator() })
    expect(await router.handle(fakeReq('GET'), fakeRes().res, '/api/topology/derive?group=g')).toBe(false)
  })

  it('POST api/topology/apply-candidates forwards the candidates and returns the persisted topology', async () => {
    const saved = { projectGroupId: 'g', name: 'g', services: {}, restDependencies: {} }
    const applyCandidates = vi.fn(async (_group: string, candidates: unknown[]) => ({
      group: 'g',
      topology: saved,
      applied: candidates.length,
      registered: ['internal-bc-es'],
    }))
    const router = createApiRouter({ orchestrator: fakeOrchestrator(), topology: { ...fakeTopology, applyCandidates } })
    const { res, status, body } = fakeRes()
    const candidates = [
      { from: 'homework-server', to: 'internal-homework', endpoints: ['/api/homework/{hwId}'], method: 'GET' },
      { from: 'homework-server', to: 'internal-bc-es', register: true },
    ]
    const handled = await router.handle(fakeReq('POST', { group: 'g', candidates }), res, '/api/topology/apply-candidates')
    expect(handled).toBe(true)
    expect(status()).toBe(200)
    expect(applyCandidates).toHaveBeenCalledWith('g', candidates)
    expect(JSON.parse(body())).toMatchObject({ available: true, applied: 2, registered: ['internal-bc-es'], topology: saved })
  })

  it('apply-candidates requires a group and degrades when the method is absent', async () => {
    const router = createApiRouter({ orchestrator: fakeOrchestrator(), topology: fakeTopology })
    const bad = fakeRes()
    await router.handle(fakeReq('POST', { candidates: [] }), bad.res, '/api/topology/apply-candidates')
    expect(bad.status()).toBe(500)
    expect(JSON.parse(bad.body()).error).toContain('group is required')

    const missing = fakeRes()
    await router.handle(fakeReq('POST', { group: 'g', candidates: [] }), missing.res, '/api/topology/apply-candidates')
    expect(JSON.parse(missing.body())).toEqual({ group: 'g', topology: null, applied: 0, registered: [], available: false })
  })

  it('apply-candidates route is not mounted without the topology plugin', async () => {
    const router = createApiRouter({ orchestrator: fakeOrchestrator() })
    expect(await router.handle(fakeReq('POST', { group: 'g' }), fakeRes().res, '/api/topology/apply-candidates')).toBe(false)
  })

  // 仓库声明抓取/回写（declare-dependencies-in-repo）：只读路由，语义与 health/derive 一致。
  it('GET api/topology/declaration forwards group + service and returns the ingest result', async () => {
    const preview = {
      source: 'helmsman-declaration',
      services: [{ name: 'homework-server', selected: true, endpoints: [] }],
      dependencies: [{ from: 'homework-server', to: 'internal-homework', method: 'GET', endpoints: ['/api/homework/{hwId}'] }],
      warnings: [],
      declaration: { service: 'homework-server', file: '/repo/.helmsman/dependencies.yml' },
      undeclaredTargets: [],
    }
    const declarationPreview = vi.fn(async () => ({
      group: '作业服务群',
      service: 'homework-server',
      file: '/repo/.helmsman/dependencies.yml',
      status: 'ok' as const,
      preview,
      errors: [],
      warnings: [],
      undeclaredTargets: [],
    }))
    const router = createApiRouter({ orchestrator: fakeOrchestrator(), topology: { ...fakeTopology, declarationPreview } })
    const { res, status, body } = fakeRes()
    const handled = await router.handle(fakeReq('GET'), res, `/api/topology/declaration?group=${encodeURIComponent('作业服务群')}&service=homework-server`)
    expect(handled).toBe(true)
    expect(status()).toBe(200)
    expect(declarationPreview).toHaveBeenCalledWith('作业服务群', 'homework-server')
    expect(JSON.parse(body())).toEqual({
      group: '作业服务群',
      service: 'homework-server',
      file: '/repo/.helmsman/dependencies.yml',
      status: 'ok',
      preview,
      errors: [],
      warnings: [],
      undeclaredTargets: [],
      available: true,
    })
  })

  it('declaration route requires a group and degrades to available:false for an older service', async () => {
    const router = createApiRouter({ orchestrator: fakeOrchestrator(), topology: fakeTopology })
    const bad = fakeRes()
    await router.handle(fakeReq('GET'), bad.res, '/api/topology/declaration?service=s')
    expect(bad.status()).toBe(500)
    expect(JSON.parse(bad.body()).error).toContain('group is required')

    const missing = fakeRes()
    await router.handle(fakeReq('GET'), missing.res, '/api/topology/declaration?group=g&service=s')
    expect(JSON.parse(missing.body())).toEqual({
      group: 'g',
      service: 's',
      file: null,
      status: 'unavailable',
      preview: null,
      errors: [],
      warnings: [],
      undeclaredTargets: [],
      available: false,
    })
  })

  it('declaration route is not mounted without the topology plugin (host answers 404)', async () => {
    const router = createApiRouter({ orchestrator: fakeOrchestrator() })
    expect(await router.handle(fakeReq('GET'), fakeRes().res, '/api/topology/declaration?group=g&service=s')).toBe(false)
  })

  it('GET api/topology/declaration/render returns the draft content + target path + hint', async () => {
    const declarationRender = vi.fn(async (_group: string, service: string) => ({
      group: 'g',
      service,
      file: '/repo/.helmsman/dependencies.yml',
      content: 'version: 1\nservice: homework-server\ndependencies:\n  - to: internal-homework\n',
      declared: 1,
      derived: 2,
      hint: '建议把内容写入 .helmsman/dependencies.yml 并随代码提交（Helmsman 不执行任何 git 操作）。',
    }))
    const router = createApiRouter({ orchestrator: fakeOrchestrator(), topology: { ...fakeTopology, declarationRender } })
    const { res, status, body } = fakeRes()
    const handled = await router.handle(fakeReq('GET'), res, '/api/topology/declaration/render?group=g&service=homework-server')
    expect(handled).toBe(true)
    expect(status()).toBe(200)
    expect(declarationRender).toHaveBeenCalledWith('g', 'homework-server')
    const data = JSON.parse(body())
    expect(data.content).toContain('- to: internal-homework')
    expect(data.declared).toBe(1)
    expect(data.derived).toBe(2)
    expect(data.hint).toContain('git')
    expect(data.available).toBe(true)
  })

  it('render route requires service and degrades when the method is absent', async () => {
    const router = createApiRouter({ orchestrator: fakeOrchestrator(), topology: fakeTopology })
    const bad = fakeRes()
    await router.handle(fakeReq('GET'), bad.res, '/api/topology/declaration/render?group=g')
    expect(bad.status()).toBe(500)
    expect(JSON.parse(bad.body()).error).toContain('service is required')

    const missing = fakeRes()
    await router.handle(fakeReq('GET'), missing.res, '/api/topology/declaration/render?group=g&service=s')
    expect(JSON.parse(missing.body())).toEqual({
      group: 'g',
      service: 's',
      file: null,
      content: '',
      declared: 0,
      derived: 0,
      hint: '',
      available: false,
    })
  })

  it('render route is not mounted without the topology plugin', async () => {
    const router = createApiRouter({ orchestrator: fakeOrchestrator() })
    expect(await router.handle(fakeReq('GET'), fakeRes().res, '/api/topology/declaration/render?group=g&service=s')).toBe(false)
  })

  // 声明漂移核对（detect-declaration-drift）：只读 GET，语义与 declaration/health 一致。
  it('GET api/topology/drift forwards group + service and returns the comparison', async () => {
    const drift = {
      service: 'homework-server',
      status: 'ok' as const,
      file: '/repo/.helmsman/dependencies.yml',
      consistent: [
        {
          from: 'homework-server',
          to: 'internal-homework',
          evidence: [
            {
              kind: 'config',
              file: 'src/main/resources/application.yml',
              line: 1,
              detail: 'internal-homework.base-url = http://internal-homework:8080',
            },
          ],
          endpoints: [],
          confidence: 'high' as const,
          targetDeclared: true,
          declared: { method: '*', endpoints: [] },
        },
      ],
      staleDeclared: [
        {
          from: 'homework-server',
          to: 'internal-legacy',
          evidence: [],
          endpoints: [],
          targetDeclared: true,
          declared: { method: '*', endpoints: [] },
          reason: '未在代码中找到证据（可能确实已删除，也可能是动态构造的调用未被识别）',
          caveat: '扫描为静态且启发式……',
          action: '请人工确认该调用是否还在……',
        },
      ],
      undeclared: [],
      mediumConfidence: [],
      counts: { declared: 2, codeEvidence: 1, consistent: 1, staleDeclared: 1, undeclared: 0, mediumConfidence: 0, drift: 1 },
      hasDrift: true,
      message: '核对完成……',
      errors: [],
      scanned: ['homework-server'],
      skipped: [],
      scannedAt: 1_700_000_000_000,
    }
    const checkDeclarationDrift = vi.fn(async () => drift)
    const router = createApiRouter({ orchestrator: fakeOrchestrator(), topology: { ...fakeTopology, checkDeclarationDrift } })

    const { res, status, body } = fakeRes()
    const handled = await router.handle(
      fakeReq('GET'),
      res,
      `/api/topology/drift?group=${encodeURIComponent('作业服务群')}&service=homework-server`,
    )

    expect(handled).toBe(true)
    expect(status()).toBe(200)
    expect(checkDeclarationDrift).toHaveBeenCalledWith('作业服务群', 'homework-server')
    expect(JSON.parse(body())).toEqual({ ...drift, group: '作业服务群', available: true })
  })

  it('drift route requires a group and a service, and degrades to available:false for an older service', async () => {
    const router = createApiRouter({ orchestrator: fakeOrchestrator(), topology: fakeTopology })
    const bad = fakeRes()
    await router.handle(fakeReq('GET'), bad.res, '/api/topology/drift?service=s')
    expect(bad.status()).toBe(500)
    expect(JSON.parse(bad.body()).error).toContain('group is required')

    const noService = fakeRes()
    await router.handle(fakeReq('GET'), noService.res, '/api/topology/drift?group=g')
    expect(noService.status()).toBe(500)
    expect(JSON.parse(noService.body()).error).toContain('service is required')

    const missing = fakeRes()
    await router.handle(fakeReq('GET'), missing.res, '/api/topology/drift?group=g&service=s')
    expect(JSON.parse(missing.body())).toEqual({
      group: 'g',
      service: 's',
      status: 'unavailable',
      file: null,
      consistent: [],
      staleDeclared: [],
      undeclared: [],
      mediumConfidence: [],
      counts: { declared: 0, codeEvidence: 0, consistent: 0, staleDeclared: 0, undeclared: 0, mediumConfidence: 0, drift: 0 },
      hasDrift: false,
      message: '',
      errors: [],
      scanned: [],
      skipped: [],
      scannedAt: 0,
      available: false,
    })
  })

  it('drift route is not mounted without the topology plugin (host answers 404)', async () => {
    const router = createApiRouter({ orchestrator: fakeOrchestrator() })
    expect(await router.handle(fakeReq('GET'), fakeRes().res, '/api/topology/drift?group=g&service=s')).toBe(false)
  })

  it('drift route surfaces a service-side failure as a 500 with the message', async () => {
    const checkDeclarationDrift = vi.fn(async () => {
      throw new Error('service not found in group: ghost')
    })
    const router = createApiRouter({ orchestrator: fakeOrchestrator(), topology: { ...fakeTopology, checkDeclarationDrift } })
    const { res, status, body } = fakeRes()
    await router.handle(fakeReq('GET'), res, '/api/topology/drift?group=g&service=ghost')
    expect(status()).toBe(500)
    expect(JSON.parse(body()).error).toContain('service not found in group: ghost')
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

// ---------------------------------------------------------------------------
// Delivery artifacts (add-artifact-delivery-endpoints)
// ---------------------------------------------------------------------------

/** Response stub that records status + headers + a string/binary body. */
function resWithHeaders(): {
  res: ServerResponse
  status: () => number
  headers: () => Record<string, string>
  out: () => string
} {
  let status = 0
  let headers: Record<string, string> = {}
  let body = ''
  const res = {
    writeHead: (code: number, h?: Record<string, string>) => {
      status = code
      headers = h ?? {}
      return res
    },
    end: (b?: unknown) => {
      body = b === undefined ? '' : Buffer.from(b as Uint8Array | string).toString()
    },
  } as unknown as ServerResponse
  return { res, status: () => status, headers: () => headers, out: () => body }
}

/**
 * Faithful in-memory stand-in for `@helmsman/artifacts`: sha256 content
 * addressing + dedupe, so route tests exercise the REAL dedupe contract
 * instead of a stub that always reports `duplicate: false`.
 */
function fakeArtifacts() {
  const blobs = new Map<string, string>()
  const files = new Map<string, string>()
  const kinds = new Map<string, string>()
  return {
    register: vi.fn(async (input: { type: string; fileName: string; bytes: Uint8Array }) => {
      const id = createHash('sha256').update(input.bytes).digest('hex')
      const duplicate = blobs.has(id)
      if (!duplicate) {
        blobs.set(id, Buffer.from(input.bytes).toString())
        files.set(id, input.fileName)
        kinds.set(id, input.type)
      }
      return { id, duplicate }
    }),
    resolve: vi.fn(async (id: string) => {
      const text = blobs.get(id)
      if (text === undefined) return null
      return {
        meta: {
          id,
          type: kinds.get(id)!,
          fileName: files.get(id)!,
          mime: 'application/octet-stream',
          size: Buffer.byteLength(text),
          createdAt: '2026-01-01T00:00:00.000Z',
          meta: {},
          producers: [],
        },
        bytes: Buffer.from(text),
      }
    }),
    list: vi.fn(async () =>
      [...blobs.keys()].map((id) => ({
        id,
        type: kinds.get(id)!,
        fileName: files.get(id)!,
        mime: 'application/octet-stream',
        size: Buffer.byteLength(blobs.get(id)!),
        createdAt: '2026-01-01T00:00:00.000Z',
        meta: {},
        producers: [],
      })),
    ),
  }
}

/** Terminal task whose single agent left a file diff (so a bundle has content). */
function terminalTaskWithDiff() {
  return {
    ...terminalRecord,
    agents: {
      claude: {
        agent: 'claude',
        state: 'completed',
        attempts: 1,
        log: '',
        diffs: [
          {
            path: 'SMOKE.md',
            status: 'added',
            additions: 1,
            deletions: 0,
            diff: '--- /dev/null\n+++ b/SMOKE.md\n@@ -0,0 +1 @@\n+helmsman smoke ok\n',
          },
        ],
      },
    },
  }
}

describe('delivery artifact routes', () => {
  it('GET api/artifacts reports unavailable when the registry is absent', async () => {
    const router = createApiRouter({ orchestrator: fakeOrchestrator() })
    const { res, body } = fakeRes()
    await router.handle(fakeReq('GET'), res, '/api/artifacts')
    expect(JSON.parse(body())).toEqual({ artifacts: [], available: false })
  })

  it('GET api/artifacts lists registered artifacts', async () => {
    const artifacts = fakeArtifacts()
    await artifacts.register({ type: 'draft', fileName: 'a.md', bytes: Buffer.from('one') })
    const router = createApiRouter({ orchestrator: fakeOrchestrator(), artifacts: () => artifacts })
    const { res, body } = fakeRes()
    await router.handle(fakeReq('GET'), res, '/api/artifacts')
    const data = JSON.parse(body())
    expect(data.available).toBe(true)
    expect(data.artifacts).toHaveLength(1)
    expect(data.artifacts[0].fileName).toBe('a.md')
  })

  it('GET api/artifacts/:id serves bytes with a CJK-safe disposition', async () => {
    const artifacts = fakeArtifacts()
    const { id } = await artifacts.register({
      type: 'topology',
      fileName: 'topology-作业服务.yaml',
      bytes: Buffer.from('projectGroup:\n  name: x\n'),
    })
    const router = createApiRouter({ orchestrator: fakeOrchestrator(), artifacts: () => artifacts })
    const { res, status, headers, out } = resWithHeaders()
    await router.handle(fakeReq('GET'), res, `/api/artifacts/${id}`)
    expect(status()).toBe(200)
    expect(headers()['content-type']).toBe('application/yaml')
    // ASCII fallback stays ASCII-only; the real name rides in RFC 5987 filename*.
    expect(headers()['content-disposition']).toContain('filename*')
    expect(headers()['content-disposition']).toContain(encodeURIComponent('作业服务'))
    expect(out()).toContain('projectGroup')
  })

  it('GET api/artifacts/:id returns 404 for an unknown id', async () => {
    const router = createApiRouter({ orchestrator: fakeOrchestrator(), artifacts: () => fakeArtifacts() })
    const { res, status, out } = resWithHeaders()
    await router.handle(fakeReq('GET'), res, '/api/artifacts/deadbeef')
    expect(status()).toBe(404)
    expect(out()).toContain('not found')
  })

  it('POST api/task/:id/bundle registers a patch + companion json', async () => {
    const artifacts = fakeArtifacts()
    const orchestrator = { ...fakeOrchestrator(), getTaskStatus: () => terminalTaskWithDiff() }
    const router = createApiRouter({ orchestrator, artifacts: () => artifacts })
    const { res, status, body } = fakeRes()
    await router.handle(fakeReq('POST', {}), res, '/api/task/t1/bundle')
    expect(status()).toBe(200)
    const data = JSON.parse(body())
    expect(data.patch.fileName).toBe('t1.bundle.patch')
    expect(data.bundle.fileName).toBe('t1.bundle.json')
    // git-applyable patch carries the agent diff; companion json carries metadata.
    const patch = await artifacts.resolve(data.patch.id)
    expect(patch!.bytes.toString()).toContain('helmsman smoke ok')
    const manifest = JSON.parse((await artifacts.resolve(data.bundle.id))!.bytes.toString())
    expect(manifest.taskId).toBe('t1')
    expect(manifest.baseSha).toBeNull()
    expect(manifest.agents[0].files[0].path).toBe('SMOKE.md')
  })

  it('re-requesting a task bundle dedupes to the SAME artifact ids (regression)', async () => {
    const artifacts = fakeArtifacts()
    const orchestrator = { ...fakeOrchestrator(), getTaskStatus: () => terminalTaskWithDiff() }
    const router = createApiRouter({ orchestrator, artifacts: () => artifacts })
    const first = fakeRes()
    await router.handle(fakeReq('POST', {}), first.res, '/api/task/t1/bundle')
    const second = fakeRes()
    await router.handle(fakeReq('POST', {}), second.res, '/api/task/t1/bundle')
    const a = JSON.parse(first.body())
    const b = JSON.parse(second.body())
    // Bundle content must be a pure function of task state — no per-request
    // timestamp — otherwise content addressing can never dedupe.
    expect(b.patch.id).toBe(a.patch.id)
    expect(b.bundle.id).toBe(a.bundle.id)
    expect(a.patch.duplicate).toBe(false)
    expect(b.patch.duplicate).toBe(true)
    expect(b.bundle.duplicate).toBe(true)
    // Both requests land on the same two stored blobs — no accumulation.
    expect((await artifacts.list()).length).toBe(2)
  })

  it('POST api/task/:id/bundle rejects a non-terminal task', async () => {
    const orchestrator = {
      ...fakeOrchestrator(),
      getTaskStatus: () => ({ ...terminalRecord, status: 'RUNNING' }),
    }
    const router = createApiRouter({ orchestrator, artifacts: () => fakeArtifacts() })
    const { res, status, body } = fakeRes()
    await router.handle(fakeReq('POST', {}), res, '/api/task/t1/bundle')
    // Route errors surface as a 500 JSON envelope, not a rejected handler.
    expect(status()).toBe(500)
    expect(body()).toMatch(/terminal/i)
  })

  it('GET api/topology/export registers the YAML and returns artifact metadata', async () => {
    const artifacts = fakeArtifacts()
    const router = createApiRouter({
      orchestrator: fakeOrchestrator(),
      topology: fakeTopology,
      artifacts: () => artifacts,
    })
    const { res, status, body } = fakeRes()
    await router.handle(fakeReq('GET'), res, '/api/topology/export?group=' + encodeURIComponent('订单中台'))
    expect(status()).toBe(200)
    const data = JSON.parse(body())
    expect(data.fileName).toBe('helmsman-topology-订单中台.yaml')
    expect(data.mime).toBe('application/yaml')
    const stored = await artifacts.resolve(data.artifactId)
    expect(stored!.meta.fileName).toBe('helmsman-topology-订单中台.yaml')
    expect(stored!.bytes.toString()).toContain('projectGroup')
  })
})
