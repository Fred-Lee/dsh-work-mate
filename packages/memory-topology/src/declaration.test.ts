/**
 * Repository dependency declaration (`declare-dependencies-in-repo`).
 *
 * Covers the format (parse/render round trip), the "missing file is not an error,
 * corrupt file applies nothing" contract, the import-source shape (existing
 * `ImportPreview`), the reconciliation rule (declared edges follow the file,
 * derived edges are untouched) and the undeclared-target registration path.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, type TopologyService } from './index.ts'
import { DECLARATION_RELATIVE_PATH, declarationPathFor, normalizeDeclarationEdge, parseDeclaration, readDeclaration, renderDeclaration } from './declaration.ts'
import { applyDeclaration, previewDeclaration, reconcileDeclaredEdges } from './import.ts'
import { SERVICE_LEVEL_METHOD, edgeSource, emptyTopology, normalizeTopology, type ProjectTopology, type RestDependencyEdge } from './types.ts'

const MINIMAL = `version: 1
service: homework-server
dependencies:
  - to: internal-homework
`

const DETAILED = `version: 1
service: homework-server
dependencies:
  - to: internal-homework
    method: GET
    endpoints:
      - /api/homework/{hwId}
  - to: internal-qp
    method: POST
    endpoints:
      - /qp/list
      - /qp/detail
    critical: true
`

function declared(to: string, method: string, endpoints: string[], critical?: true): RestDependencyEdge {
  return { toServiceId: to, endpoints, method, ...(critical ? { critical: true as const } : {}), source: 'declared' }
}

describe('parseDeclaration', () => {
  it('a minimal declaration yields a service-level edge (endpoints: [], method: "*")', () => {
    const parsed = parseDeclaration(MINIMAL)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.service).toBe('homework-server')
    expect(parsed.edges).toEqual([declared('internal-homework', SERVICE_LEVEL_METHOD, [])])
    expect(parsed.warnings).toEqual([])
  })

  it('a detailed declaration keeps method/endpoints/critical (method upper-cased)', () => {
    const parsed = parseDeclaration(DETAILED)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.edges).toEqual([
      declared('internal-homework', 'GET', ['/api/homework/{hwId}']),
      declared('internal-qp', 'POST', ['/qp/list', '/qp/detail'], true),
    ])
  })

  it('defaults the method to GET when detail is declared without one', () => {
    const parsed = parseDeclaration('service: s\ndependencies:\n  - to: t\n    endpoints: [/api/x]\n')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.edges).toEqual([declared('t', 'GET', ['/api/x'])])
  })

  it('collapses a repeated target into ONE edge (pair-dedupe holds for file input too)', () => {
    const parsed = parseDeclaration(
      'service: s\ndependencies:\n  - to: t\n    method: GET\n    endpoints: [/a]\n  - to: t\n    method: GET\n    endpoints: [/a, /b]\n',
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.edges).toHaveLength(1)
    expect(parsed.edges[0]).toEqual(declared('t', 'GET', ['/a', '/b']))
  })

  it('rejects a file without `service` and produces NO edges', () => {
    const parsed = parseDeclaration('version: 1\ndependencies:\n  - to: internal-homework\n')
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.errors.join(' ')).toContain('service')
    expect(parsed).not.toHaveProperty('edges')
  })

  it('rejects a dependency without `to` and applies nothing (no partial output)', () => {
    const parsed = parseDeclaration('service: s\ndependencies:\n  - to: ok-target\n  - method: GET\n    endpoints: [/api/x]\n')
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.errors).toHaveLength(1)
    expect(parsed.errors[0]).toContain('dependencies[1]')
    expect(parsed.errors[0]).toContain('to')
    expect(parsed).not.toHaveProperty('edges')
  })

  it('rejects a file that does not list dependencies (a typo must not wipe declared edges)', () => {
    const parsed = parseDeclaration('version: 1\nservice: s\ndependencis: []\n')
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.errors[0]).toContain('dependencies')
  })

  it('accepts an explicitly empty dependency list', () => {
    const parsed = parseDeclaration('version: 1\nservice: s\ndependencies: []\n')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.edges).toEqual([])
  })

  it('checks the version when present and assumes v1 when absent', () => {
    const bad = parseDeclaration('version: 2\nservice: s\ndependencies: []\n')
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.errors[0]).toContain('version')
    const legacy = parseDeclaration('service: s\ndependencies: []\n')
    expect(legacy.ok).toBe(true)
    if (!legacy.ok) return
    expect(legacy.version).toBe(1)
    expect(legacy.warnings.join(' ')).toContain('version')
  })

  it('rejects structurally wrong entries (dependencies not a list, endpoints not a list)', () => {
    expect(parseDeclaration('service: s\ndependencies: nope\n').ok).toBe(false)
    expect(parseDeclaration('service: s\ndependencies:\n  - to: t\n    endpoints: /api/x\n').ok).toBe(false)
  })

  it('reports an unparseable/garbage document instead of throwing', () => {
    const parsed = parseDeclaration('')
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.errors.length).toBeGreaterThan(0)
  })
})

describe('renderDeclaration', () => {
  it('renders the minimal form for a service-level edge (no method/endpoints lines)', () => {
    const yaml = renderDeclaration('homework-server', [declared('internal-homework', SERVICE_LEVEL_METHOD, [])])
    expect(yaml).toContain('version: 1')
    expect(yaml).toContain('service: homework-server')
    expect(yaml).toContain('- to: internal-homework')
    expect(yaml).not.toContain('method:')
    expect(yaml).not.toContain('endpoints:')
  })

  it('round-trips through the parser (parse → render → parse is lossless)', () => {
    const parsed = parseDeclaration(DETAILED)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const again = parseDeclaration(renderDeclaration(parsed.service, parsed.edges))
    expect(again.ok).toBe(true)
    if (!again.ok) return
    const key = (edges: readonly RestDependencyEdge[]) => edges.map(normalizeDeclarationEdge).sort((a, b) => a.toServiceId.localeCompare(b.toServiceId))
    expect(key(again.edges)).toEqual(key(parsed.edges))
    // and the rendered text is stable (re-rendering the re-parsed set is identical)
    expect(renderDeclaration(again.service, again.edges)).toBe(renderDeclaration(parsed.service, parsed.edges))
  })

  it('never writes derived edges into the file', () => {
    const yaml = renderDeclaration('homework-server', [
      declared('internal-homework', SERVICE_LEVEL_METHOD, []),
      { toServiceId: 'internal-legacy', endpoints: ['/api/legacy'], method: 'GET', source: 'derived' },
    ])
    expect(yaml).toContain('internal-homework')
    expect(yaml).not.toContain('internal-legacy')
    const parsed = parseDeclaration(yaml)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.edges.map((e) => e.toServiceId)).toEqual(['internal-homework'])
  })
})

describe('readDeclaration (filesystem contract)', () => {
  let repo: string

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'helmsman-decl-repo-'))
  })
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('a repository without the file is a "not declared" result, NOT an error', async () => {
    const read = await readDeclaration(repo)
    expect(read.status).toBe('missing')
    expect(read.exists).toBe(false)
    expect(read.edges).toEqual([])
    expect(read.errors).toEqual([])
    expect(read.file).toBe(declarationPathFor(repo))
    expect(read.file.endsWith(DECLARATION_RELATIVE_PATH)).toBe(true)
  })

  it('reads and parses a declaration placed in the repo', async () => {
    mkdirSync(join(repo, '.helmsman'), { recursive: true })
    writeFileSync(join(repo, '.helmsman', 'dependencies.yml'), MINIMAL)
    const read = await readDeclaration(repo)
    expect(read.status).toBe('ok')
    expect(read.service).toBe('homework-server')
    expect(read.edges).toEqual([declared('internal-homework', SERVICE_LEVEL_METHOD, [])])
  })

  it('a corrupt file reports its problems and yields NO edges', async () => {
    mkdirSync(join(repo, '.helmsman'), { recursive: true })
    writeFileSync(join(repo, '.helmsman', 'dependencies.yml'), 'version: 1\ndependencies:\n  - to: a\n  - method: GET\n')
    const read = await readDeclaration(repo)
    expect(read.status).toBe('invalid')
    expect(read.edges).toEqual([])
    expect(read.errors.join(' ')).toContain('service')
  })
})

describe('previewDeclaration (existing ImportPreview shape)', () => {
  it('produces the declaring service + the file edges, marking unregistered targets', () => {
    const preview = previewDeclaration(
      'homework-server',
      [declared('internal-homework', 'GET', ['/api/homework/{hwId}']), declared('internal-qp', SERVICE_LEVEL_METHOD, [], true)],
      { registered: ['homework-server', 'internal-homework'], file: '/repo/.helmsman/dependencies.yml' },
    )
    expect(preview.source).toBe('helmsman-declaration')
    expect(preview.declaration).toEqual({ service: 'homework-server', file: '/repo/.helmsman/dependencies.yml' })
    expect(preview.services.map((s) => s.name)).toEqual(['homework-server', 'internal-qp'])
    expect(preview.undeclaredTargets).toEqual(['internal-qp'])
    expect(preview.dependencies).toEqual([
      { from: 'homework-server', to: 'internal-homework', method: 'GET', endpoints: ['/api/homework/{hwId}'] },
      { from: 'homework-server', to: 'internal-qp', method: '*', endpoints: [], critical: true },
    ])
  })

  it('claims nothing about target registration when the group is unknown', () => {
    const preview = previewDeclaration('homework-server', [declared('ghost', SERVICE_LEVEL_METHOD, [])])
    expect(preview.undeclaredTargets).toBeUndefined()
    expect(preview.services.map((s) => s.name)).toEqual(['homework-server'])
  })
})

describe('reconcileDeclaredEdges (design D4)', () => {
  function topology(): ProjectTopology {
    const t = emptyTopology('g')
    for (const id of ['homework-server', 'internal-homework', 'internal-legacy', 'internal-ugc']) {
      t.services[id] = { name: id, projectId: id, techStack: [], apiEndpoints: [] }
    }
    t.restDependencies = {
      'homework-server': [
        declared('internal-homework', SERVICE_LEVEL_METHOD, []),
        declared('internal-ugc', SERVICE_LEVEL_METHOD, []),
        { toServiceId: 'internal-legacy', endpoints: ['/api/legacy'], method: 'GET', source: 'derived' },
      ],
    }
    return t
  }

  it('adds what the file has, removes declared edges the file dropped, keeps derived edges', () => {
    const out = reconcileDeclaredEdges(topology(), 'homework-server', [
      declared('internal-homework', 'GET', ['/api/homework/{hwId}']),
      declared('internal-qp', SERVICE_LEVEL_METHOD, []),
    ])
    const edges = out.restDependencies['homework-server']!
    expect(edges.map((e) => e.toServiceId)).toEqual(['internal-homework', 'internal-legacy', 'internal-qp'])
    // the surviving kept row absorbed the file's detail
    expect(edges.find((e) => e.toServiceId === 'internal-homework')).toEqual(declared('internal-homework', 'GET', ['/api/homework/{hwId}']))
    // the dropped declared edge is gone; the derived edge is untouched (still derived)
    expect(edges.some((e) => e.toServiceId === 'internal-ugc')).toBe(false)
    expect(edges.find((e) => e.toServiceId === 'internal-legacy')).toEqual({
      toServiceId: 'internal-legacy',
      endpoints: ['/api/legacy'],
      method: 'GET',
      source: 'derived',
    })
  })

  it('promotes a derived pair the file now declares (declared wins, detail unioned) instead of dropping it', () => {
    const out = reconcileDeclaredEdges(topology(), 'homework-server', [declared('internal-legacy', SERVICE_LEVEL_METHOD, [])])
    const edge = out.restDependencies['homework-server']!.find((e) => e.toServiceId === 'internal-legacy')!
    expect(edgeSource(edge)).toBe('declared') // a derived confirmation can never downgrade a declared pair
    expect(edge.endpoints).toEqual(['/api/legacy']) // derived detail is not lost
  })

  it('is idempotent: re-applying the same file does not change the edge set', () => {
    const file = [declared('internal-homework', 'GET', ['/api/homework/{hwId}'])]
    const once = reconcileDeclaredEdges(topology(), 'homework-server', file)
    const twice = reconcileDeclaredEdges(once, 'homework-server', file)
    expect(twice.restDependencies).toEqual(once.restDependencies)
  })

  it('never mutates the input topology', () => {
    const input = topology()
    const before = JSON.stringify(input.restDependencies)
    reconcileDeclaredEdges(input, 'homework-server', [])
    expect(JSON.stringify(input.restDependencies)).toBe(before)
  })
})

// ---------------------------------------------------------------------------
// Service surface: ingest → preview → apply (through the real persist path)
// ---------------------------------------------------------------------------

let dir: string
let repo: string
let service: TopologyService

function fakeContext(): Context {
  return {
    provide: (name: string, value: unknown) => {
      if (name === 'helmsman.topology') service = value as TopologyService
    },
    get: () => undefined,
    tools: { register: () => undefined },
  } as unknown as Context
}

function writeDeclarationFile(text: string): void {
  mkdirSync(join(repo, '.helmsman'), { recursive: true })
  writeFileSync(join(repo, '.helmsman', 'dependencies.yml'), text)
}

/** Declaring service with a working copy + existing declared/derived edges. */
function fixture(): ProjectTopology {
  const t = emptyTopology('decl-svc-demo')
  t.services['homework-server'] = {
    name: 'homework-server',
    projectId: 'homework-server',
    techStack: ['Java 17'],
    apiEndpoints: [{ method: 'GET', path: '/api/self' }],
    localPath: repo,
  }
  t.services['internal-homework'] = { name: 'internal-homework', projectId: 'internal-homework', techStack: [], apiEndpoints: [] }
  for (const id of ['internal-ugc', 'internal-legacy']) {
    t.services[id] = { name: id, projectId: id, techStack: [], apiEndpoints: [] }
  }
  t.restDependencies = {
    'homework-server': [
      declared('internal-homework', SERVICE_LEVEL_METHOD, []),
      declared('internal-ugc', SERVICE_LEVEL_METHOD, []), // declared, dropped by the file below
      { toServiceId: 'internal-legacy', endpoints: ['/api/legacy'], method: 'GET', source: 'derived' },
    ],
  }
  return t
}

