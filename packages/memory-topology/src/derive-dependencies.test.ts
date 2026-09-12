import { describe, expect, it, vi } from 'vitest'
import { checkGraph } from './graph-health.ts'
import { candidateToEdge, deriveDependencies, matchEndpoint, wouldCreateCycle, type DependencyCandidate } from './derive-dependencies.ts'
import type { OutboundCall } from './scan-outbound.ts'
import { emptyTopology, type ProjectTopology, type RestDependencyEdge } from './types.ts'

const HOMEWORK_CLIENT_PATH = '/tmp/homework-server'
const INTERNAL_PATH = '/tmp/internal-homework'
const QP_PATH = '/tmp/internal-qp'

function topologyWithServices(): ProjectTopology {
  const t = emptyTopology('derive-demo')
  t.services['homework-server'] = {
    name: 'homework-server',
    projectId: 'homework-server',
    techStack: [],
    apiEndpoints: [],
    localPath: HOMEWORK_CLIENT_PATH,
  }
  t.services['internal-homework'] = {
    name: 'internal-homework',
    projectId: 'internal-homework',
    techStack: [],
    apiEndpoints: [
      { method: 'POST', path: '/api/homework/create' },
      { method: 'GET', path: '/api/homework/{hwId}' },
    ],
    localPath: INTERNAL_PATH,
  }
  t.services['internal-qp'] = {
    name: 'internal-qp',
    projectId: 'internal-qp',
    techStack: [],
    apiEndpoints: [{ method: 'GET', path: '/api/qp/list' }],
    localPath: QP_PATH,
  }
  return t
}

function clue(partial: Partial<OutboundCall> & Pick<OutboundCall, 'evidence'>): OutboundCall {
  return { path: '', ...partial }
}

/** Derivation with an injected scanner — no filesystem access needed. */
function deriveWith(cluesByPath: Record<string, OutboundCall[]>, topology: ProjectTopology, now = 1_700_000_000_000) {
  const scanOutbound = vi.fn(async (localPath: string) => cluesByPath[localPath] ?? [])
  return deriveDependencies(topology, { scanOutbound, now: () => now })
}

function candidateFor(candidates: DependencyCandidate[], from: string, to: string): DependencyCandidate | undefined {
  return candidates.find((c) => c.from === from && c.to === to)
}

describe('deriveDependencies — name tier (high)', () => {
  it('derives a service-level candidate from a config clue, with the clue as evidence', async () => {
    const topology = topologyWithServices()
    const result = await deriveWith(
      {
        [HOMEWORK_CLIENT_PATH]: [
          clue({
            target: 'internal-homework',
            configKey: 'internal-homework.base-url',
            baseUrl: 'http://internal-homework:8080',
            detail: 'internal-homework.base-url = http://internal-homework:8080',
            evidence: { file: 'src/main/resources/application.yml', line: 8, kind: 'config' },
          }),
        ],
      },
      topology,
    )

    expect(result.scannedAt).toBe(1_700_000_000_000)
    expect(result.scanned).toEqual([HOMEWORK_CLIENT_PATH === INTERNAL_PATH ? '' : 'homework-server', 'internal-homework', 'internal-qp'].filter(Boolean))
    const candidate = candidateFor(result.candidates, 'homework-server', 'internal-homework')!
    expect(candidate.confidence).toBe('high')
    expect(candidate.targetDeclared).toBe(true)
    expect(candidate.endpoints).toEqual([])
    expect(candidate.method).toBeUndefined()
    expect(candidate.evidence).toEqual([
      {
        kind: 'config',
        file: 'src/main/resources/application.yml',
        line: 8,
        detail: 'internal-homework.base-url = http://internal-homework:8080',
      },
    ])
    expect(candidate.wouldCreateCycle).toBe(false)
  })

  it('keeps an undeclared target as a candidate (targetDeclared: false)', async () => {
    const result = await deriveWith(
      {
        [HOMEWORK_CLIENT_PATH]: [
          clue({
            target: 'internal-bc-es',
            configKey: 'project.feign-client-config.internal-bc-es.name',
            detail: '@FeignClient(name = "${project.feign-client-config.internal-bc-es.name}")',
            evidence: { file: 'src/main/java/InternalBcEsClient.java', line: 3, kind: 'feign' },
          }),
        ],
      },
      topologyWithServices(),
    )

    const candidate = candidateFor(result.candidates, 'homework-server', 'internal-bc-es')!
    expect(candidate).toBeDefined()
    expect(candidate.targetDeclared).toBe(false)
    expect(candidate.confidence).toBe('high')
    expect(candidate.alreadyDeclared).toBe(false)
    expect(candidate.evidence).toHaveLength(1)
  })

  it('matches a declared service by its display name as well as by its id', async () => {
    const topology = topologyWithServices()
    topology.services['internal-homework']!.name = 'internal-homework-service'
    const result = await deriveWith(
      {
        [HOMEWORK_CLIENT_PATH]: [
          clue({ target: 'internal-homework-service', evidence: { file: 'a.yml', line: 1, kind: 'config' } }),
        ],
      },
      topology,
    )
    expect(candidateFor(result.candidates, 'homework-server', 'internal-homework')?.targetDeclared).toBe(true)
  })
})

