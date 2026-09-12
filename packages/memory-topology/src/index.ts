/**
 * @helmsman/memory-topology — DSH plugin entry.
 *
 * Extends the memory ecosystem with a `ProjectTopology` model (PRD §3.2):
 * multi-repo project groups, services, Maven parent-POM relations, REST
 * dependency graph — persisted under ~/.helmsman/topologies/ and queryable
 * by both the Web UI and agents (via helmsman_topology tools).
 *
 * Reuse strategy: when `dsh-memory-manager` is installed (Typert remote
 * service `memoryManager`), topology snapshots are mirrored into the user's
 * memory store as a `project`-type note — best-effort, never blocking.
 */
import { readFile, realpath } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'
import { TopologyStore } from './store.ts'
import { computeDownstream, cascadeOrder } from './downstream.ts'
import { checkGraph, type GraphHealth } from './graph-health.ts'
import { deriveDependencies as deriveFromTopology, type DeriveOptions, type DeriveResult } from './derive-dependencies.ts'
import { scanMavenPom } from './scan-maven.ts'
import { scanRestApis } from './scan-rest.ts'
import {
  DECLARATION_RELATIVE_PATH,
  declarationPathFor,
  parseDeclaration,
  readDeclaration,
  renderDeclaration,
  type DeclarationReadResult,
} from './declaration.ts'
import { checkDeclarationDrift, type DeclarationDriftResult } from './declaration-drift.ts'
import {
  applyDeclaration,
  applyPreview,
  makeImportedTopology,
  previewCompose,
  previewDeclaration,
  previewKubernetes,
  previewOpenApi,
  type ImportPreview,
} from './import.ts'
import { toYaml } from './yaml.ts'
import { dedupeDependencies, edgeSource, emptyTopology, mergeDependencyEdge, normalizeTopology, SERVICE_LEVEL_METHOD, type ApiEndpoint, type DownstreamReport, type ProjectTopology, type RestDependencyEdge, type ServiceNode } from './types.ts'

export const name = '@helmsman/memory-topology'
export const inject = ['tools'] as const

export type {
  ApiEndpoint,
  DownstreamEdge,
  DownstreamReport,
  EdgeSource,
  MavenParentNode,
  ProjectNode,
  ProjectTopology,
  ProjectType,
  RestDependencyEdge,
  ServiceNode,
} from './types.ts'
export { emptyTopology, normalizeTopology } from './types.ts'
export { dedupeDependencies, edgeSource, isEdgeSource, isServiceLevelEdge, mergeDependencyEdge, SERVICE_LEVEL_METHOD } from './types.ts'
export { checkGraph } from './graph-health.ts'
export type { GraphHealth } from './graph-health.ts'
export { deriveDependencies, matchEndpoint, candidateToEdge, wouldCreateCycle } from './derive-dependencies.ts'
export type { Candidate, CandidateEvidence, ConfidenceTier, DependencyCandidate, DeriveOptions, DeriveResult } from './derive-dependencies.ts'
export { scanOutboundCalls } from './scan-outbound.ts'
export type { OutboundCall, OutboundEvidence, OutboundEvidenceKind, OutboundScanOptions } from './scan-outbound.ts'
export {
  DECLARATION_DIR,
  DECLARATION_FILE,
  DECLARATION_IMPORT_SOURCE,
  DECLARATION_RELATIVE_PATH,
  DECLARATION_VERSION,
  declarationPathFor,
  normalizeDeclarationEdge,
  parseDeclaration,
  readDeclaration,
  renderDeclaration,
} from './declaration.ts'
export type { DeclarationParseFailure, DeclarationParseResult, DeclarationParseSuccess, DeclarationReadResult } from './declaration.ts'
export { applyDeclaration, previewDeclaration, reconcileDeclaredEdges } from './import.ts'
export type { DeclarationPreviewOptions } from './import.ts'
export { MEDIUM_TIER_NOTE, STALE_ACTION, STALE_CAVEAT, STALE_REASON, checkDeclarationDrift } from './declaration-drift.ts'
export type {
  ConsistentEntry,
  DeclarationDriftInput,
  DeclarationDriftInputStatus,
  DeclarationDriftResult,
  DeclarationDriftStatus,
  DriftCounts,
  DriftDeclarationShape,
  DriftEntryBase,
  MediumConfidenceEntry,
  StaleDeclaredEntry,
  UndeclaredEntry,
} from './declaration-drift.ts'