const FILE = `version: 1
service: homework-server
dependencies:
  - to: internal-homework
    method: GET
    endpoints:
      - /api/homework/{hwId}
  - to: internal-qp
`

describe('TopologyService declaration ingest', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'helmsman-decl-svc-'))
    repo = mkdtempSync(join(tmpdir(), 'helmsman-decl-work-'))
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    apply(fakeContext(), { rootDir: dir })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('previews a repository declaration in the existing ImportPreview shape', async () => {
    writeDeclarationFile(FILE)
    await service.saveTopology(fixture())

    const res = await service.declarationPreview('decl-svc-demo', 'homework-server')
    expect(res.status).toBe('ok')
    expect(res.file).toBe(declarationPathFor(repo))
    expect(res.undeclaredTargets).toEqual(['internal-qp'])
    expect(res.preview?.source).toBe('helmsman-declaration')
    expect(res.preview?.dependencies).toEqual([
      { from: 'homework-server', to: 'internal-homework', method: 'GET', endpoints: ['/api/homework/{hwId}'] },
      { from: 'homework-server', to: 'internal-qp', method: '*', endpoints: [] },
    ])
    // the group does not know internal-qp yet → it is offered as registerable
    expect(res.preview?.services.map((s) => s.name)).toEqual(['homework-server', 'internal-qp'])
  })

  it('a repository without a declaration is a friendly "not declared" result (no error, no preview)', async () => {
    await service.saveTopology(fixture())
    const res = await service.declarationPreview('decl-svc-demo', 'homework-server')
    expect(res.status).toBe('missing')
    expect(res.preview).toBeNull()
    expect(res.errors).toEqual([])
    expect(res.undeclaredTargets).toEqual([])
  })

  it('a corrupt declaration reports the problems and applies nothing', async () => {
    writeDeclarationFile('service: homework-server\ndependencies:\n  - method: GET\n')
    await service.saveTopology(fixture())
    const before = JSON.stringify((await service.loadTopology('decl-svc-demo'))?.restDependencies)

    const res = await service.declarationPreview('decl-svc-demo', 'homework-server')
    expect(res.status).toBe('invalid')
    expect(res.preview).toBeNull()
    expect(res.errors.join(' ')).toContain('to')
    expect(JSON.stringify((await service.loadTopology('decl-svc-demo'))?.restDependencies)).toBe(before)
  })

  it('reports a service without a working copy instead of guessing a path', async () => {
    await service.saveTopology(fixture())
    const res = await service.declarationPreview('decl-svc-demo', 'internal-homework')
    expect(res.status).toBe('no-repo-path')
    expect(res.file).toBeNull()
    expect(res.errors.join(' ')).toContain('localPath')
  })

  it('warns when the file declares another service, and trusts the file (it is the `from`)', async () => {
    writeDeclarationFile('version: 1\nservice: other-service\ndependencies:\n  - to: internal-homework\n')
    await service.saveTopology(fixture())
    const res = await service.declarationPreview('decl-svc-demo', 'homework-server')
    expect(res.status).toBe('ok')
    expect(res.warnings.join(' ')).toContain('other-service')
    expect(res.preview?.declaration?.service).toBe('other-service')
    expect(res.preview?.dependencies).toEqual([{ from: 'other-service', to: 'internal-homework', method: '*', endpoints: [] }])
  })

  it('throws for an unknown group (same contract as checkHealth)', async () => {
    await expect(service.declarationPreview('nope', 'anything')).rejects.toThrow(/unknown project group/)
    await expect(service.declarationRender('nope', 'anything')).rejects.toThrow(/unknown project group/)
    await service.saveTopology(fixture())
    await expect(service.declarationRender('decl-svc-demo', 'ghost')).rejects.toThrow(/service not found/)
  })

  it('applying reconciles the declaring service, keeps one row per pair and registers undeclared targets', async () => {
    writeDeclarationFile(FILE)
    await service.saveTopology(fixture())
    const preview = (await service.declarationPreview('decl-svc-demo', 'homework-server')).preview!

    const applied = await service.importApply('decl-svc-demo', preview)
    const edges = applied.restDependencies['homework-server']!
    expect(edges.map((e) => e.toServiceId)).toEqual(['internal-homework', 'internal-legacy', 'internal-qp'])
    expect(edges).toHaveLength(3) // one row per pair (the file lists 2 pairs, 2 rows)
    expect(edges.find((e) => e.toServiceId === 'internal-homework')).toEqual(declared('internal-homework', 'GET', ['/api/homework/{hwId}']))
    expect(edges.find((e) => e.toServiceId === 'internal-legacy')?.source).toBe('derived')
    // undeclared target registered in the same flow → the health check reports no dangling edge
    expect(applied.services['internal-qp']).toEqual({ name: 'internal-qp', projectId: 'internal-qp', techStack: [], apiEndpoints: [] })
    const health = await service.checkHealth('decl-svc-demo')
    expect(health.dangling).toEqual([])
    expect(health.cyclic).toBe(false)
  })

  it('deleting a dependency from the file removes that declared edge on the next ingest', async () => {
    writeDeclarationFile(FILE)
    await service.saveTopology(fixture())
    await service.importApply('decl-svc-demo', (await service.declarationPreview('decl-svc-demo', 'homework-server')).preview!)
    expect((await service.loadTopology('decl-svc-demo'))!.restDependencies['homework-server']).toHaveLength(3)

    writeDeclarationFile('service: homework-server\ndependencies:\n  - to: internal-qp\n')
    const again = await service.importApply('decl-svc-demo', (await service.declarationPreview('decl-svc-demo', 'homework-server')).preview!)
    const edges = again.restDependencies['homework-server']!
    // internal-homework was dropped by the file; the derived pair survives
    expect(edges.map((e) => e.toServiceId)).toEqual(['internal-legacy', 'internal-qp'])
  })

  it('re-applying an unchanged declaration is idempotent', async () => {
    writeDeclarationFile(FILE)
    await service.saveTopology(fixture())
    const preview = (await service.declarationPreview('decl-svc-demo', 'homework-server')).preview!
    const first = await service.importApply('decl-svc-demo', preview)
    const second = await service.importApply('decl-svc-demo', preview)
    expect(second.restDependencies).toEqual(first.restDependencies)
    expect(second.services).toEqual(first.services)
  })

  it('ingest never overwrites an existing service (scanned endpoints survive)', async () => {
    writeDeclarationFile(FILE)
    await service.saveTopology(fixture())
    const applied = await service.importApply('decl-svc-demo', (await service.declarationPreview('decl-svc-demo', 'homework-server')).preview!)
    expect(applied.services['homework-server']?.apiEndpoints).toEqual([{ method: 'GET', path: '/api/self' }])
    expect(applied.services['homework-server']?.techStack).toEqual(['Java 17'])
  })

  it('importPreview supports the declaration source from raw text (no group context)', async () => {
    const ok = await service.importPreview('helmsman-declaration', MINIMAL)
    expect(ok.source).toBe('helmsman-declaration')
    expect(ok.declaration).toEqual({ service: 'homework-server' })
    expect(ok.dependencies).toEqual([{ from: 'homework-server', to: 'internal-homework', method: '*', endpoints: [] }])

    const bad = await service.importPreview('helmsman-declaration', 'dependencies:\n  - to: a\n')
    expect(bad.dependencies).toEqual([])
    expect(bad.warnings.length).toBeGreaterThan(0)
  })

  it('applying a text-only declaration preview still reconciles through importApply', async () => {
    await service.saveTopology(fixture())
    const preview = await service.importPreview('helmsman-declaration', 'service: homework-server\ndependencies:\n  - to: internal-ugc\n')
    const applied = await service.importApply('decl-svc-demo', preview)
    expect(applied.restDependencies['homework-server']!.map((e) => e.toServiceId)).toEqual(['internal-ugc', 'internal-legacy'])
  })
})

