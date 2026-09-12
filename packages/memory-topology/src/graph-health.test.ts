import { describe, expect, it } from 'vitest'
import { checkGraph } from './graph-health.ts'
import { emptyTopology, type ProjectTopology, type RestDependencyEdge } from './types.ts'

function edge(to: string, endpoints: string[] = []): RestDependencyEdge {
  return { toServiceId: to, endpoints, method: endpoints.length > 0 ? 'GET' : '*' }
}

function graph(services: string[], deps: Record<string, RestDependencyEdge[]>): ProjectTopology {
  const t = emptyTopology('g')
  for (const id of services) t.services[id] = { name: id, projectId: id, techStack: [], apiEndpoints: [] }
  t.restDependencies = deps
  return t
}

describe('checkGraph — cycles', () => {
  it('reports A→B→A as a cycle with its members', () => {
    const health = checkGraph(graph(['a', 'b'], { a: [edge('b')], b: [edge('a')] }))
    expect(health.cyclic).toBe(true)
    expect(health.cycles).toEqual([['a', 'b']])
  })

  it('reports a longer cycle rotated to start at its smallest member', () => {
    const health = checkGraph(graph(['a', 'b', 'c'], { a: [edge('b')], b: [edge('c')], c: [edge('a')] }))
    expect(health.cycles).toEqual([['a', 'b', 'c']])
  })

  it('reports a self-loop as a cycle', () => {
    const health = checkGraph(graph(['a'], { a: [edge('a')] }))
    expect(health.cyclic).toBe(true)
    expect(health.cycles).toEqual([['a']])
  })

  it('reports every distinct cycle, deterministically', () => {
    const health = checkGraph(
      graph(['a', 'b', 'c', 'd'], { a: [edge('b')], b: [edge('a'), edge('c'), edge('d')], c: [edge('b')], d: [] }),
    )
    expect(health.cycles).toEqual([['a', 'b'], ['b', 'c']])
  })
})

describe('checkGraph — dangling references', () => {
  it('reports edges whose target is not a declared service', () => {
    const health = checkGraph(graph(['a'], { a: [edge('ghost')] }))
    expect(health.dangling).toEqual([{ from: 'a', to: 'ghost' }])
    expect(health.cyclic).toBe(false)
  })

  it('reports no dangling reference for known targets', () => {
    const health = checkGraph(graph(['a', 'b'], { a: [edge('b')] }))
    expect(health.dangling).toEqual([])
  })
})

describe('checkGraph — isolated services', () => {
  it('reports a service with neither incoming nor outgoing edges', () => {
    const health = checkGraph(graph(['a', 'b', 'lonely'], { a: [edge('b')] }))
    expect(health.isolated).toEqual(['lonely'])
  })

  it('does not treat a service with only an incoming edge as isolated', () => {
    const health = checkGraph(graph(['a', 'b'], { a: [edge('b')] }))
    expect(health.isolated).toEqual([])
  })

  it('reports every service as isolated when no dependency is declared', () => {
    const health = checkGraph(graph(['b', 'a'], {}))
    expect(health.isolated).toEqual(['a', 'b'])
  })

  it('reports the source of a dangling edge as non-isolated (it does declare a call)', () => {
    const health = checkGraph(graph(['a'], { a: [edge('ghost')] }))
    expect(health.isolated).toEqual([])
  })
})

describe('checkGraph — clean graph', () => {
  it('returns an empty problem list for a connected acyclic graph', () => {
    const health = checkGraph(graph(['a', 'b', 'c'], { a: [edge('b')], b: [edge('c')] }))
    expect(health).toEqual({ cyclic: false, cycles: [], dangling: [], isolated: [] })
  })

  it('ignores endpoint detail (service-level edges are first-class)', () => {
    const health = checkGraph(graph(['a', 'b'], { a: [edge('b', ['/api/x'])] }))
    expect(health).toEqual({ cyclic: false, cycles: [], dangling: [], isolated: [] })
  })
})