export interface Config {
  /** Directory that holds <group>.json topology files. @default ~/.helmsman/topologies */
  rootDir?: string
}

export interface TopologyService {
  listGroups(): Promise<string[]>
  loadTopology(group: string): Promise<ProjectTopology | null>
  saveTopology(topology: ProjectTopology): Promise<void>
  deleteGroup(group: string): Promise<boolean>
  createGroup(group: string, name?: string): Promise<ProjectTopology>
  scanMavenParent(pomPath: string): Promise<ReturnType<typeof scanMavenPom>>
  scanRestApis(localPath: string): Promise<ApiEndpoint[]>
  getDownstream(group: string, serviceId: string): Promise<DownstreamReport>
  cascadeOrder(group: string, serviceIds: string[]): Promise<string[]>
  /**
   * Graph-level health check (design D3) — cycles with their members, edges
   * pointing at undeclared services, isolated services. Read-only and additive:
   * `loadTopology`'s return shape is unchanged.
   */
  checkHealth(group: string): Promise<GraphHealth>
  /**
   * Derives dependency candidates from a service's outbound calls
   * (`derive-dependencies-from-calls`). READ-ONLY: it scans local trees, never
   * touches the topology file and never issues a network request. Confirmation
   * is a separate action (`applyCandidates`).
   */
  deriveDependencies(group: string, opts?: DeriveOptions): Promise<DeriveResult & { group: string }>
  /**
   * Confirms candidates (one or many) by writing them through the SAME persist
   * path as `saveTopology`, so the "one edge per (from, to) pair" invariant holds
   * for this writer too and confirming an existing pair merges detail instead of
   * adding a row. A candidate whose target is undeclared can register the service
   * in the same action (`register: true`) so the confirmed edge does not
   * immediately become a `dangling` health finding.
   */
  applyCandidates(group: string, candidates: ApplyCandidateInput[]): Promise<ApplyCandidatesResult>
  exportYaml(group: string): Promise<string>
  importPreview(source: ImportPreview['source'], text: string, inferDeps?: boolean): Promise<ImportPreview>
  importApply(group: string, preview: ImportPreview): Promise<ProjectTopology>
  /**
   * Ingests a repository's own declaration (`declare-dependencies-in-repo`,
   * `<repo>/.helmsman/dependencies.yml`) for ONE service. READ-ONLY: it reads the
   * file and returns it in the existing `ImportPreview` shape so the human
   * verifies it in the existing preview/apply UI; nothing is persisted here.
   *
   * `status: 'missing'` means the repo has no declaration — the explicit
   * 「未声明依赖」 result, NOT an error. `status: 'invalid'` carries the concrete
   * problems and a null preview (never a partial application).
   */
  declarationPreview(group: string, service?: string): Promise<DeclarationPreviewResult>
  /**
   * Renders what a service's declaration file WOULD say (declared edges only —
   * derived edges are never frozen into a repository) plus its target path and a
   * "commit this to the repo" hint. Performs NO git operation and writes nothing.
   */
  declarationRender(group: string, service: string): Promise<DeclarationRenderResult>
  /**
   * Declaration drift check (`detect-declaration-drift`): compares the
   * declaration the repository carries (`<repo>/.helmsman/dependencies.yml`) with
   * the evidence the code scanner finds for the same service, keyed by the
   * (from, to) service pair. READ-ONLY: it reads one declaration file and scans
   * local trees; neither the declaration file nor the topology is written, and no
   * edge is added or removed. Handling a finding means navigating into the
   * EXISTING candidate-confirmation flow (`applyCandidates`).
   *
   * `status: 'no-declaration'` (no declaration file) is the explicit starting
   * point, NOT an error: every code-evidence pair is listed as undeclared and the
   * message guides the user towards writing a baseline. `status:
   * 'invalid-declaration'` reports the parse problems and issues NO verdict.
   */
  checkDeclarationDrift(group: string, service?: string): Promise<DeclarationDriftResult & { group: string }>
}

