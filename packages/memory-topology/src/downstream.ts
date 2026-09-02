/** Downstream dependency computation — direct edges, reverse edges, and the
 * transitive closure in topological order (cascade execution order). */
import type { DownstreamEdge, DownstreamReport, ProjectTopology } from './types.ts'

export function computeDownstream(topology: ProjectTopology, serviceId: string): DownstreamReport {
  const deps = topology.restDependencies
  const direct: DownstreamEdge[] = (deps[serviceId] ?? []).map((e) => ({
    fromServiceId: serviceId,
    toServiceId: e.toServiceId,
    endpoints: e.endpoints,
    method: e.method,
    ...(e.critical === true ? { critical: true } : {}),
  }))
  const calledBy: DownstreamEdge[] = []
  for (const [from, edges] of Object.entries(deps)) {
    for (const e of edges) {
      if (e.toServiceId === serviceId) {
        calledBy.push({
          fromServiceId: from,
          toServiceId: serviceId,
          endpoints: e.endpoints,
          method: e.method,
          ...(e.critical === true ? { critical: true } : {}),
        })
      }
    }
  }

  // BFS over outgoing edges for the transitive closure.
  const visited = new Set<string>()
  const order: string[] = []
  const queue = [...direct.map((e) => e.toServiceId)]
  let cyclic = false
  const inStack = new Set<string>([serviceId])
  while (queue.length > 0) {
    const next = queue.shift()!
    if (next === serviceId) {
      cyclic = true
      continue
    }
    if (visited.has(next)) continue
    visited.add(next)
    order.push(next)
    inStack.add(next)
    for (const e of deps[next] ?? []) {
      if (!inStack.has(e.toServiceId)) queue.push(e.toServiceId)
      else cyclic = true
    }
  }

  return { serviceId, direct, calledBy, transitive: order, cyclic }
}

/**
 * Cascade execution order for a task that touches a set of services:
 * topological sort of the sub-graph spanned by those services and their
 * transitive downstream. Cycles degrade to discovery order (BFS).
 */
export function cascadeOrder(topology: ProjectTopology, touchedServiceIds: string[]): string[] {
  const deps = topology.restDependencies
  const relevant = new Set(touchedServiceIds)
  const queue = [...touchedServiceIds]
  while (queue.length > 0) {
    const cur = queue.shift()!
    for (const e of deps[cur] ?? []) {
      if (!relevant.has(e.toServiceId)) {
        relevant.add(e.toServiceId)
        queue.push(e.toServiceId)
      }
    }
  }
  const result: string[] = []
  const permanent = new Set<string>()
  const temporary = new Set<string>()
  const visit = (id: string): void => {
    if (permanent.has(id)) return
    if (temporary.has(id)) return // cycle — degrade
    temporary.add(id)
    for (const e of deps[id] ?? []) {
      if (relevant.has(e.toServiceId)) visit(e.toServiceId)
    }
    temporary.delete(id)
    permanent.add(id)
    result.push(id)
  }
  for (const id of relevant) visit(id)
  return result
}
