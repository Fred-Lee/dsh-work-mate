/** ProjectTopology data model — per PRD §3.2. */

export type ProjectType = 'maven' | 'npm' | 'gradle' | 'other'

export interface ApiEndpoint {
  method: string
  path: string
  handler?: string
  description?: string
}

export interface ServiceNode {
  name: string
  projectId: string
  techStack: string[]
  apiEndpoints: ApiEndpoint[]
  /** Repository working copy this service lives in (git repo root). */
  localPath?: string
  apiScan?: { enabled: boolean; lastScannedAt?: number; endpointCount?: number }
}

export interface ProjectNode {
  name: string
  repoUrl: string
  localPath: string
  type: ProjectType
}

export interface MavenParentNode {
  pomPath: string
  managedDependencies: Record<string, string>
  children: string[]
}

/**
 * Canonical `method` of a **service-level edge**: "A calls B", endpoints not
 * subdivided (design D1). A service-level edge is
 * `{ toServiceId, endpoints: [], method: SERVICE_LEVEL_METHOD }`.
 */
export const SERVICE_LEVEL_METHOD = '*'

export interface RestDependencyEdge {
  toServiceId: string
  /**
   * Endpoint paths covered by this edge. An EMPTY array means the edge was
   * declared at service level ("A calls B", endpoints unspecified) — see
   * `isServiceLevelEdge` / `SERVICE_LEVEL_METHOD`. Importers may use their own
   * marker method (`DEPENDS_ON`, `TCP`, …); the display rules key off the
   * absence of detail, not off the method value.
   */
  endpoints: string[]
  /**
   * HTTP method shared by this edge's endpoints, or `SERVICE_LEVEL_METHOD`
   * (`'*'`) when no endpoint detail was declared. (The model stores one method
   * per edge, so a service pair is still exactly one edge.)
   */
  method: string
  /** Marks the edge as critical-path; affects cascade scheduling priority. */
  critical?: boolean
}

/**
 * True when the edge carries no endpoint detail — i.e. it is a service-level
 * edge. Display sites MUST degrade for these edges (`A ──▶ B` /
 * `A --▶ B`) instead of printing an empty method/endpoint fragment.
 */
export function isServiceLevelEdge(edge: Pick<RestDependencyEdge, 'endpoints'>): boolean {
  return edge.endpoints.length === 0
}

export interface ProjectTopology {
  projectGroupId: string
  name: string
  description: string
  defaultBranch: string
  projects: Record<string, ProjectNode>
  services: Record<string, ServiceNode>
  mavenParents: Record<string, MavenParentNode>
  restDependencies: Record<string, RestDependencyEdge[]>
}

export interface DownstreamEdge {
  fromServiceId: string
  toServiceId: string
  endpoints: string[]
  method: string
  critical?: boolean
}

export interface DownstreamReport {
  serviceId: string
  /** Direct edges leaving this service. */
  direct: DownstreamEdge[]
  /** Direct edges arriving at this service (who calls me). */
  calledBy: DownstreamEdge[]
  /** Transitive closure in topological order (cascade execution order). */
  transitive: string[]
  /** True if the dependency graph contains a cycle (cascade order degraded). */
  cyclic: boolean
}

export function emptyTopology(projectGroupId: string, name?: string): ProjectTopology {
  return {
    projectGroupId,
    name: name ?? projectGroupId,
    description: '',
    defaultBranch: 'main',
    projects: {},
    services: {},
    mavenParents: {},
    restDependencies: {},
  }
}