/** Result of `declarationPreview` (see `readDeclaration` for the status semantics). */
export interface DeclarationPreviewResult {
  group: string
  /** Service the ingest was requested for (the group may not declare it yet). */
  service: string
  /** Absolute declaration path, or null when the service has no localPath. */
  file: string | null
  status: 'ok' | 'missing' | 'invalid' | 'no-repo-path'
  /** Existing `ImportPreview` shape; null unless `status === 'ok'`. */
  preview: ImportPreview | null
  errors: string[]
  warnings: string[]
  /** Targets the file references that are not registered in the group (design D5). */
  undeclaredTargets: string[]
}

/** Result of `declarationRender` (write-back draft; no file is written). */
export interface DeclarationRenderResult {
  group: string
  service: string
  /** `<localPath>/.helmsman/dependencies.yml`, or null without a localPath. */
  file: string | null
  /** The rendered YAML (round-trips through `parseDeclaration`). */
  content: string
  /** Number of `declared` edges rendered. */
  declared: number
  /** `derived` edges deliberately left out of the file. */
  derived: number
  hint: string
}

/** One candidate as confirmed by a human (see `deriveDependencies`). */
export interface ApplyCandidateInput {
  from: string
  to: string
  /** Endpoint detail to merge into the pair's edge (optional → service-level edge). */
  endpoints?: string[]
  /** HTTP method of `endpoints`; ignored when `endpoints` is empty. */
  method?: string
  /** Register `to` as a service when it is not declared yet (「登记并确认」). */
  register?: boolean
  critical?: boolean
}

export interface ApplyCandidatesResult {
  group: string
  /** The topology as persisted (SPA puts it straight back into its state). */
  topology: ProjectTopology
  applied: number
  /** Service ids newly registered by this confirmation. */
  registered: string[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    'helmsman.topology': TopologyService
  }
}

