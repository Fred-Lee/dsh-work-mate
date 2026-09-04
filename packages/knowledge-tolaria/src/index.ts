/**
 * @helmsman/knowledge-tolaria — DSH plugin entry.
 *
 * L4 knowledge layer: an archived-note vault under `~/.helmsman/vault`
 * (markdown + frontmatter, git-init), retrieval, and the project knowledge
 * graph. It is the ONLY layer that reads/writes the vault; the workbench panel
 * calls this service. Draft/working content stays in Helmsman's local store and
 * never enters the vault (PRD §4.4) — we archive only what the user confirms.
 *
 * Topology (services/deps) is an OPTIONAL runtime dependency on
 * `helmsman.topology` (memory-topology): we lazily `ctx.get` it inside
 * buildGraph so this plugin is usable even when memory-topology is absent.
 */
import type { Context } from '@deepseek-ai/cordis'
import { VaultStore, defaultVaultDir } from './vault.ts'
import { buildGraph } from './graph.ts'
import type { GraphData, Note, NoteKind, NoteMeta, SearchHit, TopologyGraphInput } from './types.ts'

export const name = '@helmsman/knowledge-tolaria'
export const inject = [] as const

export type { Note, NoteKind, NoteMeta, SearchHit, GraphData } from './types.ts'

export interface Config {
  /** Vault root directory. @default ~/.helmsman/vault */
  rootDir?: string
  /** @default true */
  gitInit?: boolean
}

export interface KnowledgeService {
  archive(note: Note): Promise<{ id: string; path: string }>
  list(kind?: NoteKind): Promise<NoteMeta[]>
  get(id: string): Promise<Note | null>
  search(query: string, opts?: { kinds?: NoteKind[] }): Promise<SearchHit[]>
  buildGraph(scope?: { projectGroupId?: string }): Promise<GraphData>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    'helmsman.knowledge': KnowledgeService
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  const store = new VaultStore({
    rootDir: config.rootDir ?? defaultVaultDir(),
    gitInit: config.gitInit ?? true,
  })

  const service: KnowledgeService = {
    archive: (note) => store.archive(note),
    list: (kind) => store.list(kind),
    get: (id) => store.get(id),
    search: (query, opts) => store.search(query, opts),
    buildGraph: async (scope) => {
      const topology = await loadTopologySlice(ctx, scope?.projectGroupId)
      const documents = await store.list()
      return buildGraph({ topology, documents })
    },
  }

  ctx.provide('helmsman.knowledge', service)
  console.log(`[helmsman/knowledge-tolaria] vault ready (root: ${store.rootDir})`)
}

/** Structural slice from memory-topology (async, optional, best-effort). */
async function loadTopologySlice(ctx: Context, projectGroupId?: string): Promise<TopologyGraphInput | null> {
  if (!projectGroupId) return null
  try {
    const topology = ctx.get('helmsman.topology') as
      | {
          loadTopology?: (group: string) => Promise<{
            services: Record<string, { name: string }>
            restDependencies: Record<string, Array<{ toServiceId: string; critical?: boolean }>>
          } | null>
        }
      | undefined
    if (!topology?.loadTopology) return null
    const loaded = await topology.loadTopology(projectGroupId)
    if (!loaded) return null
    return {
      services: Object.entries(loaded.services).map(([id, svc]) => ({ id, name: svc.name })),
      dependencies: Object.entries(loaded.restDependencies).flatMap(([from, edges]) =>
        edges.map((e) => ({ from, to: e.toServiceId, critical: e.critical })),
      ),
    }
  } catch {
    return null
  }
}
