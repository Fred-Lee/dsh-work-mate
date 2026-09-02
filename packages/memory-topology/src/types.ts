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

export interface RestDependencyEdge {
  toServiceId: string
  endpoints: string[]
  method: string
  /** Marks the edge as critical-path; affects cascade scheduling priority. */
  critical?: boolean
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
    out.restDependencies[key] = (value as Record<string, unknown>[]).map((e) => ({
      toServiceId: String(e.toServiceId ?? ''),
      endpoints: Array.isArray(e.endpoints) ? e.endpoints.map(String) : [],
      method: String(e.method ?? 'GET'),
      ...(e.critical === true ? { critical: true } : {}),
    }))
  }
  return out
}