describe('deriveDependencies — path tier (medium)', () => {
  it('carries the matched endpoint as detail and normalises segment placeholders', async () => {
    const result = await deriveWith(
      {
        [HOMEWORK_CLIENT_PATH]: [
          clue({
            path: '/api/homework/{id}',
            method: 'GET',
            detail: 'axios.get(…) /api/homework/{id}',
            evidence: { file: 'src/client/homework.ts', line: 12, kind: 'call' },
          }),
        ],
      },
      topologyWithServices(),
    )

    const candidate = candidateFor(result.candidates, 'homework-server', 'internal-homework')!
    expect(candidate.confidence).toBe('medium')
    expect(candidate.endpoints).toEqual(['/api/homework/{hwId}'])
    expect(candidate.method).toBe('GET')
    expect(candidate.evidence[0]!.kind).toBe('endpoint')
    expect(candidate.evidence[0]!.detail).toContain('/api/homework/{id} ↔ GET /api/homework/{hwId}')
    expect(candidate.evidence[0]!.note).toBe('按段形状归一化匹配')
  })

  it('keeps the 「前缀未解析」 note visible on the path evidence', async () => {
    const result = await deriveWith(
      {
        [HOMEWORK_CLIENT_PATH]: [
          clue({
            path: '/api/qp/list',
            method: 'GET',
            prefixUnresolved: true,
            note: '前缀未解析（path 占位符未在本地配置中解析，仅按方法级路径匹配）',
            evidence: { file: 'src/java/QpClient.java', line: 9, kind: 'feign' },
          }),
        ],
      },
      topologyWithServices(),
    )
    const candidate = candidateFor(result.candidates, 'homework-server', 'internal-qp')!
    expect(candidate.evidence[0]!.note).toContain('前缀未解析')
  })

  it('reaches a controller-relative path through a shape suffix match', async () => {
    const topology = topologyWithServices()
    topology.services['internal-qp']!.apiEndpoints = [{ method: 'GET', path: '/api/v1/qp/list' }]
    const result = await deriveWith(
      {
        [HOMEWORK_CLIENT_PATH]: [clue({ path: '/qp/list', evidence: { file: 'a.ts', line: 2, kind: 'call' } })],
      },
      topology,
    )
    const candidate = candidateFor(result.candidates, 'homework-server', 'internal-qp')!
    expect(candidate.endpoints).toEqual(['/api/v1/qp/list'])
    expect(candidate.evidence[0]!.note).toBe('按路径后缀匹配')
  })

  it('prefers exact > shape > suffix > loose, and breaks ties by HTTP method', () => {
    const shape = [
      { method: 'GET', path: '/api/homework/{hwId}' },
      { method: 'POST', path: '/api/homework/create' },
    ]
    // `{id}` must match the same-shape `{hwId}`, not the concrete `create`.
    expect(matchEndpoint('/api/homework/{id}', shape)).toEqual({
      endpoint: shape[0],
      rank: 2,
      note: '按段形状归一化匹配',
    })
    // A literal path is an exact match.
    expect(matchEndpoint('/api/homework/create', shape)).toEqual({ endpoint: shape[1], rank: 1 })
    // Method agreement wins inside the same rank.
    expect(
      matchEndpoint(
        '/api/homework/{id}',
        [
          { method: 'POST', path: '/api/homework/x' },
          { method: 'GET', path: '/api/homework/y' },
        ],
        'GET',
      )?.endpoint.path,
    ).toBe('/api/homework/y')
    // Prefix-relative suffix match.
    expect(matchEndpoint('/qp/list', [{ method: 'GET', path: '/api/v1/qp/list' }])?.rank).toBe(3)
    // Concrete id against a placeholder segment (same length).
    expect(matchEndpoint('/api/users/123/orders', [{ method: 'GET', path: '/api/users/{id}/orders' }])?.rank).toBe(4)
    // A single-segment path is never shape/suffix matched (too loose).
    expect(matchEndpoint('/health', [{ method: 'GET', path: '/{anything}' }])).toBeNull()
    // Same-length paths with a real difference never match.
    expect(matchEndpoint('/api/homework/{hwId}', [{ method: 'GET', path: '/api/homework/{hwId}/detail' }])).toBeNull()
  })

  it('ignores non-HTTP endpoint markers (imported TCP ports)', () => {
    expect(matchEndpoint('/api/users', [{ method: 'TCP', path: '/api/users' }])).toBeNull()
  })
})

