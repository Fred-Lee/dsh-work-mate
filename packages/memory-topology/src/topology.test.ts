import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SERVICE_LEVEL_METHOD,
  dedupeDependencies,
  emptyTopology,
  isServiceLevelEdge,
  mergeDependencyEdge,
  normalizeTopology,
  type RestDependencyEdge,
} from './types.ts'
import { TopologyStore } from './store.ts'
import { applyPreview, previewCompose, previewKubernetes } from './import.ts'

function edge(to: string, method: string, endpoints: string[], critical?: true): RestDependencyEdge {
  return { toServiceId: to, endpoints, method, ...(critical ? { critical: true as const } : {}) }
}

describe('normalizeTopology', () => {
  it('fills defaults and drops malformed parts', () => {
    const t = normalizeTopology({ projectGroupId: 'g1', services: { s1: { name: 42 }, bad: 'nope' } })
    expect(t.projectGroupId).toBe('g1')
    expect(t.services['s1']?.name).toBe('42')
    expect(t.services['bad']).toBeUndefined()
    expect(t.defaultBranch).toBe('main')
  })
})

// 服务级依赖边（design D1）：端点明细可选。归一化**不得**把空明细"修好"成
// GET / 占位路径，否则整条变更失效 —— 这是首要验收点。
describe('service-level dependency edges (endpoint detail optional)', () => {
  const serviceLevel = { toServiceId: 'order-service', endpoints: [], method: SERVICE_LEVEL_METHOD }

  it('preserves the service-level shape through normalization', () => {
    const t = normalizeTopology({
      projectGroupId: 'g1',
      services: { 'user-service': {}, 'order-service': {} },
      restDependencies: { 'user-service': [serviceLevel] },
    })
    expect(t.restDependencies['user-service']).toEqual([serviceLevel])
    expect(t.restDependencies['user-service']![0]!.endpoints).toHaveLength(0)
    expect(t.restDependencies['user-service']![0]!.method).toBe('*')
    expect(t.restDependencies['user-service']![0]!.method).not.toBe('GET')
  })

  it('round-trips a service-level edge unchanged (save → load → save)', () => {
    const once = normalizeTopology({ services: { a: {}, b: {} }, restDependencies: { a: [serviceLevel] } })
    const twice = normalizeTopology(once)
    expect(twice.restDependencies).toEqual(once.restDependencies)
  })

  it('leaves edges that carry details untouched', () => {
    const t = normalizeTopology({
      restDependencies: { a: [edge('b', 'POST', ['/api/orders'], true)] },
    })
    expect(t.restDependencies['a']).toEqual([{ toServiceId: 'b', endpoints: ['/api/orders'], method: 'POST', critical: true }])
  })

  it('treats an edge with no method and no endpoints as service-level (never a phantom GET)', () => {
    const t = normalizeTopology({ restDependencies: { a: [{ toServiceId: 'b' }] } })
    expect(t.restDependencies['a']).toEqual([{ toServiceId: 'b', endpoints: [], method: SERVICE_LEVEL_METHOD }])
  })

  it('isServiceLevelEdge keys off the absence of detail, not the method value', () => {
    expect(SERVICE_LEVEL_METHOD).toBe('*')
    expect(isServiceLevelEdge({ endpoints: [] })).toBe(true)
    expect(isServiceLevelEdge({ endpoints: ['/api/x'] })).toBe(false)
    // importer edges (DEPENDS_ON, k8s TCP) carry no detail either → they degrade too
    expect(isServiceLevelEdge(edge('b', 'DEPENDS_ON', []))).toBe(true)
  })
})

