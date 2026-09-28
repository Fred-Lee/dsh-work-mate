/** Client-side face of GET /workmate/api/graph (M5). */
export interface GraphPayload {
  nodes: Array<{ kind: 'proposal' | 'project' | 'commit'; id: string; label: string; status?: string }>
  edges: Array<{ from: string; to: string; relation: string }>
  generatedAt: string
}
