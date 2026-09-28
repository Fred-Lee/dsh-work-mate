import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ProposalStore } from './features/proposal/store.ts'
import { ProposalServiceImpl } from './features/proposal/service.ts'
import { ArchiveServiceImpl } from './features/archive/service.ts'
import { Router, readJsonBody } from './http.ts'
import { registerApiRoutes } from './api.ts'

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
  archive = new ArchiveServiceImpl({ proposals })
  router = new Router()
  registerApiRoutes(router, { proposals, archive, openspecRoot: 'openspec', projectRoot: '' })
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
  })

  it('rejects invalid creates with a readable error', async () => {
    const missing = await call('POST', '/api/proposals', { title: '无 id' })
    expect(missing.status).toBe(400)

    await expect(call('GET', '/api/proposals/ghost')).resolves.toMatchObject({ status: 400 })
    await expect(call('GET', '/api/ghost')).resolves.toMatchObject({ status: 404 })
  })

  it('walks the lifecycle endpoints (start then archive)', async () => {
    await call('POST', '/api/proposals', { id: 'p2', title: 't' })

    const early = await call('POST', '/api/proposals/p2/archive', {})
    expect(early.status).toBe(400)

    await expect(call('POST', '/api/proposals/p2/start', {})).resolves.toMatchObject({
      body: { proposal: { status: 'executing' } },
    })
    await expect(call('POST', '/api/proposals/p2/archive', {})).resolves.toMatchObject({
      body: { proposal: { status: 'archived' } },
    })
  })
})

describe('static serving', () => {
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
