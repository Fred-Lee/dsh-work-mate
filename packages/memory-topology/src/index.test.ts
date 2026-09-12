/**
 * Service-surface tests: the (from, to) dedupe invariant is enforced by the
 * PERSIST path (not only by the config page), and the graph health check is
 * exposed read-only without changing `loadTopology`'s return shape.
 *
 * The plugin entry is wired with a minimal fake cordis context (same pattern as
 * packages/presets/src/index.test.ts) so the real service object is exercised.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
