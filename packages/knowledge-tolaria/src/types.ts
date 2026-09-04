/** @helmsman/knowledge-tolaria shared types. */

export type NoteKind = 'research' | 'prd' | 'design'

/** Lightweight note metadata carried in a note's YAML frontmatter. */
export interface NoteMeta {
  id: string
  title: string
  kind: NoteKind
  createdAt: string
  archivedAt?: string
  linkedProjects?: string[]
}

/** A full note: metadata + markdown body + parsed frontmatter. */
export interface Note extends NoteMeta {
  body: string
  frontmatter: Record<string, unknown>
}

/** A search hit: note identity plus a matched snippet. */
export interface SearchHit extends NoteMeta {
  path: string
  snippet: string
  matchedField: 'title' | 'keywords' | 'body' | 'projects'
}

/** A graph node (service / doc / prd) for the knowledge panel. */
export interface GraphNode {
  id: string
  type: 'service' | 'document' | 'prd' | 'api'
  label: string
  meta?: Record<string, unknown>
}

/** A directed graph edge (dependency / relates to). */
export interface GraphEdge {
  from: string
  to: string
  label?: string
}

export interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

/**
 * Minimal project-topology slice consumed from `helmsman.topology` (optional).
 * Only what the graph needs — the knowledge layer never owns topology storage.
 */
export interface TopologyGraphInput {
  services: Array<{ id: string; name: string }>
  dependencies: Array<{ from: string; to: string; critical?: boolean }>
}