describe('mergeDependencyEdge (one edge per service pair)', () => {
  it('merges details into the existing pair, deduping (method, endpoint)', () => {
    expect(mergeDependencyEdge(edge('b', 'GET', ['/api/x']), edge('b', 'GET', ['/api/x', '/api/y']))).toEqual(
      edge('b', 'GET', ['/api/x', '/api/y']),
    )
  })

  it('a detail-less add produces no second row and no detail', () => {
    expect(mergeDependencyEdge(edge('b', 'GET', ['/api/x']), edge('b', '*', []))).toEqual(edge('b', 'GET', ['/api/x']))
  })

  it('details declared on a service-level pair upgrade that same edge', () => {
    expect(mergeDependencyEdge(edge('b', '*', []), edge('b', 'POST', ['/api/x']))).toEqual(edge('b', 'POST', ['/api/x']))
  })

  it('is idempotent and sticky for critical', () => {
    const serviceLevel = edge('b', '*', [])
    expect(mergeDependencyEdge(serviceLevel, serviceLevel)).toEqual(serviceLevel)
    expect(mergeDependencyEdge(edge('b', '*', []), edge('b', '*', [], true)).critical).toBe(true)
    const once = mergeDependencyEdge(edge('b', 'GET', ['/api/x'], true), edge('b', 'GET', ['/api/x']))
    expect(mergeDependencyEdge(once, edge('b', 'GET', ['/api/x']))).toEqual(once)
  })

  it('never mutates its inputs', () => {
    const existing = edge('b', 'GET', ['/api/x'])
    const incoming = edge('b', 'GET', ['/api/y'])
    mergeDependencyEdge(existing, incoming)
    expect(existing.endpoints).toEqual(['/api/x'])
    expect(incoming.endpoints).toEqual(['/api/y'])
  })
})

describe('dedupeDependencies', () => {
  it('collapses duplicate service pairs into a single edge', () => {
    const t = emptyTopology('g')
    t.restDependencies['a'] = [edge('b', 'GET', ['/api/x']), edge('b', '*', []), edge('c', '*', []), edge('b', 'GET', ['/api/x'], true)]
    const out = dedupeDependencies(t)
    expect(out.restDependencies['a']).toEqual([edge('b', 'GET', ['/api/x'], true), edge('c', '*', [])])
    expect(t.restDependencies['a']).toHaveLength(4) // input untouched
  })

  it('is idempotent', () => {
    const t = emptyTopology('g')
    t.restDependencies['a'] = [edge('b', '*', []), edge('b', 'GET', ['/api/x'])]
    const once = dedupeDependencies(t)
    expect(dedupeDependencies(once)).toEqual(once)
  })

  it('drops keys left without edges', () => {
    const t = emptyTopology('g')
    t.restDependencies['a'] = []
    expect(dedupeDependencies(t).restDependencies).toEqual({})
  })
})

describe('TopologyStore', () => {
  let dir: string
  let store: TopologyStore

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'helmsman-topo-'))
    store = new TopologyStore({ rootDir: dir })
  })

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('save → list → load → delete round trip (CJK group names)', async () => {
    const t = emptyTopology('订单中台')
    t.services['order-service'] = { name: 'order-service', projectId: 'p1', techStack: ['Java 17'], apiEndpoints: [] }
    await store.save(t)

    expect(await store.listGroups()).toEqual(['订单中台'])
    const loaded = await store.load('订单中台')
    expect(loaded?.services['order-service']?.name).toBe('order-service')

    expect(await store.delete('订单中台')).toBe(true)
    expect(await store.listGroups()).toEqual([])
  })

  it('corrupted file degrades to null, never throws', async () => {
    await store.save(emptyTopology('broken'))
    writeFileSync(join(dir, 'broken.json'), '{ not valid json')
    expect(await store.load('broken')).toBeNull()
  })
})

describe('importers', () => {
  it('previews docker-compose and infers dependencies', () => {
    const preview = previewCompose(`
services:
  api-gateway:
    image: nginx:latest
    depends_on:
      - user-service
  user-service:
    image: user-service:1.2.0
  redis:
    image: redis:7.0
`)
    expect(preview.services.map((s) => s.name)).toEqual(['api-gateway', 'user-service', 'redis'])
    expect(preview.services.find((s) => s.name === 'redis')?.selected).toBe(false)
    expect(preview.dependencies).toEqual([{ from: 'api-gateway', to: 'user-service', method: 'DEPENDS_ON', endpoints: [] }])
  })

  it('previews kubernetes deployments', () => {
    const preview = previewKubernetes(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-service
spec:
  template:
    spec:
      containers:
        - image: order-service:1.0
`)
    expect(preview.services).toHaveLength(1)
    expect(preview.services[0]).toMatchObject({ name: 'order-service', image: 'order-service:1.0' })
  })

  it('applies preview onto a topology', () => {
    const t = emptyTopology('g')
    const preview = previewCompose(`
services:
  user-service:
    image: u:1
    depends_on:
      - order-service
  order-service:
    image: o:1
`)
    applyPreview(t, preview)
    expect(Object.keys(t.services)).toEqual(['user-service', 'order-service'])
    expect(t.restDependencies['user-service']).toEqual([
      { toServiceId: 'order-service', endpoints: [], method: 'DEPENDS_ON' },
    ])
  })
})
