/**
 * Graph-level health check for the REST dependency graph (design D3).
 *
 * The architecture declares "no cyclic calls" as an invariant, so a cycle is a
 * configuration problem to REPORT — not an input to degrade around. This module
 * is the reporting view; `computeDownstream().cyclic` and `cascadeOrder` keep
 * their existing degrade semantics untouched (the engine must not crash on a
 * dirty graph, but a human must be told).
 */
import type { ProjectTopology, RestDependencyEdge } from './types.ts'

export interface GraphHealth {
  /** Shorthand of `cycles.length > 0`. */
  cyclic: boolean
  /** Every distinct cycle found, each as its members in call direction order. */
  cycles: string[][]
  /** Edges whose target is not a declared service. */
  dangling: Array<{ from: string; to: string }>
  /** Declared services with neither an outgoing nor an incoming edge. */
  isolated: string[]
}

/**
 * Inspects the declared dependency graph.
 *
 * Nodes are the declared services plus every name that appears as an edge
 * source/target (so a cycle among undeclared names is still visible). Output is
 * deterministic: cycles are rotated to start at their smallest member and
 * sorted, isolated services are sorted, dangling edges follow graph order.
 *
 * Scope note: `dangling` reports edges whose TARGET is undeclared, matching the
 * spec wording ("指向不存在服务的边"). An undeclared edge SOURCE is out of
 * scope here.
 */
export function checkGraph(topology: ProjectTopology): GraphHealth {
  const services = Object.keys(topology.services)
  const outgoing = new Map<string, string[]>()
  const incoming = new Map<string, string[]>()
  const dangling: Array<{ from: string; to: string }> = []
  const nodes = new Set<string>(services)

  const push = (map: Map<string, string[]>, key: string, value: string): void => {
    const list = map.get(key)
    if (list) list.push(value)
    else map.set(key, [value])
  }

  for (const [from, edges] of Object.entries(topology.restDependencies)) {
    if (!Array.isArray(edges)) continue
    nodes.add(from)
    for (const edge of edges as RestDependencyEdge[]) {
      if (typeof edge !== 'object' || edge === null) continue
      nodes.add(edge.toServiceId)
      push(outgoing, from, edge.toServiceId)
      push(incoming, edge.toServiceId, from)
      if (!Object.prototype.hasOwnProperty.call(topology.services, edge.toServiceId)) {
        dangling.push({ from, to: edge.toServiceId })
      }
    }
  }

  const cycles = findCycles(nodes, outgoing)
  const isolated = services
    .filter((id) => (outgoing.get(id)?.length ?? 0) === 0 && (incoming.get(id)?.length ?? 0) === 0)
    .sort()
  return { cyclic: cycles.length > 0, cycles, dangling, isolated }
}

/**
 * DFS cycle enumeration (white/grey/black + explicit path). Graph size is
 * service-level (tens to hundreds of nodes) so recursion is fine — no
 * cross-group analysis is attempted (design D3 risk note).
 */
function findCycles(nodes: Set<string>, outgoing: Map<string, string[]>): string[][] {
  const state = new Map<string, 0 | 1 | 2>()
  const path: string[] = []
  const found = new Map<string, string[]>()

  const visit = (id: string): void => {
    state.set(id, 1)
    path.push(id)
    for (const next of outgoing.get(id) ?? []) {
      const s = state.get(next) ?? 0
      if (s === 1) {
        const cycle = canonicalCycle(path.slice(path.indexOf(next)))
        found.set(cycle.join('\u0000'), cycle)
      } else if (s === 0) {
        visit(next)
      }
    }
    path.pop()
    state.set(id, 2)
  }

  for (const id of nodes) {
    if ((state.get(id) ?? 0) === 0) visit(id)
  }
  return [...found.values()].sort((a, b) => a.join('\u0000').localeCompare(b.join('\u0000')))
}

/** Rotation-invariant form: same cycle members always yield the same array. */
function canonicalCycle(members: string[]): string[] {
  let min = 0
  for (let i = 1; i < members.length; i++) {
    if (members[i]! < members[min]!) min = i
  }
  return [...members.slice(min), ...members.slice(0, min)]
}