describe('TopologyService declaration write-back', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'helmsman-decl-wb-'))
    repo = mkdtempSync(join(tmpdir(), 'helmsman-decl-wb-repo-'))
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    apply(fakeContext(), { rootDir: dir })
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('renders the declared edges with the target path and a commit hint, writing nothing', async () => {
    await service.saveTopology(fixture())
    const res = await service.declarationRender('decl-svc-demo', 'homework-server')
    expect(res.file).toBe(declarationPathFor(repo))
    expect(res.declared).toBe(2)
    expect(res.derived).toBe(1)
    expect(res.hint).toContain(DECLARATION_RELATIVE_PATH)
    expect(res.content).toContain('internal-ugc')
    expect(res.content).not.toContain('internal-legacy') // derived is never frozen into the repo
    // the rendered content re-parses to exactly the service's declared edges
    const parsed = parseDeclaration(res.content)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.edges.map(normalizeDeclarationEdge)).toEqual([
      normalizeDeclarationEdge(declared('internal-homework', SERVICE_LEVEL_METHOD, [])),
      normalizeDeclarationEdge(declared('internal-ugc', SERVICE_LEVEL_METHOD, [])),
    ])
    // no git operation, no file written
    expect(await readDeclaration(repo)).toMatchObject({ status: 'missing' })
  })

  it('renders the canonical service-level form for a legacy edge without a source field', async () => {
    const t = emptyTopology('decl-svc-demo')
    t.services['a'] = { name: 'a', projectId: 'a', techStack: [], apiEndpoints: [], localPath: repo }
    t.restDependencies = { a: [{ toServiceId: 'b', endpoints: [], method: SERVICE_LEVEL_METHOD }] }
    await service.saveTopology(t)
    const res = await service.declarationRender('decl-svc-demo', 'a')
    expect(res.content).toContain('- to: b')
    expect(res.declared).toBe(1)
    expect(res.derived).toBe(0)
  })
})

