/**
 * Service-surface tests: the (from, to) dedupe invariant is enforced by the
 * PERSIST path (not only by the config page), and the graph health check is
 * exposed read-only without changing `loadTopology`'s return shape.
 *
 * The plugin entry is wired with a minimal fake cordis context (same pattern as
 * packages/presets/src/index.test.ts) so the real service object is exercised.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply, type TopologyService } from './index.ts'
import { emptyTopology, type ProjectTopology, type RestDependencyEdge } from './types.ts'

let dir: string
let service: TopologyService
let registeredTools: Array<{ name: string }>

function fakeContext(): Context {
  return {
    provide: (name: string, value: unknown) => {
      if (name === 'helmsman.topology') service = value as TopologyService
    },
    get: () => undefined,
    tools: { register: (tool: unknown) => registeredTools.push(tool as { name: string }) },
  } as unknown as Context
}

function edge(to: string, method: string, endpoints: string[], critical?: true): RestDependencyEdge {
  return { toServiceId: to, endpoints, method, ...(critical ? { critical: true as const } : {}) }
}

function topologyWith(deps: Record<string, RestDependencyEdge[]>): ProjectTopology {
  const t = emptyTopology('dedupe-demo')
  for (const id of ['a', 'b', 'c']) t.services[id] = { name: id, projectId: id, techStack: [], apiEndpoints: [] }
  t.restDependencies = deps
  return t
}

function fileFor(group: string): string {
  return join(dir, `${encodeURIComponent(group)}.json`)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'helmsman-topo-svc-'))
  registeredTools = []
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  apply(fakeContext(), { rootDir: dir })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('TopologyService graph health', () => {
  it('registers the existing tool surface (3 tools) and checkHealth', async () => {
    expect(registeredTools.map((t) => t.name).sort()).toEqual([
      'helmsman_topology_get_downstream',
      'helmsman_topology_list_groups',
      'helmsman_topology_scan_rest_apis',
    ])
    expect(typeof service.checkHealth).toBe('function')
  })

  it('reports cycles with members, dangling edges and isolated services', async () => {
    const t = topologyWith({ a: [edge('b', '*', [])], b: [edge('a', '*', [])], c: [edge('ghost', '*', [])] })
    await service.saveTopology(t)
    const health = await service.checkHealth('dedupe-demo')
    expect(health.cyclic).toBe(true)
    expect(health.cycles).toEqual([['a', 'b']])
    expect(health.dangling).toEqual([{ from: 'c', to: 'ghost' }])
    expect(health.isolated).toEqual([])
  })

  it('returns an empty problem list for a clean graph', async () => {
    await service.saveTopology(topologyWith({ a: [edge('b', '*', [])], b: [edge('c', '*', [])] }))
    expect(await service.checkHealth('dedupe-demo')).toEqual({ cyclic: false, cycles: [], dangling: [], isolated: [] })
  })

  it('throws for an unknown group (same contract as getDownstream)', async () => {
    await expect(service.checkHealth('nope')).rejects.toThrow(/unknown project group/)
  })
})

describe('TopologyService persist-path dedupe', () => {
  it('keeps exactly one edge per service pair', async () => {
    await service.saveTopology(
      topologyWith({
        a: [edge('b', 'GET', ['/api/x']), edge('b', '*', []), edge('b', 'GET', ['/api/x']), edge('c', '*', [])],
      }),
    )
    const loaded = await service.loadTopology('dedupe-demo')
    expect(loaded?.restDependencies['a']).toEqual([edge('b', 'GET', ['/api/x']), edge('c', '*', [])])
  })

  it('merges a detail-less add into the existing pair instead of adding a row', async () => {
    await service.saveTopology(topologyWith({ a: [edge('b', 'GET', ['/api/x'], true)] }))
    const loaded = await service.loadTopology('dedupe-demo')
    await service.saveTopology({
      ...loaded!,
      restDependencies: { a: [...loaded!.restDependencies['a']!, edge('b', '*', [])] },
    })
    const again = await service.loadTopology('dedupe-demo')
    expect(again?.restDependencies['a']).toHaveLength(1)
    expect(again?.restDependencies['a']![0]).toEqual(edge('b', 'GET', ['/api/x'], true))
  })

  it('persists a service-level edge unchanged (no GET, no placeholder path)', async () => {
    await service.saveTopology(topologyWith({ a: [edge('b', '*', [])] }))
    const loaded = await service.loadTopology('dedupe-demo')
    expect(loaded?.restDependencies['a']).toEqual([{ toServiceId: 'b', endpoints: [], method: '*' }])
  })

  it('saving the same topology twice is idempotent (byte-identical file)', async () => {
    await service.saveTopology(topologyWith({ a: [edge('b', '*', []), edge('b', 'GET', ['/api/x'])] }))
    const first = readFileSync(fileFor('dedupe-demo'), 'utf8')
    const loaded = await service.loadTopology('dedupe-demo')
    await service.saveTopology(loaded!)
    expect(readFileSync(fileFor('dedupe-demo'), 'utf8')).toBe(first)
    const reloaded = await service.loadTopology('dedupe-demo')
    expect(reloaded?.restDependencies).toEqual(loaded?.restDependencies)
  })

  it('loadTopology keeps its shape (topology only, no health field)', async () => {
    const loaded = await service.loadTopology('dedupe-demo')
    expect(loaded === null || loaded.restDependencies !== undefined).toBe(true)
  })
})

/**
 * derive-dependencies-from-calls: the read-only derivation entry point and the
 * confirmation entry point. The fixture is the real call shape from the user's
 * repos (a Feign client whose `name` is a placeholder key), because that shape is
 * what the whole feature has to work on.
 */
