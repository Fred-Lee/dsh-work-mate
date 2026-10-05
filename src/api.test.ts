import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ProposalStore } from './features/proposal/store.ts'
import { ProposalServiceImpl } from './features/proposal/service.ts'
import { LifecycleServiceImpl } from './features/archive/service.ts'
import { WorktreeManager } from './features/worktree/manager.ts'
import { Router, readJsonBody } from './http.ts'
import { registerApiRoutes } from './api.ts'
import { EventLog } from './features/proposal/events.ts'

let home: string
let store: ProposalStore
let proposals: ProposalServiceImpl
let archive: ArchiveServiceImpl
let router: Router

interface StubResponse {
  status: number
  headers: Record<string, string>
  raw: string | Buffer | undefined
  body: unknown
}

function stubRes(): { res: ServerResponse; result: StubResponse } {
  const result: StubResponse = { status: 0, headers: {}, raw: undefined, body: undefined }
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      result.status = status
      result.headers = headers
    },
    end(body?: string | Buffer) {
      if (body !== undefined) result.raw = body
      return res as unknown as ServerResponse
    },
    writableEnded: false,
  }
  return { res: res as unknown as ServerResponse, result }
}

function json(result: StubResponse): unknown {
  if (typeof result.raw !== 'string') return undefined
  try {
    return JSON.parse(result.raw)
  } catch {
    return undefined
  }
}

function stubReq(method: string, url: string, body?: unknown): IncomingMessage {
  const payload = body === undefined ? '' : JSON.stringify(body)
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      if (payload !== '') yield Buffer.from(payload, 'utf8')
    },
  } as unknown as IncomingMessage
}