export function apply(ctx: Context, config: Config = {}) {
  const store = new TopologyStore({ rootDir: config.rootDir })

  /**
   * The ONE persist chokepoint (design D2 of `simplify-service-dependencies`):
   * normalize the shape, enforce "one edge per (from, to) pair", write, mirror.
   * Every writer — the config page, imports and confirmed derivation candidates —
   * goes through it, so the invariant holds for all of them.
   */
  const persist = async (topology: ProjectTopology): Promise<ProjectTopology> => {
    const normalized = dedupeDependencies(normalizeTopology(topology))
    await store.save(normalized)
    await mirrorToMemoryManager(ctx, normalized)
    return normalized
  }

  const service: TopologyService = {
    async listGroups() {
      return await store.listGroups()
    },

    async loadTopology(group) {
      return await store.load(group)
    },

    async saveTopology(topology) {
      await persist(topology)
    },

    async deleteGroup(group) {
      return await store.delete(group)
    },

    async createGroup(group, name) {
      const existing = await store.load(group)
      if (existing) return existing
      const topology = emptyTopology(group, name ?? group)
      await store.save(topology)
      return topology
    },

    async scanMavenParent(pomPath) {
      const abs = resolve(pomPath)
      const xml = await readFile(abs, 'utf8')
      return scanMavenPom(abs, xml)
    },

    async scanRestApis(localPath) {
      return await scanRestApis(resolve(localPath))
    },

    async getDownstream(group, serviceId) {
      const topology = await store.load(group)
      if (!topology) throw new Error(`unknown project group: ${group}`)
      return computeDownstream(topology, serviceId)
    },

    async cascadeOrder(group, serviceIds) {
      const topology = await store.load(group)
      if (!topology) throw new Error(`unknown project group: ${group}`)
      return cascadeOrder(topology, serviceIds)
    },

    async checkHealth(group) {
      const topology = await store.load(group)
      if (!topology) throw new Error(`unknown project group: ${group}`)
      return checkGraph(topology)
    },

    async deriveDependencies(group, opts) {
      const topology = await store.load(group)
      if (!topology) throw new Error(`unknown project group: ${group}`)
      // Read-only by construction: the derivation only READS local trees and the
      // loaded topology; nothing here touches the store.
      const result = await deriveFromTopology(topology, opts)
      return { group, ...result }
    },

    async applyCandidates(group, candidates) {
      const topology = await store.load(group)
      if (!topology) throw new Error(`unknown project group: ${group}`)
      const services: Record<string, ServiceNode> = { ...topology.services }
      const restDependencies: Record<string, RestDependencyEdge[]> = { ...topology.restDependencies }
      const registered: string[] = []
      let applied = 0

      for (const candidate of candidates ?? []) {
        const from = String(candidate?.from ?? '').trim()
        const to = String(candidate?.to ?? '').trim()
        if (!from || !to) throw new Error('candidate requires both from and to')
        if (!services[from]) throw new Error(`candidate source is not a registered service: ${from}`)
        if (from === to) continue // never write a self edge
        const endpoints = Array.isArray(candidate.endpoints) ? candidate.endpoints.map(String).filter((p) => p.trim() !== '') : []
        if (candidate.register === true && !services[to]) {
          services[to] = { name: to, projectId: to, techStack: [], apiEndpoints: [] }
          registered.push(to)
        }
        const method = typeof candidate.method === 'string' && candidate.method.trim() !== '' ? candidate.method : undefined
        const incoming: RestDependencyEdge =
          endpoints.length > 0
            ? { toServiceId: to, endpoints, method: method ?? 'GET', ...(candidate.critical === true ? { critical: true } : {}) }
            : { toServiceId: to, endpoints: [], method: SERVICE_LEVEL_METHOD, ...(candidate.critical === true ? { critical: true } : {}) }
        // Same pair-merge semantics as the config page / imports: an existing edge
        // absorbs the detail, a new pair gets exactly one row.
        const edges = restDependencies[from] ?? []
        const at = edges.findIndex((edge) => edge.toServiceId === to)
        restDependencies[from] =
          at >= 0
            ? [...edges.slice(0, at), mergeDependencyEdge(edges[at]!, incoming), ...edges.slice(at + 1)]
            : [...edges, incoming]
        applied += 1
      }

      const saved = await persist({ ...topology, services, restDependencies })
      return { group, topology: saved, applied, registered }
    },

    async exportYaml(group) {
      const topology = await store.load(group)
      if (!topology) throw new Error(`unknown project group: ${group}`)
      return exportTopologyYaml(topology)
    },

    async importPreview(source, text, inferDeps) {
      switch (source) {
        case 'docker-compose':
          return previewCompose(text, { inferDependencies: inferDeps })
        case 'kubernetes':
          return previewKubernetes(text)
        case 'openapi':
          return previewOpenApi(text)
        case 'helmsman-declaration': {
          // Text-only path (no group context): the file names its own service, and
          // declared-ness of its targets cannot be judged here — no undeclared
          // claim is made. The route-level flow (`declarationPreview`) knows the
          // group and marks them. An unparseable file yields a preview with the
          // problems and NO dependencies (never a partial application).
          const parsed = parseDeclaration(text)
          if (!parsed.ok) {
            return {
              source: 'helmsman-declaration',
              services: [],
              dependencies: [],
              warnings: parsed.errors,
            } satisfies ImportPreview
          }
          return previewDeclaration(parsed.service, parsed.edges, { warnings: parsed.warnings })
        }
      }
    },

    async importApply(group, preview) {
      const existing = await store.load(group)
      const topology = existing ?? emptyTopology(group, group)
      if (preview?.source === 'helmsman-declaration') {
        // Design D4: declared edges follow the file (added/removed), derived edges
        // are left untouched — then the SAME dedupe/persist path as every import.
        const reconciled = applyDeclaration(topology, preview)
        const deduped = dedupeDependencies(reconciled)
        await store.save(deduped)
        return deduped
      }
      applyPreview(topology, preview)
      // Same invariant as saveTopology: an import that lands on legacy duplicate
      // pairs cleans them up too, and the returned topology matches what is on
      // disk (the SPA puts it straight back into its state).
      const deduped = dedupeDependencies(topology)
      await store.save(deduped)
      return deduped
    },

    async declarationPreview(group, service) {
      const topology = await store.load(group)
      if (!topology) throw new Error(`unknown project group: ${group}`)
      const serviceId = String(service ?? '').trim() || firstServiceWithRepoPath(topology)
      if (!serviceId) throw new Error('该项目群还没有任何服务，无法读取仓库声明')
      const node = topology.services[serviceId]
      if (!node) throw new Error(`service not found in group: ${serviceId}`)
      const localPath = typeof node.localPath === 'string' ? node.localPath.trim() : ''
      if (!localPath) {
        return {
          group,
          service: serviceId,
          file: null,
          status: 'no-repo-path',
          preview: null,
          errors: [`服务 ${serviceId} 未配置本地路径（localPath），无法读取仓库声明`],
          warnings: [],
          undeclaredTargets: [],
        }
      }

      const read = await readDeclaration(localPath)
      if (read.status !== 'ok' || !read.service) {
        // Missing file is the explicit "not declared" result; a corrupt file
        // reports its problems and yields NO preview (nothing can be applied).
        return {
          group,
          service: serviceId,
          file: read.file,
          status: read.status === 'ok' ? 'invalid' : read.status,
          preview: null,
          errors: read.errors,
          warnings: read.warnings,
          undeclaredTargets: [],
        }
      }

      const warnings = [...read.warnings]
      // The file names its own service (design D1: `service` is the `from` of every
      // edge). A mismatch with the picked service is reported, and the file wins —
      // otherwise edges would land on a service the repo never declared.
      if (read.service !== serviceId) {
        warnings.push(`声明文件里的 service 是 ${read.service}，与所选服务 ${serviceId} 不一致：应用时会写 ${read.service} 的依赖`)
      }
      const preview = previewDeclaration(read.service, read.edges, {
        registered: Object.keys(topology.services),
        file: read.file,
        warnings,
      })
      return {
        group,
        service: serviceId,
        file: read.file,
        status: 'ok',
        preview,
        errors: [],
        warnings,
        undeclaredTargets: preview.undeclaredTargets ?? [],
      }
    },

    async declarationRender(group, service) {
      const topology = await store.load(group)
      if (!topology) throw new Error(`unknown project group: ${group}`)
      const serviceId = String(service ?? '').trim()
      if (!serviceId) throw new Error('service is required')
      const node = topology.services[serviceId]
      if (!node) throw new Error(`service not found in group: ${serviceId}`)
      const edges = topology.restDependencies[serviceId] ?? []
      const declared = edges.filter((edge) => edgeSource(edge) === 'declared')
      const localPath = typeof node.localPath === 'string' ? node.localPath.trim() : ''
      const file = localPath ? declarationPathFor(localPath) : null
      const derived = edges.length - declared.length
      return {
        group,
        service: serviceId,
        file,
        content: renderDeclaration(serviceId, declared),
        declared: declared.length,
        derived,
        hint: file
          ? `建议把内容写入 ${DECLARATION_RELATIVE_PATH} 并随代码提交（Helmsman 不执行任何 git 操作）。`
          : `该服务未配置本地路径，无法给出目标文件路径；仓库内位置固定为 ${DECLARATION_RELATIVE_PATH}。`,
      }
    },

    async checkDeclarationDrift(group, service) {
      const topology = await store.load(group)
      if (!topology) throw new Error(`unknown project group: ${group}`)
      const serviceId = String(service ?? '').trim() || firstServiceWithRepoPath(topology)
      if (!serviceId) throw new Error('该项目群还没有任何服务，无法核对声明漂移')
      const node = topology.services[serviceId]
      if (!node) throw new Error(`service not found in group: ${serviceId}`)
      const localPath = typeof node.localPath === 'string' ? node.localPath.trim() : ''

      // No working copy: the declaration cannot be read and the code cannot be
      // scanned, so the honest result is "nothing was compared" — never an empty
      // drift list that reads like "everything agrees".
      if (!localPath) {
        return {
          group,
          ...checkDeclarationDrift({
            service: serviceId,
            declaration: {
              status: 'no-repo-path',
              file: null,
              edges: [],
              errors: [`服务 ${serviceId} 未配置本地路径（localPath），无法读取声明或扫描代码`],
            },
          }),
        }
      }

      const read: DeclarationReadResult = await readDeclaration(localPath)
      // A corrupt file must not turn into an "everything is undeclared" verdict,
      // so the code side is not even scanned in that case (design D2 honesty).
      if (read.status === 'invalid') {
        return { group, ...checkDeclarationDrift({ service: serviceId, declaration: read, candidates: [] }) }
      }

      // Read-only by construction: the derivation only READS local trees plus the
      // already-loaded topology, and nothing in this path touches the store.
      const derived = await deriveFromTopology(topology, { serviceIds: [serviceId] })
      return {
        group,
        ...checkDeclarationDrift({
          service: serviceId,
          declaration: read,
          candidates: derived.candidates,
          registeredServices: Object.keys(topology.services),
          scanned: derived.scanned,
          skipped: derived.skipped,
          scannedAt: derived.scannedAt,
        }),
      }
    },
  }

  ctx.provide('helmsman.topology', service)

  registerTools(ctx, service)
  console.log(`[helmsman/memory-topology] service ready (root: ${store.rootDir})`)
}

