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
import { scanMavenPom } from './scan-maven.ts'
import { scanRestApis } from './scan-rest.ts'
import { makeImportedTopology, previewCompose, previewKubernetes, previewOpenApi, applyPreview, type ImportPreview } from './import.ts'
import { toYaml } from './yaml.ts'
import { emptyTopology, normalizeTopology, type ApiEndpoint, type DownstreamReport, type ProjectTopology } from './types.ts'

export const name = '@helmsman/memory-topology'
export const inject = [] as const

export type {
  ApiEndpoint,
  DownstreamEdge,
  DownstreamReport,
  MavenParentNode,
  ProjectNode,
  ProjectTopology,
  ProjectType,
  RestDependencyEdge,
  ServiceNode,
} from './types.ts'
export { emptyTopology, normalizeTopology } from './types.ts'

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
  exportYaml(group: string): Promise<string>
  importPreview(source: ImportPreview['source'], text: string, inferDeps?: boolean): Promise<ImportPreview>
  importApply(group: string, preview: ImportPreview): Promise<ProjectTopology>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    'helmsman.topology': TopologyService
  }
}

export function apply(ctx: Context, config: Config = {}) {
  const store = new TopologyStore({ rootDir: config.rootDir })

  const service: TopologyService = {
    async listGroups() {
      return await store.listGroups()
    },

    async loadTopology(group) {
      return await store.load(group)
    },

    async saveTopology(topology) {
      const normalized = normalizeTopology(topology)
      await store.save(normalized)
      await mirrorToMemoryManager(ctx, normalized)
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
      }
    },

    async importApply(group, preview) {
      const existing = await store.load(group)
      const topology = existing ?? emptyTopology(group, group)
      applyPreview(topology, preview)
      await store.save(topology)
      return topology
    },
  }

  ctx.provide('helmsman.topology', service)

  registerTools(ctx, service)
  console.log(`[helmsman/memory-topology] service ready (root: ${store.rootDir})`)
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