async function call(method: string, url: string, body?: unknown): Promise<StubResponse> {
  const { res, result } = stubRes()
  await router.handle(url, stubReq(method, url, body), res)
  result.body = json(result)
  return result
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'workmate-api-'))
  store = new ProposalStore({ homeRoot: home, subdir: 'workmate' })
  proposals = new ProposalServiceImpl(store)
  archive = new LifecycleServiceImpl({
    proposals,
    worktree: new WorktreeManager({
      subdir: 'workmate',
      basePort: 3000,
      portStep: 10,
      copyFiles: [],
      packageManager: 'pnpm',
    }),
    orchestrate: async () => ({
      ok: false,
      steps: [{ step: 'status' as const, status: 'failed' as const, summary: 'no roots (headless test)' }],
    }),
  })
  router = new Router()
  registerApiRoutes(router, { proposals, archive, openspecRoot: 'openspec', projectRoot: '', registry: undefined as never, qualitySyncEnabled: false, claudeAssetsEnabled: false })
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('proposal REST API', () => {
  it('lists, creates and reads back', async () => {
    await expect(call('GET', '/api/proposals')).resolves.toMatchObject({ status: 200, body: { proposals: [] } })

    const created = await call('POST', '/api/proposals', { id: 'p1', title: '标题' })
    expect(created.status).toBe(200)
    expect((created.body as { proposal: { id: string } }).proposal.id).toBe('p1')
    expect((created.body as { note?: string }).note).toContain('no projectRoot')

    const listed = await call('GET', '/api/proposals')
    expect((listed.body as { proposals: unknown[] }).proposals).toHaveLength(1)

    const detail = await call('GET', '/api/proposals/p1')
    expect((detail.body as { proposal: { title: string } }).proposal.title).toBe('标题')
    expect((detail.body as { projectNote?: string }).projectNote).toBeTruthy()
    // lifecycle position is server-derived (the client no longer copies the chain)
    expect((detail.body as { lifecycle: { status: string; next?: string; prev?: string } }).lifecycle).toEqual({
      status: 'draft',
      hint: '生成 OpenSpec 提案文件（proposal.md）',
      next: 'proposing',
    })
  })

  it('passes force through to the archive orchestration (empty body keeps the gate)', async () => {
    const calls: Array<{ id: string; force?: boolean }> = []
    const forcedRouter = new Router()
    registerApiRoutes(forcedRouter, {
      proposals,
      archive: {
        runArchive: async (id: string, options: { force?: boolean } = {}) => {
          calls.push({ id, ...(options.force !== undefined ? { force: options.force } : {}) })
          return { proposal: await proposals.get(id) }
        },
      } as never,
      openspecRoot: 'openspec',
      projectRoot: '',
      registry: undefined as never,
      qualitySyncEnabled: false,
      claudeAssetsEnabled: false,
    })
    await proposals.upsert({ id: 'p9', title: 't' })

    const withForce = stubRes()
    await forcedRouter.handle(
      '/api/proposals/p9/archive',
      stubReq('POST', '/api/proposals/p9/archive', { force: true }),
      withForce.res,
    )
    expect(withForce.result.status).toBe(200)

    const noBody = stubRes()
    await forcedRouter.handle('/api/proposals/p9/archive', stubReq('POST', '/api/proposals/p9/archive'), noBody.res)
    expect(noBody.result.status).toBe(200)

    expect(calls).toEqual([
      { id: 'p9', force: true },
      { id: 'p9', force: false },
    ])
  })

  it('rejects invalid creates with a readable error', async () => {
    const missing = await call('POST', '/api/proposals', { id: 'p1' })
    expect(missing.status).toBe(400)
    expect((missing.body as { error: string }).error).toBe('title is required')

    await expect(call('GET', '/api/proposals/ghost')).resolves.toMatchObject({ status: 400 })
    await expect(call('GET', '/api/ghost')).resolves.toMatchObject({ status: 404 })
  })

  it('auto-generates an id when the create body omits it (chat entry)', async () => {
    const created = await call('POST', '/api/proposals', { title: '只有标题' })
    expect(created.status).toBe(200)
    expect((created.body as { proposal: { id: string } }).proposal.id).toMatch(/^proposal-/)
  })

  it('walks the lifecycle endpoints (advance × N then archive requires archiving)', async () => {
    await call('POST', '/api/proposals', { id: 'p2', title: 't' })

    await expect(call('POST', '/api/proposals/p2/advance', {})).resolves.toMatchObject({
      body: { proposal: { status: 'proposing' } },
    })
    await expect(call('POST', '/api/proposals/p2/advance', {})).resolves.toMatchObject({
      body: { proposal: { status: 'reviewing' } },
    })
    // jump refusal
    const jump = await call('POST', '/api/proposals/p2/transition', { to: 'implementing' })
    expect(jump.status).toBe(400)
    // backward is free
    await expect(call('POST', '/api/proposals/p2/transition', { to: 'proposing' }, undefined)).resolves.toMatchObject({
      body: { proposal: { status: 'proposing' } },
    })
    // walk to ready, then implementing blocks without an associated project root
    for (const state of ['reviewing', 'ready']) {
      await call('POST', '/api/proposals/p2/advance', {})
    }
    const detail = await call('GET', '/api/proposals/p2')
    expect((detail.body as { proposal: { status: string } }).proposal.status).toBe('ready')
    const blocked = await call('POST', '/api/proposals/p2/advance', {})
    expect(blocked.status).toBe(400)
    expect((blocked.body as { error: string }).error).toContain('无法创建 worktree')
  })
})

