/** Architecture importers — docker-compose.yml, Kubernetes manifests, OpenAPI, repository declaration. */
import { parseYamlSubset, type YamlValue } from './yaml.ts'
import { DECLARATION_IMPORT_SOURCE } from './declaration.ts'
import { edgeSource, mergeDependencyEdge, type ApiEndpoint, type ProjectTopology, type RestDependencyEdge, type ServiceNode } from './types.ts'
import { emptyTopology } from './types.ts'

export interface ImportPreview {
  source: 'docker-compose' | 'kubernetes' | 'openapi' | typeof DECLARATION_IMPORT_SOURCE
  services: Array<{ name: string; image?: string; selected: boolean; endpoints: ApiEndpoint[] }>
  dependencies: Array<{ from: string; to: string; method: string; endpoints: string[]; critical?: boolean }>
  warnings: string[]
  /**
   * Present only for source `helmsman-declaration` (design D2/D4): which service
   * the file declares for. Reconciliation only ever touches that service's edges.
   */
  declaration?: { service: string; file?: string }
  /**
   * Declaration ingest only: targets the file references that are NOT registered
   * in the group. They are offered as selectable services so applying can
   * register them in the same flow (design D5) instead of leaving dangling edges.
   */
  undeclaredTargets?: string[]
}

export interface ImportOptions {
  /** Infer dependencies from depends_on / env-var service references. */
  inferDependencies?: boolean
}

function asRecord(v: YamlValue | undefined): Record<string, YamlValue> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, YamlValue>) : {}
}

function asString(v: YamlValue | undefined): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
}

export function previewCompose(text: string, opts: ImportOptions = {}): ImportPreview {
  const doc = asRecord(parseYamlSubset(text))
  const services = asRecord(doc.services)
  const preview: ImportPreview = { source: 'docker-compose', services: [], dependencies: [], warnings: [] }
  const names: string[] = []
  for (const [name, raw] of Object.entries(services)) {
    const svc = asRecord(raw)
    names.push(name)
    const image = asString(svc.image)
    preview.services.push({
      name,
      ...(image ? { image } : {}),
      selected: !isInfrastructure(name),
      endpoints: [],
    })
  }
  if (opts.inferDependencies !== false) {
    for (const [name, raw] of Object.entries(services)) {
      const svc = asRecord(raw)
      const depends = svc.depends_on
      const targets: string[] = []
      if (Array.isArray(depends)) targets.push(...depends.map(asString))
      else if (typeof depends === 'object' && depends !== null) targets.push(...Object.keys(depends))
      for (const to of targets) {
        if (names.includes(to)) {
          preview.dependencies.push({ from: name, to, method: 'DEPENDS_ON', endpoints: [] })
        }
      }
    }
  }
  if (preview.services.length === 0) preview.warnings.push('未在 compose 文件中发现 services 定义')
  return preview
}

function isInfrastructure(name: string): boolean {
  return /^(redis|mysql|postgres|mongodb|mongo|kafka|rabbitmq|zookeeper|nginx|elasticsearch|etcd|consul|memcached)/i.test(name)
}

export function previewKubernetes(text: string): ImportPreview {
  const preview: ImportPreview = { source: 'kubernetes', services: [], dependencies: [], warnings: [] }
  const docs = text.split(/^---\s*$/m).map((d) => d.trim()).filter(Boolean)
  for (const doc of docs) {
    const parsed = asRecord(parseYamlSubset(doc))
    const kind = asString(parsed.kind)
    if (kind !== 'Deployment' && kind !== 'Service') continue
    const meta = asRecord(parsed.metadata)
    const name = asString(meta.name)
    if (!name) continue
    const spec = asRecord(parsed.spec)
    const template = asRecord(asRecord(spec.template).spec ?? parsed.spec)
    const containers = Array.isArray(template.containers) ? template.containers : []
    const image = asString(asRecord(containers[0] ?? {}).image)
    if (kind === 'Deployment') {
      preview.services.push({ name, ...(image ? { image } : {}), selected: !isInfrastructure(name), endpoints: [] })
    } else {
      // ClusterIP/NodePort Service → try to expose its ports as endpoints
      const ports = Array.isArray(spec.ports) ? spec.ports : []
      const endpoints: ApiEndpoint[] = ports.map((p) => ({
        method: 'TCP',
        path: `:${asString(asRecord(p).port) || '?'}`,
        description: `k8s ${kind}`,
      }))
      preview.services.push({ name, selected: false, endpoints })
    }
  }
  if (preview.services.length === 0) preview.warnings.push('未发现 Deployment 资源')
  return preview
}

