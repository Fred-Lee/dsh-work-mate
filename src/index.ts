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
 *   - `tools`   → ctx.tools.register(defineTool(...))   — hard dep (every profile)
 *   - `webServer` → prefix route /workmate/ (REST + panel) — OPTIONAL, mounted
 *     through reactive `ctx.inject` (only the web-app bundle provides it)
 *   - client half (dist/client/client.js) → better-sidebar tab + two chat
 *     entries — every registration lazily injected, zero hard dependency
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type InferValue, type JsonValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'
import { resolveConfig, type Config } from './config.ts'
import type { Proposal } from './features/proposal/store.ts'
import type { OrchestrationTarget } from './features/archive/orchestrate.ts'
import { ProposalStore } from './features/proposal/store.ts'
import { join } from 'node:path'
import { EventLog } from './features/proposal/events.ts'
import { METRICS_SOURCE, evaluateBands, loadBands } from './features/metrics/bands.ts'
import type { ProposalSource } from './features/proposal/store.ts'
import { aggregateMetrics, proposalMetrics } from './features/proposal/metrics.ts'
import { ProposalServiceImpl, type ProposalService } from './features/proposal/service.ts'
import { LifecycleServiceImpl } from './features/archive/service.ts'
import { WorktreeManager } from './features/worktree/manager.ts'
import { linkWikiToProposal, listWikiLinks } from './features/wiki/links.ts'
import { STATE_HINTS, type ProposalState } from './features/proposal/state-machine.ts'

const nextStepHint = (status: string): string => STATE_HINTS[status as keyof typeof STATE_HINTS] ?? ''
import { orchestrateArchive, orchestrateReopen } from './features/archive/orchestrate.ts'
import { ProjectRegistry } from './features/project/registry.ts'
import { buildProposalStatus } from './features/proposal/status.ts'
import { gitnexusRun } from './features/knowledge-bridge/gitnexus.ts'
import { createWeknoraClient } from './features/knowledge-bridge/weknora.ts'
import { mountWorkmateApi, createProposal, type WebServerLike } from './api.ts'
import { registerGuidance } from './features/guidance/index.ts'
export const name = 'workmate'
/**
 * Only services every profile provides. `webServer` belongs to the web-app
 * bundle alone, so it is mounted through reactive `ctx.inject` below — a hard
 * dependency here would park this fiber (and with it every agent tool) in
 * headless / acp / sdk profiles.
 */
export const inject = ['tools'] as const

/**
 * `Config` is re-exported with both meanings: the TypeScript interface (host
 * contract type) and the runtime Schemastery schema the host collects. Without
 * the runtime value the plugin gets no config validation and no config-UI row.
 */
export { Config, CONFIG_DEFAULTS, resolveConfig } from './config.ts'
export type { ResolvedConfig } from './config.ts'
export type { Proposal, ProposalStoreOptions } from './features/proposal/store.ts'
export { ProjectRegistry } from './features/project/registry.ts'
export type { RegisteredProject } from './features/project/registry.ts'
export { ProposalStore, resolveDshHome, StoreCorruptError } from './features/proposal/store.ts'
export type { ProposalService, UpsertProposalInput } from './features/proposal/service.ts'
export { ProposalServiceImpl } from './features/proposal/service.ts'
export { LifecycleServiceImpl, InvalidTransitionError } from './features/archive/service.ts'
export { WorktreeManager } from './features/worktree/manager.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    'workmate.proposal': ProposalService
    'workmate.archive': LifecycleServiceImpl
    'workmate.projects': ProjectRegistry
    'workmate.worktree': WorktreeManager
  }
}

/** Tool bodies must return canonical JSON; optional fields collapse to absent. */
type ToolJson = InferValue<JsonValueSchemaSpec>
const asJson = (value: unknown): ToolJson => JSON.parse(JSON.stringify(value)) as ToolJson