describe('TopologyService derive + confirm candidates', () => {
  let repoRoot: string

  function fixtureTopology(): ProjectTopology {
    const t = emptyTopology('derive-svc-demo')
    t.services['homework-server'] = {
      name: 'homework-server',
      projectId: 'homework-server',
      techStack: ['Java 17'],
      apiEndpoints: [],
      localPath: repoRoot,
    }
    t.services['internal-homework'] = {
      name: 'internal-homework',
      projectId: 'internal-homework',
      techStack: ['Java 17'],
      apiEndpoints: [{ method: 'GET', path: '/api/homework/{hwId}' }],
    }
    return t
  }

  function writeRepo(): void {
    const files: Record<string, string> = {
      'src/main/java/com/example/client/InternalBcEsClient.java': `package com.example.client;

@FeignClient(name = "\${project.feign-client-config.internal-bc-es.name}",
             url = "\${project.feign-client-config.internal-bc-es.url}",
             path = "\${project.feign-client-config.internal-bc-es.path}")
public interface InternalBcEsClient {
  @GetMapping("/es_wrong_question/list/{subjectId}")
  Result getWrongQuesList(@PathVariable Integer subjectId);
}
`,
      'src/main/java/com/example/HomeworkCaller.java': `package com.example;

public class HomeworkCaller {
  private final RestTemplate restTemplate = new RestTemplate();

  public String load(String hwId) {
    return restTemplate.getForObject("http://internal-homework:8080/api/homework/" + hwId, String.class);
  }
}
`,
      'src/main/resources/application.yml': `project:
  feign-client-config:
    internal-bc-es:
      name: internal-bc-es
      url: http://internal-bc-es:8080
      path: /api
`,
    }
    for (const [rel, content] of Object.entries(files)) {
      const full = join(repoRoot, rel)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, content)
    }
  }

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'helmsman-derive-repo-'))
    writeRepo()
  })

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true })
  })

  it('scans a service tree and derives candidates without touching the topology file', async () => {
    await service.saveTopology(fixtureTopology())
    const before = readFileSync(fileFor('derive-svc-demo'), 'utf8')

    const result = await service.deriveDependencies('derive-svc-demo')

    expect(result.group).toBe('derive-svc-demo')
    expect(result.scannedAt).toBeGreaterThan(0)
    expect(result.scanned).toEqual(['homework-server'])
    expect(result.skipped).toEqual([{ serviceId: 'internal-homework', reason: '未配置本地路径（localPath）' }])

    const toInternalHomework = result.candidates.find((c) => c.to === 'internal-homework')
    expect(toInternalHomework?.confidence).toBe('high')
    expect(toInternalHomework?.targetDeclared).toBe(true)
    expect(toInternalHomework?.endpoints).toEqual(['/api/homework/{hwId}'])
    expect(toInternalHomework?.evidence.some((e) => e.detail.includes('internal-homework:8080'))).toBe(true)

    const toBcEs = result.candidates.find((c) => c.to === 'internal-bc-es')
    expect(toBcEs?.targetDeclared).toBe(false)
    expect(toBcEs?.confidence).toBe('high')
    expect(toBcEs?.evidence.some((e) => e.kind === 'feign')).toBe(true)
    expect(toBcEs?.evidence.some((e) => e.kind === 'config' && e.file.endsWith('application.yml'))).toBe(true)

    // Read-only guarantee: the persisted bytes are untouched.
    expect(readFileSync(fileFor('derive-svc-demo'), 'utf8')).toBe(before)
  })

  it('throws for an unknown group (same contract as checkHealth)', async () => {
    await expect(service.deriveDependencies('nope')).rejects.toThrow(/unknown project group/)
    await expect(service.applyCandidates('nope', [])).rejects.toThrow(/unknown project group/)
  })

  it('confirming an already-declared pair keeps ONE row and merges the detail', async () => {
    await service.saveTopology({
      ...fixtureTopology(),
      restDependencies: { 'homework-server': [edge('internal-homework', '*', [])] },
    })

    const result = await service.applyCandidates('derive-svc-demo', [
      { from: 'homework-server', to: 'internal-homework', endpoints: ['/api/homework/{hwId}'], method: 'GET' },
    ])
    expect(result.applied).toBe(1)
    expect(result.registered).toEqual([])
    expect(result.topology.restDependencies['homework-server']).toHaveLength(1)
    expect(result.topology.restDependencies['homework-server']![0]).toEqual({
      toServiceId: 'internal-homework',
      endpoints: ['/api/homework/{hwId}'],
      method: 'GET',
    })

    // Confirming the same candidate again is idempotent (no duplicate row, no duplicate detail).
    const again = await service.applyCandidates('derive-svc-demo', [
      { from: 'homework-server', to: 'internal-homework', endpoints: ['/api/homework/{hwId}'], method: 'GET' },
    ])
    expect(again.topology.restDependencies['homework-server']).toHaveLength(1)
    expect(again.topology.restDependencies['homework-server']![0]!.endpoints).toEqual(['/api/homework/{hwId}'])
    expect((await service.loadTopology('derive-svc-demo'))!.restDependencies['homework-server']).toHaveLength(1)
  })

  it('batch confirmation leaves exactly one row per pair', async () => {
    await service.saveTopology(fixtureTopology())
    const result = await service.applyCandidates('derive-svc-demo', [
      { from: 'homework-server', to: 'internal-homework', endpoints: ['/api/homework/{hwId}'], method: 'GET' },
      { from: 'homework-server', to: 'internal-bc-es', register: true },
      { from: 'homework-server', to: 'internal-bc-es', register: true },
    ])
    expect(result.applied).toBe(3)
    expect(result.registered).toEqual(['internal-bc-es'])
    expect(result.topology.restDependencies['homework-server']).toHaveLength(2)
    expect(result.topology.restDependencies['homework-server']!.map((e) => e.toServiceId)).toEqual([
      'internal-homework',
      'internal-bc-es',
    ])
  })

  it('registering on confirm leaves NO dangling edge behind', async () => {
    await service.saveTopology(fixtureTopology())
    const withRegister = await service.applyCandidates('derive-svc-demo', [
      { from: 'homework-server', to: 'internal-bc-es', register: true },
    ])
    expect(withRegister.topology.services['internal-bc-es']).toEqual({
      name: 'internal-bc-es',
      projectId: 'internal-bc-es',
      techStack: [],
      apiEndpoints: [],
    })
    const health = await service.checkHealth('derive-svc-demo')
    expect(health.dangling).toEqual([])
    expect(health.cyclic).toBe(false)
  })

  it('confirming an undeclared target WITHOUT registering produces the dangling warning (not silently)', async () => {
    await service.saveTopology(fixtureTopology())
    const result = await service.applyCandidates('derive-svc-demo', [{ from: 'homework-server', to: 'internal-bc-es' }])
    expect(result.topology.services['internal-bc-es']).toBeUndefined()
    expect((await service.checkHealth('derive-svc-demo')).dangling).toEqual([{ from: 'homework-server', to: 'internal-bc-es' }])
  })

  it('rejects a candidate whose source is not a registered service', async () => {
    await service.saveTopology(fixtureTopology())
    await expect(service.applyCandidates('derive-svc-demo', [{ from: 'ghost', to: 'internal-homework' }])).rejects.toThrow(
      /not a registered service/,
    )
    await expect(service.applyCandidates('derive-svc-demo', [{ from: '', to: 'x' }])).rejects.toThrow(/requires both from and to/)
  })
})