describe('static serving', () => {
  it('exposes the pending human approval and lets the human path cross it', async () => {
    await call('POST', '/api/proposals', { id: 'p1', title: '待合并变更' })
    await proposals.setStatus('p1', 'implementing', { actor: 'agent' })

    const detail = await call('GET', '/api/proposals/p1')
    expect(detail.status).toBe(200)
    const payload = detail.body as { pendingApproval?: { gate: string; reason: string }; approvals?: unknown[] }
    expect(payload.pendingApproval?.gate).toBe('merging')
    expect(payload.pendingApproval?.reason).toContain('人工批准')
    expect(payload.approvals ?? []).toEqual([])

    // The human actor is not stopped by the approval gate (a later precondition
    // may still refuse in this headless fixture — that is a different message).
    const advanced = await call('POST', '/api/proposals/p1/advance', { rationale: '审过了' })
    expect(JSON.stringify(advanced.body)).not.toContain('需要人工批准')
  })

  it('carries intake provenance through create into the proposal record', async () => {
    const created = await call('POST', '/api/proposals', {
      id: 'fix-42',
      title: '修复 INC-42',
      source: 'incident',
      sourceRef: 'INC-42',
      relatesTo: ['p-old'],
      provenance: { capturedAt: '2026-10-05T00:00:00.000Z', untrusted: true },
    })

    expect(created.status).toBe(200)
    const proposal = (created.body as { proposal: { source: string; sourceRef: string; relatesTo: string[]; provenance: { untrusted: boolean } } }).proposal
    expect(proposal.source).toBe('incident')
    expect(proposal.sourceRef).toBe('INC-42')
    expect(proposal.relatesTo).toEqual(['p-old'])
    expect(proposal.provenance.untrusted).toBe(true)
  })

  it('rejects an unknown source with a readable error', async () => {
    const response = await call('POST', '/api/proposals', { id: 'x', title: 'x', source: 'guessed' })

    expect(response.status).toBe(400)
    expect(JSON.stringify(response.body)).toContain('unknown source')
  })

  it('serves control-band evaluations (thin history never breaches)', async () => {
    const bands = await call('GET', '/api/bands')

    expect(bands.status).toBe(200)
    const body = bands.body as { evaluations: Array<{ metric: string; status: string; tier: string }> }
    expect(body.evaluations).toHaveLength(4)
    for (const evaluation of body.evaluations) {
      expect(evaluation.status).toBe('insufficient-data')
      expect(evaluation.tier).toBe('normal')
    }
  })

  it('serves derived metrics from the event log', async () => {
    const log = new EventLog({ homeRoot: home, subdir: 'workmate' })
    const logged = new ProposalServiceImpl(store, undefined, log)
    const metricsRouter = new Router()
    registerApiRoutes(metricsRouter, {
      proposals: logged,
      archive,
      openspecRoot: 'openspec',
      projectRoot: '',
      registry: undefined as never,
      qualitySyncEnabled: false,
      claudeAssetsEnabled: false,
      events: log,
    })
    const get = async (url: string): Promise<StubResponse> => {
      const { res, result: stub } = stubRes()
      await metricsRouter.handle(url, stubReq('GET', url), res)
      stub.body = json(stub)
      return stub
    }

    await logged.upsert({ id: 'p1', title: '标题' })
    await logged.setStatus('p1', 'proposing', { actor: 'agent' })
    await log.append({
      at: new Date().toISOString(),
      proposalId: 'p1',
      kind: 'gate-failed',
      to: 'reviewing',
      actor: 'agent',
      gate: 'proposal-branch',
      reason: 'proposal branch not found',
    })

    const global = await get('/api/metrics')
    expect(global.status).toBe(200)
    const aggregate = (global.body as { metrics: { proposals: number; gateFailureRanking: unknown[]; actorShare: unknown } }).metrics
    expect(aggregate.proposals).toBe(1)
    expect(aggregate.gateFailureRanking).toEqual([{ gate: 'proposal-branch', count: 1 }])
    expect(aggregate.actorShare).toEqual({ agent: 1, human: 0, system: 0 })

    const single = await get('/api/metrics?id=p1')
    const one = (single.body as { id: string; metrics: { transitions: number; gateFailureCount: number } }).metrics
    expect(single.status).toBe(200)
    expect(one.transitions).toBe(1)
    expect(one.gateFailureCount).toBe(1)
  })

  it('serves whitelisted files and refuses traversal', async () => {
    const assets = await mkdtemp(join(tmpdir(), 'workmate-assets-'))
    try {
      await writeFile(join(assets, 'app.js'), 'console.log("ok")', 'utf8')

      const ok = stubRes()
      await router.serveStatic('/app.js', ok.res, assets)
      expect(ok.result.status).toBe(200)
      expect(ok.result.headers['content-type']).toContain('javascript')
      expect(await readFile(join(assets, 'app.js'), 'utf8')).toBe('console.log("ok")')

      const evil = stubRes()
      await router.serveStatic('/../package.json', evil.res, join(home))
      expect(evil.result.status).toBe(404)

      const missing = stubRes()
      await router.serveStatic('/nope.js', missing.res, assets)
      expect(missing.result.status).toBe(404)
    } finally {
      await rm(assets, { recursive: true, force: true })
    }
  })
})