describe('deriveDependencies — merge, self-edges and evidence rules', () => {
  it('merges every clue of the same pair into ONE candidate (evidence union, higher tier)', async () => {
    const result = await deriveWith(
      {
        [HOMEWORK_CLIENT_PATH]: [
          clue({
            target: 'internal-homework',
            detail: 'internal-homework.base-url = http://internal-homework:8080',
            evidence: { file: 'src/main/resources/application.yml', line: 8, kind: 'config' },
          }),
          clue({
            path: '/api/homework/{id}',
            detail: 'axios.get(…) /api/homework/{id}',
            evidence: { file: 'src/client/homework.ts', line: 12, kind: 'call' },
          }),
          clue({
            path: '/api/homework/create',
            detail: 'axios.post(…) /api/homework/create',
            evidence: { file: 'src/client/homework.ts', line: 20, kind: 'call' },
          }),
          // duplicate evidence must not be listed twice
          clue({
            path: '/api/homework/create',
            detail: 'axios.post(…) /api/homework/create',
            evidence: { file: 'src/client/homework.ts', line: 20, kind: 'call' },
          }),
        ],
      },
      topologyWithServices(),
    )

    const candidates = result.candidates.filter((c) => c.from === 'homework-server' && c.to === 'internal-homework')
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.confidence).toBe('high')
    expect(candidates[0]!.evidence).toHaveLength(3)
    // A topology edge stores ONE method per pair, so the detail keeps the paths
    // whose declared method equals the dominant one (the GET match); the POST
    // match is still visible as evidence.
    expect(candidates[0]!.endpoints).toEqual(['/api/homework/{hwId}'])
    expect(candidates[0]!.method).toBe('GET')
    expect(candidates[0]!.evidence.some((e) => e.detail.includes('POST /api/homework/create'))).toBe(true)
  })

  it('drops self-edges (a service naming or matching itself)', async () => {
    const result = await deriveWith(
      {
        [HOMEWORK_CLIENT_PATH]: [
          clue({
            target: 'homework-server',
            detail: 'homework-server.base-url = http://homework-server:8080',
            evidence: { file: 'application.yml', line: 3, kind: 'config' },
          }),
        ],
        [INTERNAL_PATH]: [
          clue({ target: 'internal-homework', evidence: { file: 'x.yml', line: 1, kind: 'config' } }),
          clue({ path: '/api/homework/{hwId}', evidence: { file: 'y.ts', line: 1, kind: 'call' } }),
        ],
      },
      topologyWithServices(),
    )
    expect(result.candidates.some((c) => c.from === c.to)).toBe(false)
    expect(result.candidates.some((c) => c.from === 'homework-server')).toBe(false)
    expect(result.candidates.some((c) => c.from === 'internal-homework')).toBe(false)
  })

  it('emits nothing without evidence (unmatched path, bare clue)', async () => {
    const result = await deriveWith(
      {
        [HOMEWORK_CLIENT_PATH]: [
          clue({ path: '/nowhere/at/all', evidence: { file: 'a.ts', line: 1, kind: 'call' } }),
          clue({ evidence: { file: 'b.ts', line: 2, kind: 'call' } }),
        ],
      },
      topologyWithServices(),
    )
    expect(result.candidates).toEqual([])
  })
})

