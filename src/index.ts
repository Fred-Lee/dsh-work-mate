/**
 * workmate4dsh — DSH plugin entry.
 *
 * Change-proposal-centric bundle (design: docs/DESIGN.md): proposal management
 * + OpenSpec directory generation + Git association + REST/SPA panel (M2),
 * knowledge bridging (M3), archive orchestration over swarm/openspec/gitnexus
 * (M4), knowledge-graph view (M5).
 *
 * Integration surfaces, all in the host-verified shapes (design D1 of
 * `add-proposal-middleware`):
 *   - `tools`   → ctx.tools.register(defineTool(...))   — orchestrator-proven
 *   - `webServer` → prefix route /workmate/ (REST + static SPA) — ui-*-proven
 *   - client half (dist/client/client.js) → better-sidebar tab — workbench-proven
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type InferValue, type JsonValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'
import { resolveConfig, type Config } from './config.ts'
import { ProposalStore } from './features/proposal/store.ts'
import { ProposalServiceImpl, type ProposalService } from './features/proposal/service.ts'
import { ArchiveServiceImpl } from './features/archive/service.ts'
import { orchestrateArchive, orchestrateReopen } from './features/archive/orchestrate.ts'
import { ProjectRegistry } from './features/project/registry.ts'
import { buildProposalStatus } from './features/proposal/status.ts'
import { gitnexusRun } from './features/knowledge-bridge/gitnexus.ts'
import { createWeknoraClient } from './features/knowledge-bridge/weknora.ts'
import { mountWorkmateApi, createProposal } from './api.ts'
export const name = 'workmate'
/** `tools`: agent tool registration. `webServer`: REST + panel mount. */
export const inject = ['tools', 'webServer'] as const

export type { Config, ResolvedConfig } from './config.ts'
export { CONFIG_DEFAULTS, resolveConfig } from './config.ts'
export type { Proposal, ProposalStoreOptions } from './features/proposal/store.ts'
export { ProjectRegistry } from './features/project/registry.ts'
export type { RegisteredProject } from './features/project/registry.ts'
export { ProposalStore, resolveDshHome, StoreCorruptError } from './features/proposal/store.ts'
export type { ProposalService, UpsertProposalInput } from './features/proposal/service.ts'
export { ProposalServiceImpl } from './features/proposal/service.ts'
export { ArchiveServiceImpl, InvalidTransitionError } from './features/archive/service.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    'workmate.proposal': ProposalService
    'workmate.archive': ArchiveServiceImpl
    'workmate.projects': ProjectRegistry
  }
}

/** Tool bodies must return canonical JSON; optional fields collapse to absent. */
type ToolJson = InferValue<JsonValueSchemaSpec>
const asJson = (value: unknown): ToolJson => JSON.parse(JSON.stringify(value)) as ToolJson

export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  const store = new ProposalStore({ subdir: resolved.workmateHome })
  const proposals = new ProposalServiceImpl(store)
  const registry = new ProjectRegistry({ subdir: resolved.workmateHome })
  const archive = new ArchiveServiceImpl({
    proposals,
    async resolveProjectRoots(proposal) {
      const targets: Array<{ project: string; root: string }> = []
      for (const name of proposal.projects) {
        const registered = await registry.get(name)
        if (registered !== undefined) targets.push({ project: name, root: registered.root })
      }
      return targets
    },
    async changeDirExists(projectRoot, openspecRoot, changeId) {
      const state = await import('./features/proposal/openspec.ts')
      const result = await state.readChangeState(projectRoot, openspecRoot, changeId)
      return result.state !== 'missing'
    },
    async orchestrate(proposal, targets, opts) {
      return orchestrateArchive(proposal, targets, {
        openspecRoot: opts.openspecRoot,
        gitnexusAnalyzeEnabled: resolved.gitnexusEnabled,
      })
    },
    async orchestrateReopen(proposal, targets, opts) {
      return orchestrateReopen(proposal, targets, { openspecRoot: opts.openspecRoot })
    },
  })

  // Eager best-effort read: a corrupt proposals.json must surface at boot,
  // but it must not take the whole profile down (board warmUp lesson).
  void proposals
    .list()
    .then(
      () => console.log(`[workmate] service ready (root: ${store.rootDir})`),
      (error: unknown) =>
        console.error(
          `[workmate] proposals store unreadable: ${error instanceof Error ? error.message : String(error)}`,
        ),
    )

  ctx.provide('workmate.proposal', proposals)
  ctx.provide('workmate.archive', archive)
  ctx.provide('workmate.projects', registry)

  registerTools(ctx, { proposals, archive, registry, resolved })
  mountWorkmateApi(
    ctx.get('webServer') as Parameters<typeof mountWorkmateApi>[0],
    {
      proposals,
      archive,
      registry,
      openspecRoot: resolved.openspecRoot,
      projectRoot: resolved.projectRoot,
    },
  )
}

interface ToolDeps {
  proposals: ProposalService
  archive: ArchiveServiceImpl
  registry: ProjectRegistry
  resolved: ReturnType<typeof resolveConfig>
}