/** Validates/normalizes an untrusted topology object loaded from disk or HTTP. */
export function normalizeTopology(input: unknown): ProjectTopology {
  if (typeof input !== 'object' || input === null) throw new Error('topology must be an object')
  const t = input as Record<string, unknown>
  const id = typeof t.projectGroupId === 'string' && t.projectGroupId.trim() ? t.projectGroupId.trim() : 'default'
  const out = emptyTopology(id, typeof t.name === 'string' ? t.name : undefined)
  if (typeof t.description === 'string') out.description = t.description
  if (typeof t.defaultBranch === 'string' && t.defaultBranch) out.defaultBranch = t.defaultBranch

  const strRecord = (v: unknown): Record<string, Record<string, unknown>> =>
    typeof v === 'object' && v !== null ? (v as Record<string, Record<string, unknown>>) : {}

  for (const [key, value] of Object.entries(strRecord(t.projects))) {
    const p = value as Record<string, unknown>
    out.projects[key] = {
      name: String(p.name ?? key),
      repoUrl: typeof p.repoUrl === 'string' ? p.repoUrl : '',
      localPath: typeof p.localPath === 'string' ? p.localPath : '',
      type: (['maven', 'npm', 'gradle', 'other'] as const).includes(p.type as ProjectType) ? (p.type as ProjectType) : 'other',
    }
  }
  for (const [key, value] of Object.entries(strRecord(t.services))) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const s = value as Record<string, unknown>
    out.services[key] = {
      name: String(s.name ?? key),
      projectId: typeof s.projectId === 'string' ? s.projectId : '',
      techStack: Array.isArray(s.techStack) ? s.techStack.map(String) : [],
      apiEndpoints: Array.isArray(s.apiEndpoints)
        ? (s.apiEndpoints as Record<string, unknown>[]).map((e) => ({
            method: String(e.method ?? 'GET'),
            path: String(e.path ?? '/'),
            ...(typeof e.handler === 'string' ? { handler: e.handler } : {}),
            ...(typeof e.description === 'string' ? { description: e.description } : {}),
          }))
        : [],
      ...(typeof s.localPath === 'string' ? { localPath: s.localPath } : {}),
      ...(typeof s.apiScan === 'object' && s.apiScan !== null
        ? {
            apiScan: {
              enabled: Boolean((s.apiScan as Record<string, unknown>).enabled),
            },
          }
        : {}),
    }
  }
  for (const [key, value] of Object.entries(strRecord(t.mavenParents))) {
    const m = value as Record<string, unknown>
    out.mavenParents[key] = {
      pomPath: typeof m.pomPath === 'string' ? m.pomPath : '',
      managedDependencies:
        typeof m.managedDependencies === 'object' && m.managedDependencies !== null
          ? Object.fromEntries(Object.entries(m.managedDependencies as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
          : {},
      children: Array.isArray(m.children) ? m.children.map(String) : [],
    }
  }
  for (const [key, value] of Object.entries(strRecord(t.restDependencies))) {
    if (!Array.isArray(value)) continue
    out.restDependencies[key] = (value as Record<string, unknown>[]).map((e) => {
      // Service-level edges (design D1) MUST survive normalization untouched:
      // an empty `endpoints` array stays empty and `'*'` stays `'*'` — never
      // filled with a default `GET` or a placeholder path. Only an edge that
      // carries endpoints but no method falls back to the legacy `GET`.
      const endpoints = Array.isArray(e.endpoints) ? e.endpoints.map(String) : []
      const method = typeof e.method === 'string' && e.method !== '' ? e.method : endpoints.length > 0 ? 'GET' : SERVICE_LEVEL_METHOD
      return {
        toServiceId: String(e.toServiceId ?? ''),
        endpoints,
        method,
        ...(e.critical === true ? { critical: true } : {}),
      }
    })
  }
  return out
}

/** Copies an edge so callers never share (or accidentally mutate) structure. */
function cloneEdge(edge: RestDependencyEdge): RestDependencyEdge {
  return {
    toServiceId: edge.toServiceId,
    endpoints: [...edge.endpoints],
    method: edge.method,
    ...(edge.critical === true ? { critical: true } : {}),
  }
}

/**
 * Merges `incoming` into the single edge that represents the service pair
 * (fromServiceId, toServiceId) — design D2. Pure: returns a NEW edge, never
 * mutates its inputs.
 *
 * Rules:
 *  - endpoint details are unioned and deduped by (method, endpoint) — the
 *    surviving edge stores one method, so entries are deduped by endpoint
 *    string under the surviving method;
 *  - a detail-less side never displaces details: the side that declared
 *    endpoints owns the resulting method, and two detail-less sides keep the
 *    existing method (stable → merging is idempotent);
 *  - `critical` is sticky (OR).
 */
export function mergeDependencyEdge(existing: RestDependencyEdge, incoming: RestDependencyEdge): RestDependencyEdge {
  const existingHasDetail = existing.endpoints.length > 0
  const incomingHasDetail = incoming.endpoints.length > 0
  const method = incomingHasDetail && !existingHasDetail ? incoming.method : existing.method
  const seen = new Set<string>()
  const endpoints: string[] = []
  for (const endpoint of [...existing.endpoints, ...incoming.endpoints]) {
    const key = `${method}\u0000${endpoint}`
    if (seen.has(key)) continue
    seen.add(key)
    endpoints.push(endpoint)
  }
  return {
    toServiceId: existing.toServiceId || incoming.toServiceId,
    endpoints,
    method,
    ...(existing.critical === true || incoming.critical === true ? { critical: true } : {}),
  }
}

/**
 * Enforces the (fromServiceId, toServiceId) uniqueness invariant over a whole
 * graph: duplicate pairs collapse into one edge whose details are merged.
 * Returns a NEW topology (the input is left alone); keys left without edges are
 * dropped. Applied on every persist path by the topology service.
 */
export function dedupeDependencies(topology: ProjectTopology): ProjectTopology {
  const restDependencies: Record<string, RestDependencyEdge[]> = {}
  for (const [from, edges] of Object.entries(topology.restDependencies)) {
    if (!Array.isArray(edges)) continue
    const merged: RestDependencyEdge[] = []
    const at = new Map<string, number>()
    for (const edge of edges) {
      if (typeof edge !== 'object' || edge === null) continue
      const index = at.get(edge.toServiceId)
      if (index === undefined) {
        at.set(edge.toServiceId, merged.length)
        merged.push(cloneEdge(edge))
      } else {
        merged[index] = mergeDependencyEdge(merged[index]!, edge)
      }
    }
    if (merged.length > 0) restDependencies[from] = merged
  }
  return { ...topology, restDependencies }
}