export function previewOpenApi(text: string): ImportPreview {
  const preview: ImportPreview = { source: 'openapi', services: [], dependencies: [], warnings: [] }
  let doc: Record<string, unknown>
  try {
    doc = JSON.parse(text) as Record<string, unknown>
  } catch {
    preview.warnings.push('OpenAPI 导入仅支持 JSON 格式')
    return preview
  }
  const paths = (doc.paths ?? {}) as Record<string, Record<string, unknown>>
  const endpoints: ApiEndpoint[] = []
  for (const [path, ops] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(ops)) {
      if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) continue
      endpoints.push({
        method: method.toUpperCase(),
        path,
        description: typeof (op as Record<string, unknown>)?.summary === 'string' ? (op as Record<string, unknown>).summary as string : undefined,
      })
    }
  }
  const info = (doc.info ?? {}) as Record<string, unknown>
  const name = typeof info.title === 'string' ? info.title : 'openapi-service'
  preview.services.push({ name, selected: true, endpoints })
  return preview
}

/** Registers/updates the preview's selected services (unchanged import behavior). */
function applyServices(topology: ProjectTopology, preview: ImportPreview): void {
  for (const svc of preview.services) {
    if (!svc.selected) continue
    const node: ServiceNode = {
      name: svc.name,
      projectId: svc.name,
      techStack: svc.image ? [svc.image] : [],
      apiEndpoints: svc.endpoints,
    }
    topology.services[svc.name] = { ...topology.services[svc.name], ...node }
  }
}

/** Merges the preview's dependency edges into the graph (pair-merge semantics). */
function applyDependencies(topology: ProjectTopology, preview: ImportPreview): void {
  for (const dep of preview.dependencies) {
    if (!topology.services[dep.from] || !topology.services[dep.to]) continue
    const edges = topology.restDependencies[dep.from] ?? []
    const existing = edges.find((e) => e.toServiceId === dep.to)
    if (existing) {
      existing.endpoints = [...new Set([...existing.endpoints, ...dep.endpoints])]
      if (dep.critical === true) existing.critical = true
    } else {
      edges.push({ toServiceId: dep.to, endpoints: dep.endpoints, method: dep.method, ...(dep.critical === true ? { critical: true } : {}) })
    }
    topology.restDependencies[dep.from] = edges
  }
}

/** Applies a preview onto a topology: merges selected services + dependencies. */
export function applyPreview(topology: ProjectTopology, preview: ImportPreview): ProjectTopology {
  applyServices(topology, preview)
  applyDependencies(topology, preview)
  return topology
}

// ---------------------------------------------------------------------------
// Repository declaration (`declare-dependencies-in-repo`, design D2/D4/D5)
// ---------------------------------------------------------------------------

export interface DeclarationPreviewOptions {
  /**
   * Services already registered in the group. Their targets are NOT offered as
   * services to register; every other target is (design D5). Omit when the group
   * is unknown (the text-only `importPreview` path) — then no target is claimed
   * to be undeclared.
   */
  registered?: Iterable<string>
  /** Absolute path of the declaration file, surfaced as evidence. */
  file?: string
  warnings?: string[]
}

/**
 * Turns a parsed declaration into the EXISTING `ImportPreview` shape so the human
 * verifies it in the existing preview/apply UI (`importPreview` → `importApply`)
 * instead of a second review surface (design D2).
 */