describe('deriveDependencies — cycle flagging', () => {
  function withEdge(topology: ProjectTopology, from: string, to: string): ProjectTopology {
    const edge: RestDependencyEdge = { toServiceId: to, endpoints: [], method: '*' }
    topology.restDependencies[from] = [...(topology.restDependencies[from] ?? []), edge]
    return topology
  }

  it('flags a candidate that would close a cycle and agrees with checkGraph', async () => {
    const topology = withEdge(topologyWithServices(), 'homework-server', 'internal-homework')
    const result = await deriveWith(
      {
        [INTERNAL_PATH]: [
          clue({
            target: 'homework-server',
            detail: 'homework-server.host = homework-server.default.svc.cluster.local',
            evidence: { file: 'application.yml', line: 10, kind: 'config' },
          }),
        ],
      },
      topology,
    )

    const candidate = candidateFor(result.candidates, 'internal-homework', 'homework-server')!
    expect(candidate.wouldCreateCycle).toBe(true)
    expect(candidate.targetDeclared).toBe(true)

    // Agreement check: adding the edge really does create the cycle checkGraph reports.
    const augmented: ProjectTopology = {
      ...topology,
      restDependencies: {
        ...topology.restDependencies,
        [candidate.from]: [
          ...(topology.restDependencies[candidate.from] ?? []),
          candidateToEdge(candidate),
        ],
      },
    }
    expect(checkGraph(augmented).cyclic).toBe(true)
    expect(checkGraph(augmented).cycles).toEqual([['homework-server', 'internal-homework']])
  })

  it('does not flag a candidate that is already declared, and reports it as declared', async () => {
    const topology = withEdge(topologyWithServices(), 'homework-server', 'internal-homework')
    expect(wouldCreateCycle(topology, 'homework-server', 'internal-homework')).toBe(false)
    expect(wouldCreateCycle(topology, 'internal-homework', 'homework-server')).toBe(true)
    const result = await deriveWith(
      {
        [HOMEWORK_CLIENT_PATH]: [
          clue({
            target: 'internal-homework',
            evidence: { file: 'application.yml', line: 8, kind: 'config' },
          }),
        ],
      },
      topology,
    )
    const candidate = candidateFor(result.candidates, 'homework-server', 'internal-homework')!
    expect(candidate.alreadyDeclared).toBe(true)
    expect(candidate.wouldCreateCycle).toBe(false)
  })

  it('ignores an empty pair', () => {
    expect(wouldCreateCycle(topologyWithServices(), '', 'internal-qp')).toBe(false)
    expect(wouldCreateCycle(topologyWithServices(), 'a', 'a')).toBe(true)
  })
})

describe('deriveDependencies — scan bookkeeping', () => {
  it('reports services it could not scan instead of failing the whole derivation', async () => {
    const topology = topologyWithServices()
    delete topology.services['internal-qp']!.localPath
    const result = await deriveWith({ [HOMEWORK_CLIENT_PATH]: [] }, topology)
    expect(result.scanned).toEqual(['homework-server', 'internal-homework'])
    expect(result.skipped).toEqual([{ serviceId: 'internal-qp', reason: '未配置本地路径（localPath）' }])
  })

  it('surfaces a scan failure as a skip reason (unreadable path)', async () => {
    const result = await deriveDependencies(topologyWithServices(), {
      scanOutbound: async (localPath: string) => {
        if (localPath === INTERNAL_PATH) throw new Error('ENOENT: no such file or directory')
        return []
      },
    })
    expect(result.scanned).toEqual(['homework-server', 'internal-qp'])
    expect(result.skipped).toEqual([{ serviceId: 'internal-homework', reason: 'ENOENT: no such file or directory' }])
  })

  it('scans only the requested services', async () => {
    const result = await deriveDependencies(topologyWithServices(), {
      serviceIds: ['homework-server'],
      scanOutbound: async () => [],
    })
    expect(result.scanned).toEqual(['homework-server'])
    expect(result.skipped).toEqual([])
  })

  it('candidateToEdge keeps a detail-less candidate at service level', () => {
    expect(candidateToEdge({ to: 'x', endpoints: [] })).toEqual({ toServiceId: 'x', endpoints: [], method: '*' })
    expect(candidateToEdge({ to: 'x', endpoints: ['/a'], method: 'POST' })).toEqual({ toServiceId: 'x', endpoints: ['/a'], method: 'POST' })
  })
})