describe('TopologyService declaration drift', () => {
  const GROUP = 'drift-svc-demo'

  let repoRoot: string

  /** Real source shapes so the check runs end to end (scan → compare), not on stubs. */
  function writeRepo(): void {
    const files: Record<string, string> = {
      'src/main/resources/application.yml': `internal-homework:
  base-url: http://internal-homework:8080
`,
      // Placeholder-key form, unresolved locally → the key-derived name is kept
      // and the target is NOT a registered service (the real 6-of-7 case).
      'src/main/java/com/example/client/InternalBcEsClient.java': `package com.example.client;

@FeignClient(name = "\${project.feign-client-config.internal-bc-es.name}",
             url = "\${project.feign-client-config.internal-bc-es.url}",
             path = "\${project.feign-client-config.internal-bc-es.path}")
public interface InternalBcEsClient {
  @GetMapping("/es_wrong_question/list/{subjectId}")
  Result getWrongQuesList(@PathVariable Integer subjectId);
}
`,
      // Path-only clue: no callee name, so it can only ever be a path-tier match.
      'src/client/qp.ts': `import axios from 'axios'

export async function listQp() {
  return await axios.get('/api/qp/list')
}
`,
    }
    for (const [rel, content] of Object.entries(files)) {
      const full = join(repoRoot, rel)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, content)
    }
  }

  function declarationFile(): string {
    return join(repoRoot, '.helmsman', 'dependencies.yml')
  }

  function writeDeclaration(text: string): void {
    mkdirSync(dirname(declarationFile()), { recursive: true })
    writeFileSync(declarationFile(), text)
  }

  /** Declaration: one pair the code corroborates, one it does not, one unmentioned. */
  const DECLARATION = `version: 1
service: homework-server
dependencies:
  - to: internal-homework
  - to: internal-legacy
`

  function fixture(): ProjectTopology {
    const t = emptyTopology(GROUP)
    t.services['homework-server'] = {
      name: 'homework-server',
      projectId: 'homework-server',
      techStack: ['Java 17'],
      apiEndpoints: [],
      localPath: repoRoot,
    }
    t.services['internal-homework'] = {
      name: 'internal-homework',
      projectId: 'internal-homework',
      techStack: [],
      apiEndpoints: [{ method: 'GET', path: '/api/homework/{hwId}' }],
    }
    t.services['internal-qp'] = {
      name: 'internal-qp',
      projectId: 'internal-qp',
      techStack: [],
      apiEndpoints: [{ method: 'GET', path: '/api/qp/list' }],
    }
    t.services['internal-legacy'] = { name: 'internal-legacy', projectId: 'internal-legacy', techStack: [], apiEndpoints: [] }
    return t
  }

  /** Bytes of the two files the check must never touch. */
  function snapshot(): { declaration: string | null; topology: string } {
    let declaration: string | null = null
    try {
      declaration = readFileSync(declarationFile(), 'utf8')
    } catch {
      declaration = null
    }
    return { declaration, topology: readFileSync(fileFor(GROUP), 'utf8') }
  }

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'helmsman-drift-repo-'))
    writeRepo()
  })

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true })
  })

  it('compares both sides: consistent / staleDeclared (with the caveat) / undeclared / mediumConfidence', async () => {
    writeDeclaration(DECLARATION)
    await service.saveTopology(fixture())
    const before = snapshot()

    const result = await service.checkDeclarationDrift(GROUP, 'homework-server')

    expect(result.group).toBe(GROUP)
    expect(result.service).toBe('homework-server')
    expect(result.status).toBe('ok')
    expect(result.file).toBe(declarationFile())
    expect(result.hasDrift).toBe(true)
    expect(result.scanned).toEqual(['homework-server'])

    // 两侧都有 → 一致
    expect(result.consistent.map((e) => e.to)).toEqual(['internal-homework'])
    expect(result.consistent[0]!.evidence.length).toBeGreaterThan(0)
    // 仅声明有 → 陈旧声明，措辞是「未在代码中找到证据」+ 静态扫描的保留说明
    expect(result.staleDeclared.map((e) => e.to)).toEqual(['internal-legacy'])
    expect(result.staleDeclared[0]!.reason).toContain('未在代码中找到证据')
    expect(result.staleDeclared[0]!.caveat).toContain('静态')
    expect(result.staleDeclared[0]!.action).toContain('不会代为修改声明文件')
    expect(JSON.stringify(result)).not.toContain('不存在')
    expect(JSON.stringify(result)).not.toContain('已失效')
    // 仅高置信代码有 → 未声明；目标未登记被标出
    expect(result.undeclared.map((e) => e.to)).toEqual(['internal-bc-es'])
    expect(result.undeclared[0]!.confidence).toBe('high')
    expect(result.undeclared[0]!.targetDeclared).toBe(false)
    // 仅中置信代码有 → 单列，且不进未声明
    expect(result.mediumConfidence.map((e) => e.to)).toEqual(['internal-qp'])
    expect(result.undeclared.map((e) => e.to)).not.toContain('internal-qp')
    expect(result.counts).toMatchObject({
      declared: 2,
      codeEvidence: 3,
      consistent: 1,
      staleDeclared: 1,
      undeclared: 1,
      mediumConfidence: 1,
      drift: 2,
    })

    // 只读：声明文件与拓扑文件字节不变
    expect(snapshot()).toEqual(before)
  })

  it('all-agree yields an empty drift and no warning', async () => {
    // Drop the two clues that would otherwise produce findings, so the only pair
    // left is the one both sides agree on.
    rmSync(join(repoRoot, 'src/client/qp.ts'), { force: true })
    rmSync(join(repoRoot, 'src/main/java/com/example/client/InternalBcEsClient.java'), { force: true })
    writeDeclaration(`version: 1
service: homework-server
dependencies:
  - to: internal-homework
`)
    await service.saveTopology(fixture())
    const result = await service.checkDeclarationDrift(GROUP, 'homework-server')

    expect(result.status).toBe('ok')
    expect(result.hasDrift).toBe(false)
    expect(result.staleDeclared).toEqual([])
    expect(result.undeclared).toEqual([])
    expect(result.mediumConfidence).toEqual([])
    expect(result.consistent.map((e) => e.to)).toEqual(['internal-homework'])
    expect(result.counts.drift).toBe(0)
    expect(result.message).toContain('一致')
  })

  it('a missing declaration file is the guidance state, NOT an error', async () => {
    await service.saveTopology(fixture())
    const before = snapshot()

    const result = await service.checkDeclarationDrift(GROUP, 'homework-server')

    expect(result.status).toBe('no-declaration')
    expect(result.errors).toEqual([])
    expect(result.counts.declared).toBe(0)
    expect(result.message).toContain('尚未声明依赖')
    expect(result.message).toContain('写回声明文件')
    // 全部代码证据都列出来了（高置信进未声明、中置信单列）
    expect([...result.undeclared.map((e) => e.to), ...result.mediumConfidence.map((e) => e.to)].sort()).toEqual([
      'internal-bc-es',
      'internal-homework',
      'internal-qp',
    ])
    expect(snapshot()).toEqual(before)
  })

  it('a corrupt declaration file is an explicit error, never a silent "everything undeclared"', async () => {
    writeDeclaration('version: 1\ndependencies:\n  - method: GET\n')
    await service.saveTopology(fixture())
    const before = snapshot()

    const result = await service.checkDeclarationDrift(GROUP, 'homework-server')

    expect(result.status).toBe('invalid-declaration')
    expect(result.errors.join(' ')).toContain('service')
    expect(result.undeclared).toEqual([])
    expect(result.staleDeclared).toEqual([])
    expect(result.message).toContain('未做任何比对')
    expect(snapshot()).toEqual(before)
  })

  it('reports a service without a working copy instead of guessing', async () => {
    await service.saveTopology(fixture())
    const result = await service.checkDeclarationDrift(GROUP, 'internal-qp')
    expect(result.status).toBe('no-repo-path')
    expect(result.file).toBeNull()
    expect(result.message).toContain('localPath')
  })

  it('throws for an unknown group and an unknown service (same contract as checkHealth)', async () => {
    await expect(service.checkDeclarationDrift('nope', 'anything')).rejects.toThrow(/unknown project group/)
    await service.saveTopology(fixture())
    await expect(service.checkDeclarationDrift(GROUP, 'ghost')).rejects.toThrow(/service not found/)
    await expect(service.checkDeclarationDrift(GROUP, '  ')).resolves.toMatchObject({ service: 'homework-server' })
  })
})