export function previewDeclaration(
  service: string,
  edges: readonly RestDependencyEdge[],
  opts: DeclarationPreviewOptions = {},
): ImportPreview {
  const known = opts.registered === undefined ? null : new Set(opts.registered)
  const preview: ImportPreview = {
    source: DECLARATION_IMPORT_SOURCE,
    services: [{ name: service, selected: true, endpoints: [] }],
    dependencies: edges.map((edge) => ({
      from: service,
      to: edge.toServiceId,
      method: edge.method,
      endpoints: [...edge.endpoints],
      ...(edge.critical === true ? { critical: true } : {}),
    })),
    warnings: [...(opts.warnings ?? [])],
    declaration: { service, ...(opts.file ? { file: opts.file } : {}) },
  }
  const undeclared: string[] = []
  for (const edge of edges) {
    const to = edge.toServiceId
    if (!known || to === service || known.has(to)) continue // group unknown → no undeclared claim
    if (preview.services.some((s) => s.name === to)) continue
    preview.services.push({ name: to, selected: true, endpoints: [] })
    undeclared.push(to)
  }
  if (known) preview.undeclaredTargets = undeclared
  return preview
}

/**
 * Reconciliation on ingest (design D4): for the declaring service the file is the
 * sole source of truth for its DECLARED edges.
 *
 *  - pairs the file has are added (or merged into the existing row);
 *  - declared pairs the file no longer has are REMOVED;
 *  - `derived` edges are never added or removed: a pair the file now declares is
 *    merged with it (`declared` wins, details unioned), every other derived edge
 *    survives verbatim.
 *
 * Re-applying an unchanged file therefore changes nothing (idempotent).
 */
export function reconcileDeclaredEdges(
  topology: ProjectTopology,
  service: string,
  fileEdges: readonly RestDependencyEdge[],
): ProjectTopology {
  const pending = new Map<string, RestDependencyEdge>()
  for (const edge of fileEdges) pending.set(edge.toServiceId, edge)
  const kept: RestDependencyEdge[] = []
  for (const edge of topology.restDependencies[service] ?? []) {
    const fromFile = pending.get(edge.toServiceId)
    if (!fromFile) {
      // Not in the file: a declared edge loses its home and goes away; a derived
      // edge was discovered here, has no other home, and stays.
      if (edgeSource(edge) === 'derived') kept.push(edge)
      continue
    }
    kept.push(mergeDependencyEdge(edge, fromFile))
    pending.delete(edge.toServiceId)
  }
  for (const edge of pending.values()) kept.push({ ...edge, endpoints: [...edge.endpoints] })
  const restDependencies = { ...topology.restDependencies }
  if (kept.length > 0) restDependencies[service] = kept
  else delete restDependencies[service]
  return { ...topology, restDependencies }
}

/**
 * Applies a declaration preview: registers the selected services (additively —
 * ingest never overwrites an existing service's scanned endpoints or tech stack),
 * then reconciles the declaring service's edges against the file.
 */
export function applyDeclaration(topology: ProjectTopology, preview: ImportPreview): ProjectTopology {
  const service = preview.declaration?.service
  if (!service) throw new Error('声明预览缺少 declaration.service（无法确定这些依赖的调用方）')
  const services = { ...topology.services }
  for (const svc of preview.services) {
    if (!svc.selected || services[svc.name]) continue
    services[svc.name] = { name: svc.name, projectId: svc.name, techStack: [], apiEndpoints: [] }
  }
  const fileEdges: RestDependencyEdge[] = preview.dependencies
    .filter((dep) => dep.from === service)
    .map((dep) => ({
      toServiceId: dep.to,
      endpoints: [...dep.endpoints],
      method: dep.method,
      ...(dep.critical === true ? { critical: true } : {}),
      source: 'declared' as const,
    }))
  return reconcileDeclaredEdges({ ...topology, services }, service, fileEdges)
}

export function makeImportedTopology(groupName: string, preview: ImportPreview): ProjectTopology {
  const t = emptyTopology(groupName, groupName)
  return applyPreview(t, preview)
}
