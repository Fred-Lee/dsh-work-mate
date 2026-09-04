/**
 * buildGraph — merge the project topology (structure) with the vault's archived
 * docs/PRDs (knowledge) into a single graph for the knowledge panel.
 *
 * Topology is the OPTIONAL structural input (consumed from `helmsman.topology`
 * at runtime); the vault always contributes the doc/PRD nodes. This module is
 * pure — it never touches the store, so it is trivially unit-testable.
 */
import type { GraphData, GraphEdge, GraphNode, NoteMeta, TopologyGraphInput } from './types.ts'

export function buildGraph(opts: {
  topology?: TopologyGraphInput | null
  documents: NoteMeta[]
}): GraphData {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const seen = new Set<string>()

  const pushNode = (node: GraphNode): void => {
    if (seen.has(node.id)) return
    seen.add(node.id)
    nodes.push(node)
  }

  // Structural: services + API dependency edges (from topology).
  for (const svc of opts.topology?.services ?? []) {
    pushNode({ id: `svc:${svc.id}`, type: 'service', label: svc.name, meta: { serviceId: svc.id } })
  }
  for (const dep of opts.topology?.dependencies ?? []) {
    pushNode({ id: `svc:${dep.to}`, type: 'service', label: dep.to })
    edges.push({ from: `svc:${dep.from}`, to: `svc:${dep.to}`, label: dep.critical ? 'critical' : 'depends' })
  }

  // Knowledge: archived docs/PRDs. Link each to its linked projects.
  for (const doc of opts.documents) {
    const nodeId = `doc:${doc.id}`
    pushNode({
      id: nodeId,
      type: doc.kind === 'prd' ? 'prd' : 'document',
      label: doc.title,
      meta: { kind: doc.kind, createdAt: doc.createdAt },
    })
    for (const project of doc.linkedProjects ?? []) {
      pushNode({ id: `svc:${project}`, type: 'service', label: project })
      edges.push({ from: nodeId, to: `svc:${project}`, label: 'relates to' })
    }
  }

  return { nodes, edges }
}