/** First service that has a working copy to read a declaration from. */
function firstServiceWithRepoPath(topology: ProjectTopology): string {
  for (const [id, svc] of Object.entries(topology.services)) {
    if (typeof svc.localPath === 'string' && svc.localPath.trim() !== '') return id
  }
  return ''
}

function registerTools(ctx: Context, service: TopologyService): void {
  ctx.tools.register(
    defineTool({
      name: 'helmsman_topology_get_downstream',
      description: 'Query the REST dependency graph of a Helmsman project group: who does a service call, who calls it, and the transitive cascade order.',
      parameters: {
        projectGroupId: { type: 'string', required: true, description: 'Project group id, e.g. "订单中台".' },
        serviceId: { type: 'string', required: true, description: 'Service id within the group.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args) {
        const report = await service.getDownstream(args.projectGroupId, args.serviceId)
        return JSON.parse(JSON.stringify(report))
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'helmsman_topology_scan_rest_apis',
      description: 'Scan a local repository for REST API endpoints (Spring/NestJS/Express) and return the discovered endpoint list.',
      parameters: {
        localPath: { type: 'string', required: true, description: 'Absolute path of the repository working copy to scan.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute(args) {
        const endpoints = await service.scanRestApis(args.localPath)
        return JSON.parse(JSON.stringify({ total: endpoints.length, endpoints }))
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'helmsman_topology_list_groups',
      description: 'List all Helmsman project groups known to the topology memory.',
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute() {
        return { groups: await service.listGroups() }
      },
    }),
  )
}

/** Best-effort mirror into dsh-memory-manager (Typert remote service). */
async function mirrorToMemoryManager(ctx: Context, topology: ProjectTopology): Promise<void> {
  try {
    const mm = ctx.get('memoryManager') as
      | { create?: (req: { name: string; description?: string; type?: string; project?: string; body?: string }) => Promise<unknown> }
      | undefined
    if (!mm?.create) return
    const body = exportTopologyYaml(topology)
    await mm.create({
      name: `topology-${topology.projectGroupId}`,
      description: `Helmsman 项目拓扑快照：${topology.name}（${Object.keys(topology.services).length} 个服务）`,
      type: 'project',
      project: 'global',
      body,
    })
  } catch (err) {
    console.warn('[helmsman/memory-topology] memoryManager mirror failed:', err instanceof Error ? err.message : err)
  }
}

/** PRD §4.7.7 export format. */
export function exportTopologyYaml(t: ProjectTopology): string {
  const doc: Record<string, unknown> = {
    projectGroup: {
      name: t.name,
      description: t.description,
      defaultBranch: t.defaultBranch,
    },
    services: Object.entries(t.services).map(([id, s]) => ({
      id,
      name: s.name,
      ...(s.localPath ? { localPath: s.localPath } : {}),
      type: t.projects[s.projectId]?.type ?? 'other',
      ...(s.techStack.length > 0 ? { techStack: s.techStack } : {}),
    })),
    restDependencies: Object.entries(t.restDependencies).flatMap(([from, edges]) =>
      edges.map((e) => ({
        from,
        to: e.toServiceId,
        ...(e.endpoints.length > 0 ? { endpoints: e.endpoints } : {}),
        method: e.method,
        ...(e.critical === true ? { critical: true } : {}),
        // Provenance is explicit only for `derived` (absent = `declared`).
        ...(edgeSource(e) === 'derived' ? { source: 'derived' } : {}),
      })),
    ),
    mavenParents: Object.entries(t.mavenParents).map(([id, m]) => ({
      id,
      path: m.pomPath,
      children: m.children,
    })),
  }
  return toYaml(doc)
}
