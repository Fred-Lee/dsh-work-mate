import { describe, expect, it, vi } from 'vitest'
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
    cancelTask: vi.fn(),
    retryTask: vi.fn(async () => ({ taskId: 't1' })),
    getTaskStatus: () => undefined,
    listTasks: () => [],
    mergeTask: vi.fn(async () => ({ taskId: 't1', results: [] })),
    discardTask: vi.fn(async () => undefined),
    getUsage: () => ({ claude: { runs: 1, promptChars: 10, outputChars: 20, estimatedTokens: 8 } }),
  }
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
    await router.handle(fakeReq('POST'), r.res, '/api/task/t1/cancel')
    expect(orch.cancelTask).toHaveBeenCalledWith('t1')
    r = fakeRes()
    await router.handle(fakeReq('POST', { agents: ['claude'] }), r.res, '/api/task/t1/retry')
    expect(orch.retryTask).toHaveBeenCalledWith('t1', ['claude'])
    r = fakeRes()
    await router.handle(fakeReq('POST', { agents: ['claude'], files: ['a.ts'] }), r.res, '/api/task/t1/merge')
    expect(orch.mergeTask).toHaveBeenCalledWith({ taskId: 't1', agents: ['claude'], files: ['a.ts'] })
    r = fakeRes()
    await router.handle(fakeReq('POST'), r.res, '/api/task/t1/discard')
    expect(orch.discardTask).toHaveBeenCalledWith('t1')
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