describe('applyDeclaration (unit)', () => {
  it('rejects a preview that does not say which service it belongs to', () => {
    const t = emptyTopology('g')
    expect(() => applyDeclaration(t, { source: 'helmsman-declaration', services: [], dependencies: [], warnings: [] })).toThrow(/declaration\.service/)
  })

  it('normalizes a legacy (source-less) edge as declared, so it participates in reconciliation', () => {
    const t = normalizeTopology({
      projectGroupId: 'g',
      services: { a: {}, b: {} },
      restDependencies: { a: [{ toServiceId: 'b', endpoints: [], method: '*' }] },
    })
    const out = reconcileDeclaredEdges(t, 'a', [])
    expect(out.restDependencies['a']).toBeUndefined()
  })
})

/**
 * Regression (caught by the live smoke): hand-edited YAML routinely annotates
 * lines with inline comments, and the subset parser kept them as part of the
 * value — `to: internal-homework  # 主要依赖` produced the id
 * `"internal-homework      # 主要依赖"`, so the edge missed its code evidence
 * (everything looked stale) and would land a garbage id in the topology.
 */
describe('inline comments in scalars', () => {
  const parse = (yml: string) => parseDeclaration(yml) as Extract<DeclarationParseResult, { ok: true }>

  it('strips an inline comment from service, to, method and endpoint values', () => {
    const r = parse(`version: 1
service: homework-server   # the caller
dependencies:
  - to: internal-homework  # 主要依赖
    method: GET            # read side
    endpoints:
      - /qp/list           # list endpoint
`)
    expect(r.ok).toBe(true)
    expect(r.service).toBe('homework-server')
    expect(r.edges).toHaveLength(1)
    expect(r.edges[0]!.toServiceId).toBe('internal-homework')
    expect(r.edges[0]!.method).toBe('GET')
    expect(r.edges[0]!.endpoints).toEqual(['/qp/list'])
  })

  it('keeps a # without preceding whitespace (a fragment, not a comment)', () => {
    const r = parse(`version: 1
service: svc
dependencies:
  - to: internal-homework
    endpoints:
      - /spa#/route
`)
    expect(r.ok).toBe(true)
    expect(r.edges[0]!.endpoints).toEqual(['/spa#/route'])
  })
})
