/** Architecture importers — docker-compose.yml, Kubernetes manifests, OpenAPI. */
import { parseYamlSubset, type YamlValue } from './yaml.ts'
import type { ApiEndpoint, ProjectTopology, ServiceNode } from './types.ts'
import { emptyTopology } from './types.ts'

export interface ImportPreview {
  source: 'docker-compose' | 'kubernetes' | 'openapi'
  services: Array<{ name: string; image?: string; selected: boolean; endpoints: ApiEndpoint[] }>
  dependencies: Array<{ from: string; to: string; method: string; endpoints: string[] }>
  warnings: string[]
}

export interface ImportOptions {
  /** Infer dependencies from depends_on / env-var service references. */
  inferDependencies?: boolean
}

function asRecord(v: YamlValue): Record<string, YamlValue> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, YamlValue>) : {}
}

function asString(v: YamlValue): string {
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

/** Applies a preview onto a topology: merges selected services + dependencies. */
export function applyPreview(topology: ProjectTopology, preview: ImportPreview): ProjectTopology {
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
  for (const dep of preview.dependencies) {
    if (!topology.services[dep.from] || !topology.services[dep.to]) continue
    const edges = topology.restDependencies[dep.from] ?? []
    const existing = edges.find((e) => e.toServiceId === dep.to)
    if (existing) {
      existing.endpoints = [...new Set([...existing.endpoints, ...dep.endpoints])]
    } else {
      edges.push({ toServiceId: dep.to, endpoints: dep.endpoints, method: dep.method })
    }
    topology.restDependencies[dep.from] = edges
  }
  return topology
}

export function makeImportedTopology(groupName: string, preview: ImportPreview): ProjectTopology {
  const t = emptyTopology(groupName, groupName)
  return applyPreview(t, preview)
}