export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  if (resolved.weknoraWikiRequired && resolved.weknoraKbId === '') {
    console.error(
      '[workmate] invalid config: weknoraWikiRequired=true but weknoraKbId is empty — the merging gate would block every proposal. Set weknoraKbId or clear weknoraWikiRequired.',
    )
  }
  const store = new ProposalStore({ subdir: resolved.workmateHome })
  const events = new EventLog({ subdir: resolved.workmateHome })
  const proposals = new ProposalServiceImpl(store, undefined, events)
  const registry = new ProjectRegistry({ subdir: resolved.workmateHome })
  const worktree = new WorktreeManager({
    subdir: resolved.workmateHome,
    basePort: resolved.basePort,
    portStep: resolved.portStep,
    copyFiles: resolved.copyFiles,
    packageManager: resolved.packageManager,
  })
  const resolveRoots = async (proposal: Proposal): Promise<OrchestrationTarget[]> => {
    const targets: OrchestrationTarget[] = []
    for (const name of proposal.projects) {
      const registered = await registry.get(name)
      if (registered !== undefined) targets.push({ project: name, root: registered.root })
    }
    return targets
  }
  const archive = new LifecycleServiceImpl({
    proposals,
    worktree,
    resolveProjectRoots: resolveRoots,
    openspecRoot: resolved.openspecRoot,
    approvalsRequired: resolved.approvalsRequired,
    allowAgentApproval: resolved.allowAgentApproval,
    orchestrate(proposal, targets, opts) {
      return orchestrateArchive(proposal, targets, {
        openspecRoot: opts.openspecRoot,
        gitnexusAnalyzeEnabled: resolved.gitnexusEnabled,
        reviewBlockingSeverities: resolved.reviewBlockingSeverities,
        ...(opts.reviewGate !== undefined ? { reviewGate: opts.reviewGate } : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      })
    },
    reopen(proposal, targets, opts) {
      return orchestrateReopen(proposal, targets, {
        openspecRoot: opts.openspecRoot,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      })
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
  ctx.provide('workmate.worktree', worktree)

  registerTools(ctx, { proposals, archive, registry, worktree, resolved, events })
  // Native guidance surfaces: two runtime skills + one flow section. Lazy, so
  // a composition without those services keeps the plugin ACTIVE.
  registerGuidance(ctx)
  // UI is optional: mounted only once a webServer exists, and torn down with
  // it. In a profile without the web bundle the tools above stay available.
  ctx.inject(['webServer'], (scope) => {
    mountWorkmateApi(scope.get('webServer') as WebServerLike, {
      proposals,
      archive,
      registry,
      openspecRoot: resolved.openspecRoot,
      projectRoot: resolved.projectRoot,
      qualitySyncEnabled: resolved.qualitySyncEnabled,
      claudeAssetsEnabled: resolved.claudeAssetsEnabled,
    })
  })
}

interface ToolDeps {
  /** Append-only proposal event log (metrics + gate-failure records). */
  events: EventLog
  proposals: ProposalService
  archive: LifecycleServiceImpl
  registry: ProjectRegistry
  worktree: WorktreeManager
  resolved: ReturnType<typeof resolveConfig>
}

function registerTools(ctx: Context, deps: ToolDeps): void {
  const { proposals, archive, registry, worktree, resolved } = deps

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
        source: {
          type: 'string',
          description: 'Origin: spec | incident | review-finding | metric-regression | maintenance.',
        },
        sourceRef: { type: 'string', description: 'External reference (ticket id, alert id, URL).' },
        relatesTo: { type: 'string', description: 'Comma-separated related proposal ids (rework of, same incident).' },
        notes: { type: 'string', description: 'Problem statement, rendered into the seeded proposal.md 来源段.' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
      async execute(args) {
        const projects = args.projects?.split(',').map((p) => p.trim()).filter(Boolean)
        const relatesTo = args.relatesTo?.split(',').map((id) => id.trim()).filter(Boolean)
        const result = await createProposal(
          {
            proposals,
            archive,
            registry,
            openspecRoot: resolved.openspecRoot,
            projectRoot: resolved.projectRoot,
            qualitySyncEnabled: resolved.qualitySyncEnabled,
      claudeAssetsEnabled: resolved.claudeAssetsEnabled,
          },
          {
            id: args.id,
            title: args.title,
            ...(projects !== undefined && projects.length > 0 ? { projects } : {}),
            ...(args.projectRoot !== undefined ? { projectRoot: args.projectRoot } : {}),
            ...(args.source !== undefined ? { source: args.source as ProposalSource } : {}),
            ...(args.sourceRef !== undefined ? { sourceRef: args.sourceRef } : {}),
            ...(relatesTo !== undefined && relatesTo.length > 0 ? { relatesTo } : {}),
            ...(args.notes !== undefined ? { notes: args.notes } : {}),
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
        'Fetch a WorkMate proposal: record, associated git commits (commits mentioning [proposal:<id>]) and OpenSpec change state (active/archived/missing + tasks.md progress). Also returns the lifecycle position (prev/next).',
      parameters: {
        id: { type: 'string', required: true, description: 'Proposal id.' },
        projectRoot: { type: 'string', description: 'Absolute project root; falls back to Config.projectRoot.' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
      isConcurrencySafe: () => true,
      async execute(args) {
        return asJson(
          await buildProposalStatus(proposals, args.id, {
            projectRoot: args.projectRoot ?? (resolved.projectRoot || undefined),
            openspecRoot: resolved.openspecRoot,
            approvalsRequired: resolved.approvalsRequired,
            allowAgentApproval: resolved.allowAgentApproval,
            reviewBlockingSeverities: resolved.reviewBlockingSeverities,
          }),
        )
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'workmate_proposal_archive',
      description:
        'Drive the eight-state proposal lifecycle: mode=advance moves one state forward (auto-creates the worktree at ready→implementing; wiki coverage is checked before merging); mode=archive runs the archive orchestration once in archiving (force skips the review gate only); any state name performs an adjacent transition (backward is free — rolling back from archived also moves the change directories back under changes/).',
      parameters: {
        id: { type: 'string', required: true, description: 'Proposal id.' },
        mode: { type: 'string', description: 'advance (default) | archive | a state name (draft/proposing/reviewing/ready/implementing/merging/archiving/archived).' },
        force: { type: 'boolean', description: 'mode=archive only: skip the review gate (missing review.md / unresolved CRITICAL). Never skips openspec archive or gitnexus.' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
      // worktree create (install ≤ 300s) + openspec archive (60s) + gitnexus (120s).
      timeoutMs: 15 * 60_000,
      async execute(args, exec) {
        const signal = exec.signal
        const mode = args.mode ?? 'advance'
        if (mode === 'advance') {
          const result = await archive.advance(args.id, { signal, actor: 'agent' })
          return asJson({ proposal: result.proposal, ...(result.worktree !== undefined ? { worktree: result.worktree } : {}), ...(result.orchestration !== undefined ? { orchestration: result.orchestration } : {}), note: `next: ${nextStepHint(result.proposal.status)}` })
        }
        if (mode === 'archive') {
          const result = await archive.runArchive(args.id, { force: args.force === true, signal, actor: 'agent' })
          return asJson({ proposal: result.proposal, ...(result.orchestration !== undefined ? { orchestration: result.orchestration } : {}) })
        }
        const result = await archive.transition(args.id, mode as ProposalState, { signal, actor: 'agent' })
        return asJson({ proposal: result.proposal, ...(result.worktree !== undefined ? { worktree: result.worktree } : {}), ...(result.orchestration !== undefined ? { orchestration: result.orchestration } : {}) })
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'workmate_proposal_decide',
      description:
        'Record one directional decision on a proposal. Pass supersedes with the overturned entry id instead of silently reversing it.',
      parameters: {
        id: { type: 'string', required: true, description: 'Proposal id.' },
        decision: { type: 'string', required: true, description: 'The decision in one sentence.' },
        rationale: { type: 'string', required: true, description: 'Why — evidence, alternatives rejected.' },
        supersedes: { type: 'string', description: 'Earlier decision id this one overturns.' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
      async execute(args) {
        const entry = await proposals.addDecision(args.id, {
          decision: args.decision,
          rationale: args.rationale,
          ...(args.supersedes !== undefined ? { supersedes: args.supersedes } : {}),
        })
        return asJson({ decision: entry })
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'workmate_proposal_block',
      description:
        'Escalate a blocker on a proposal: the question plus what you already tried. It appears on the panel; resolve it with the answer via workmate_proposal_unblock (or let the user answer there).',
      parameters: {
        id: { type: 'string', required: true, description: 'Proposal id.' },
        question: { type: 'string', required: true, description: 'The blocking question, precisely.' },
        tried: { type: 'string', description: 'What you already tried (prevents the answer repeating it).' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
      async execute(args) {
        const blocker = await proposals.block(args.id, {
          question: args.question,
          ...(args.tried !== undefined ? { tried: args.tried } : {}),
        })
        return asJson({ blocker, note: 'blocker open — answer arrives via workmate_proposal_unblock or the panel' })
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'workmate_proposal_unblock',
      description: 'Answer and resolve one open blocker (blockerId from workmate_proposal_block or the panel). WorkMate flow: workmate-proposal-flow skill.',
      parameters: {
        id: { type: 'string', required: true, description: 'Proposal id.' },
        blockerId: { type: 'string', required: true, description: 'Blocker id, e.g. blocker-1.' },
        answer: { type: 'string', required: true, description: 'The resolution answer.' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
      async execute(args) {
        const blocker = await proposals.unblock(args.id, args.blockerId, args.answer)
        return asJson({ blocker })
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'workmate_wiki_link',
      description:
        'Register a WeKnora Wiki page reference on a proposal (after creating/updating the page). pageType must be concept | synthesis | entity; declared wiki tasks must be covered before merging.',
      parameters: {
        id: { type: 'string', required: true, description: 'Proposal id.' },
        url: { type: 'string', required: true, description: 'weknora:// page URL or deep link.' },
        pageType: { type: 'string', required: true, description: 'concept | synthesis | entity.' },
        version: { type: 'integer', description: 'Page version after the update.' },
        commit: { type: 'string', description: 'Related commit short hash.' },
        taskId: { type: 'string', description: 'tasks.md task id this page documents, e.g. 2.3.' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
      async execute(args) {
        const link = await linkWikiToProposal(proposals, args.id, {
          url: args.url,
          pageType: args.pageType,
          ...(args.version !== undefined ? { version: args.version } : {}),
          ...(args.commit !== undefined ? { commit: args.commit } : {}),
          ...(args.taskId !== undefined ? { taskId: args.taskId } : {}),
        })
        return asJson({ link })
      },
    }),
  )
  ctx.tools.register(
    defineTool({
      name: 'workmate_wiki_links',
      description: 'List the WeKnora Wiki page references registered on a proposal.',
      parameters: {
        id: { type: 'string', required: true, description: 'Proposal id.' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
      isConcurrencySafe: () => true,
      async execute(args) {
        return asJson({ links: await listWikiLinks(proposals, args.id) })
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
        repo: { type: 'string', description: 'GitNexus repo name when it differs from the project folder name.' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
      timeoutMs: 120_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
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
            ...(args.repo !== undefined ? { repo: args.repo } : {}),
          },
          exec.signal,
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
      timeoutMs: 60_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        if (resolved.weknoraBaseUrl === '') {
          return asJson({ fragments: [], note: 'weknora bridge disabled — Config.weknoraBaseUrl is empty' })
        }
        const client = createWeknoraClient(resolved.weknoraBaseUrl)
        return asJson(await client.search(args.projectRoot, args.query, args.topK ?? 3, exec.signal))
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'workmate_metrics',
      description:
        'Read WorkMate process metrics derived from the proposal event log: per-state dwell time, cycle time, rework (backward transitions), first-pass merge, gate-failure ranking, throughput and agent/human attribution. Pass id for one proposal, omit it for the global aggregate.',
      parameters: {
        id: { type: 'string', description: 'Proposal id; omit for the global aggregate.' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
      isConcurrencySafe: () => true,
      async execute(args) {
        const { events: log, skippedLines } = await deps.events.read()
        if (args.id !== undefined) {
          const proposal = await deps.proposals.get(args.id)
          if (!proposal) throw new Error(`proposal not found: ${args.id}`)
          return asJson({ id: args.id, metrics: proposalMetrics(proposal, log), skippedLines })
        }
        const all = await deps.proposals.list()
        return asJson(aggregateMetrics(all, log, { skippedLines }))
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'workmate_bands',
      description:
        'Evaluate WorkMate control bands over its own process metrics: one sample per proposal, a rolling baseline (mean/σ from the older samples), and σ tiers 1 log / 2 diagnose / 3 propose. Read-only by default; with apply:true each propose-tier breach also opens a draft proposal (source: metric-regression). Baselines need minBaselineSamples before a metric can breach — thin history reports insufficient-data instead of raising a false alarm.',
      parameters: {
        apply: {
          type: 'boolean',
          description: 'Create a draft proposal for each propose-tier breach (default false: report only).',
        },
        windowDays: { type: 'number', description: 'Override the band window in days (default from bands.json).' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
      async execute(args) {
        const bandsFile = join(proposals.rootDir(), 'bands.json')
        const config = await loadBands(bandsFile)
        const all = await proposals.list()
        const { events: log, skippedLines } = await deps.events.read()
        const evaluations = evaluateBands(all, log, {
          config,
          ...(args.windowDays !== undefined ? { windowDays: args.windowDays } : {}),
        })
        const breaches = evaluations.filter((entry) => entry.tier !== 'normal')
        const stamp = new Date().toISOString()
        for (const breach of breaches) {
          await deps.events.append({
            at: stamp,
            proposalId: METRICS_SOURCE,
            kind: 'band-breach',
            actor: 'system',
            metric: breach.metric,
            tier: breach.tier === 'normal' ? 'log' : breach.tier,
            current: breach.current,
            baseline: breach.baseline,
            sigma: breach.sigma,
            reason: `deviation ${breach.deviation.toFixed(2)}σ`,
            ...(breach.note !== undefined ? { detail: breach.note } : {}),
          })
        }

        const created: string[] = []
        if (args.apply === true) {
          for (const breach of breaches.filter((entry) => entry.tier === 'propose')) {
            const id = `band-${breach.metric.toLowerCase()}-${stamp.slice(0, 10)}`
            if (all.some((proposal) => proposal.id === id)) continue
            await createProposal(
              {
                proposals,
                archive,
                registry,
                openspecRoot: resolved.openspecRoot,
                projectRoot: resolved.projectRoot,
                qualitySyncEnabled: resolved.qualitySyncEnabled,
                claudeAssetsEnabled: resolved.claudeAssetsEnabled,
              },
              {
                id,
                title: `指标越界：${breach.metric} 偏离基线 ${breach.deviation.toFixed(1)}σ`,
                source: 'metric-regression',
                sourceRef: `bands:${breach.metric}`,
                provenance: { capturedAt: stamp },
                notes: [
                  `控制带越界（${breach.tier}）：metric=${breach.metric} direction=${breach.direction}`,
                  `current=${breach.current} baseline=${breach.baseline} sigma=${breach.sigma} samples=${breach.samples}`,
                  breach.note ?? '',
                ]
                  .filter((line) => line !== '')
                  .join('\n'),
              },
            )
            created.push(id)
          }
        }

        return asJson({
          bandsFile,
          windowDays: config.windowDays,
          evaluations,
          breachCount: breaches.length,
          created,
          skippedLines,
        })
      },
    }),
  )

  console.log(
    '[workmate] tools registered (proposal lifecycle + decide/block/unblock + wiki_link(s) + knowledge_query/search + metrics + bands)',
  )
}
