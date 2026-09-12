/**
 * Regression lock for the pre-existing cycle semantics: `computeDownstream`
 * keeps reporting `cyclic` and `cascadeOrder` keeps degrading to a
 * non-topological order instead of throwing. The new graph health check
 * (graph-health.ts) is an ADDITIONAL view, not a replacement (design D3).
 */
import { describe, expect, it } from 'vitest'
import { cascadeOrder, computeDownstream } from './downstream.ts'
import { emptyTopology, type ProjectTopology, type RestDependencyEdge } from './types.ts'

function edge(to: string, method = '*', endpoints: string[] = []): RestDependencyEdge {
  return { toServiceId: to, endpoints, method }
}

function graph(deps: Record<string, RestDependencyEdge[]>, services: string[] = Object.keys(deps)): ProjectTopology {
  const t = emptyTopology('g')
  for (const id of services) t.services[id] = { name: id, projectId: id, techStack: [], apiEndpoints: [] }
  t.restDependencies = deps
  return t
}

describe('computeDownstream (semantics preserved)', () => {
  it('reports direct / calledBy / transitive for a DAG with cyclic=false', () => {
    const t = graph({ a: [edge('b')], b: [edge('c')], c: [] })
    const report = computeDownstream(t, 'a')
    expect(report.direct.map((e) => e.toServiceId)).toEqual(['b'])
    expect(report.calledBy).toEqual([])
    expect(report.transitive).toEqual(['b', 'c'])
    expect(report.cyclic).toBe(false)

    const mid = computeDownstream(t, 'b')
    expect(mid.calledBy.map((e) => e.fromServiceId)).toEqual(['a'])
  })

  it('flags cyclic=true for A→B→A', () => {
    const t = graph({ a: [edge('b')], b: [edge('a')] })
    expect(computeDownstream(t, 'a').cyclic).toBe(true)
    expect(computeDownstream(t, 'b').cyclic).toBe(true)
  })

  it('flags a self-loop as cyclic', () => {
    expect(computeDownstream(graph({ a: [edge('a')] }), 'a').cyclic).toBe(true)
  })

  it('passes service-level edges through without filling in detail', () => {
    const report = computeDownstream(graph({ a: [edge('b')] }), 'a')
    expect(report.direct[0]).toMatchObject({ fromServiceId: 'a', toServiceId: 'b', endpoints: [], method: '*' })
  })
})

describe('cascadeOrder (degrade behaviour preserved)', () => {
  it('orders an acyclic graph dependencies-first', () => {
    const t = graph({ a: [edge('b')], b: [edge('c')], c: [] })
    expect(cascadeOrder(t, ['a'])).toEqual(['c', 'b', 'a'])
  })

  it('degrades on a cycle without throwing, looping or dropping nodes', () => {
    const t = graph({ a: [edge('b')], b: [edge('a')] })
    const order = cascadeOrder(t, ['a'])
    expect(order).toHaveLength(2)
    expect(new Set(order)).toEqual(new Set(['a', 'b']))
  })

  it('terminates on a self-loop', () => {
    expect(cascadeOrder(graph({ a: [edge('a')] }), ['a'])).toEqual(['a'])
  })
})