function registerTools(ctx: Context, deps: ToolDeps): void {
  const { proposals, archive, registry, resolved } = deps

  ctx.tools.register(
    defineTool({
      name: 'workmate_proposal_create',
      description:
        'Create a WorkMate change proposal. Persists it under the DSH home and, when a project root is resolvable, seeds the standard OpenSpec change directory (proposal.md / design.md / tasks.md) without overwriting an existing one.',
      parameters: {
        id: { type: 'string', required: true, description: 'Slug id, e.g. "batch-grading-v2".' },
        title: { type: 'string', required: true, description: 'Human-readable title.' },
        projects: { type: 'string', description: 'Comma-separated project identifiers to associate.' },
        projectRoot: { type: 'string', description: 'Absolute project root; falls back to Config.projectRoot.' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
      async execute(args) {
        const projects = args.projects?.split(',').map((p) => p.trim()).filter(Boolean)
        const result = await createProposal(
          { proposals, archive, registry, openspecRoot: resolved.openspecRoot, projectRoot: resolved.projectRoot },
          {
            id: args.id,
            title: args.title,
            ...(projects !== undefined && projects.length > 0 ? { projects } : {}),
            ...(args.projectRoot !== undefined ? { projectRoot: args.projectRoot } : {}),
          },
        )
        return asJson(result)
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'workmate_proposal_status',
      description:
        'Fetch a WorkMate proposal: record, associated git commits (commits mentioning [proposal:<id>]) and OpenSpec change state (active/archived/missing + tasks.md progress).',
      parameters: {
        id: { type: 'string', required: true, description: 'Proposal id.' },
        projectRoot: { type: 'string', description: 'Absolute project root; falls back to Config.projectRoot.' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
      async execute(args) {
        return asJson(
          await buildProposalStatus(proposals, args.id, {
            projectRoot: args.projectRoot ?? (resolved.projectRoot || undefined),
            openspecRoot: resolved.openspecRoot,
          }),
        )
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'workmate_proposal_archive',
      description:
        'Advance a proposal along draft → executing → archived. Use workmate_proposal_status first; draft proposals cannot be archived directly, and a missing OpenSpec change directory requires force: true.',
      parameters: {
        id: { type: 'string', required: true, description: 'Proposal id.' },
        mode: { type: 'string', description: 'Lifecycle direction: archive (default) | start | reopen | stop — the full reversible set.' },
        start: { type: 'boolean', description: 'Legacy shorthand for mode=start (draft → executing).' },
        force: { type: 'boolean', description: 'Archive even when the OpenSpec change directory is missing.' },
        projectRoot: { type: 'string', description: 'Absolute project root; falls back to Config.projectRoot.' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
      async execute(args) {
        const mode = args.mode ?? (args.start === true ? 'start' : 'archive')
        if (mode === 'start') {
          const proposal = await archive.start(args.id)
          return asJson({ proposal, note: 'proposal moved to executing' })
        }
        if (mode === 'stop') {
          const proposal = await archive.stop(args.id)
          return asJson({ proposal, note: 'proposal moved back to draft' })
        }
        if (mode === 'reopen') {
          const reopened = await archive.reopen(args.id, { openspecRoot: resolved.openspecRoot })
          return asJson({ proposal: reopened, orchestration: reopened.orchestration })
        }
        const proposal = await archive.archive(args.id, {
          openspecRoot: resolved.openspecRoot,
          projectRoot: args.projectRoot ?? (resolved.projectRoot || undefined),
          force: args.force,
        })
        return asJson({ proposal })
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'workmate_knowledge_query',
      description:
        'Query the GitNexus code knowledge graph of a project (must be gitnexus-analyzed): action "query" finds execution flows for a concept, "context" gives a 360-degree view of a symbol, "impact" reports the blast radius of changing a symbol.',
      parameters: {
        action: { type: 'string', required: true, description: 'One of: query | context | impact.' },
        target: { type: 'string', required: true, description: 'Search concept or symbol name.' },
        projectRoot: { type: 'string', required: true, description: 'Absolute project root (the indexed repository).' },
        context: { type: 'string', description: 'Extra ranking context for action=query.' },
        direction: { type: 'string', description: 'upstream | downstream, for action=impact (default upstream).' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
      async execute(args) {
        if (!resolved.gitnexusEnabled) {
          return asJson({ output: '', note: 'gitnexus bridge disabled by config (gitnexusEnabled: false)' })
        }
        const direction = args.direction === 'downstream' ? 'downstream' : 'upstream'
        const result = await gitnexusRun(
          args.action === 'context' ? 'context' : args.action === 'impact' ? 'impact' : 'query',
          args.projectRoot,
          {
            target: args.target,
            ...(args.context !== undefined ? { context: args.context } : {}),
            ...(args.action === 'impact' ? { direction } : {}),
          },
        )
        return asJson(result)
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'workmate_knowledge_search',
      description:
        'Search the WeKnora document knowledge base for passages relevant to a query (Top-3). Requires Config.weknoraBaseUrl; returns a disabling note when unconfigured.',
      parameters: {
        query: { type: 'string', required: true, description: 'Natural-language query.' },
        projectRoot: { type: 'string', required: true, description: 'Absolute project root.' },
        topK: { type: 'integer', description: 'Max fragments (default 3).' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
      async execute(args) {
        if (resolved.weknoraBaseUrl === '') {
          return asJson({ fragments: [], note: 'weknora bridge disabled — Config.weknoraBaseUrl is empty' })
        }
        const client = createWeknoraClient(resolved.weknoraBaseUrl)
        return asJson(await client.search(args.projectRoot, args.query, args.topK ?? 3))
      },
    }),
  )

  console.log('[workmate] tools registered (proposal_create/status/archive + knowledge_query/knowledge_search)')
}
