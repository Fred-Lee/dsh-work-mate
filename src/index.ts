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
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { EventLog } from './features/proposal/events.ts'
import { runBandsCheck } from './features/metrics/check.ts'
import { parseSwarmTasks } from './features/swarm/plan.ts'
import { AgentProvider, type HostLlmFace } from './features/decision/agent.ts'
import { RulesProvider } from './features/decision/rules.ts'
import { DecisionService } from './features/decision/service.ts'
import { SwarmManager } from './features/swarm/manager.ts'
import type { ProposalSource } from './features/proposal/store.ts'
import { aggregateMetrics, proposalMetrics } from './features/proposal/metrics.ts'
import { ProposalServiceImpl, type ProposalService } from './features/proposal/service.ts'
import { LifecycleServiceImpl } from './features/archive/service.ts'
import { WorktreeManager } from './features/worktree/manager.ts'
import { linkWikiToProposal, listWikiLinks } from './features/wiki/links.ts'
import { STATE_HINTS, type ProposalState } from './features/proposal/state-machine.ts'

const nextStepHint = (status: string): string => STATE_HINTS[status as keyof typeof STATE_HINTS] ?? ''
import { collectProjectDrift, orchestrateArchive, orchestrateReopen } from './features/archive/orchestrate.ts'
import { ProjectRegistry } from './features/project/registry.ts'
import { buildProposalStatus } from './features/proposal/status.ts'
import {
  gitnexusAnalyze,
  gitnexusRun,
  gitnexusStatus,
  gitnexusWiki,
  setGitnexusApiKeyEnv,
  setGitnexusKeychainService,
} from './features/knowledge-bridge/gitnexus.ts'
import { ensureSseProxy } from './features/knowledge-bridge/sse-proxy.ts'
import { resolveProjectRoot } from './features/project/implicit-root.ts'
import { exportWikiToVault, iterationsFromProposals } from './features/wiki/vault.ts'
import { collectArchivedIterations, mergeIterations } from './features/wiki/iterations.ts'
import { searchVault } from './features/wiki/search.ts'
import { searchVaultSmart } from './features/wiki/semantic.ts'
import { EmbeddingCache, cosine, embedText, embeddingKey } from './features/wiki/embeddings.ts'
import { describeGitnexusCredentials } from './features/knowledge-bridge/gitnexus-credentials.ts'
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
  // Every spawned `gitnexus` gets GITNEXUS_API_KEY mapped from the configured
  // variable (key lives in the Keychain / shell, never in a repo or plugin file).
  setGitnexusApiKeyEnv(resolved.gitnexusApiKeyFromEnv)
  setGitnexusKeychainService(resolved.gitnexusApiKeyKeychainService)
  const swarm = new SwarmManager({ proposals, worktrees: worktree })
  // The judgement layer reaches the LLM service through a lazy reference: a profile
  // without `llm` keeps the plugin ACTIVE and the agent provider simply reports
  // itself unavailable (the deterministic `rules` provider is then the floor).
  let llmRef: HostLlmFace | undefined
  ctx.inject(['llm'], (scope) => {
    llmRef = scope.llm as unknown as HostLlmFace
  })
  const decision = new DecisionService({
    cacheFile: join(proposals.rootDir(), 'decision-cache.json'),
    config: {
      enabled: resolved.decisionEnabled,
      provider: (resolved.decisionProvider === 'rules' || resolved.decisionProvider === 'jev' ? resolved.decisionProvider : 'agent'),
      ...(resolved.decisionLlmProvider !== '' ? { llmProvider: resolved.decisionLlmProvider } : {}),
      ...(resolved.decisionModel !== '' ? { model: resolved.decisionModel } : {}),
      samples: resolved.decisionSamples,
      timeoutMs: resolved.decisionTimeoutMs,
      thresholds: { act: resolved.decisionActThreshold, review: resolved.decisionReviewThreshold },
    },
    providers: [
      new AgentProvider({
        llm: () => llmRef,
        ...(resolved.decisionLlmProvider !== '' ? { provider: resolved.decisionLlmProvider } : {}),
        ...(resolved.decisionModel !== '' ? { model: resolved.decisionModel } : {}),
        samples: resolved.decisionSamples,
        timeoutMs: resolved.decisionTimeoutMs,
      }),
      new RulesProvider(),
    ],
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
    planDriftGate: resolved.planDriftGate,
    highRiskExtraGates: resolved.highRiskExtraGates,
    orchestrate(proposal, targets, opts) {
      return orchestrateArchive(proposal, targets, {
        openspecRoot: opts.openspecRoot,
        gitnexusAnalyzeEnabled: resolved.gitnexusEnabled,
        reviewBlockingSeverities: resolved.reviewBlockingSeverities,
        reviewGradeMax: resolved.reviewGradeMax,
        taskJudgementGate: resolved.taskJudgementGate,
        ...(opts.reviewGate !== undefined ? { reviewGate: opts.reviewGate } : {}),
        ...(opts.tasksGate !== undefined ? { tasksGate: opts.tasksGate } : {}),
        ...(opts.planDriftGate !== undefined ? { planDriftGate: opts.planDriftGate } : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      }, {
        // The judgement layer reaches the archive orchestration as a hook: absent
        // means disabled, and everything behaves exactly as before.
        ...(decision.enabled
          ? {
              decide: async (question, signal) => {
                const outcome = await decision.decide(question, signal)
                if (outcome !== undefined) {
                  await events
                    .append({
                      at: new Date().toISOString(),
                      kind: 'decision',
                      proposalId: proposal.id,
                      actor: 'agent',
                      node: outcome.node,
                      action: outcome.action,
                      ...(outcome.choice !== undefined ? { choice: outcome.choice } : {}),
                      certainty: outcome.certainty,
                      provider: outcome.provider,
                      threshold: outcome.threshold,
                      ...(outcome.cached !== undefined ? { cached: outcome.cached } : {}),
                      ...(outcome.degraded !== undefined ? { degraded: outcome.degraded } : {}),
                    })
                    .catch(() => undefined)
                }
                return outcome
              },
            }
          : {}),
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

  /**
   * One code path for both the tool and `/workmate export`: git history in the vault is
   * optional and never fatal — an export that fails to commit is still a successful export.
   */
  const runVaultExport = async (options: {
    projectRoot: string
    vaultPath?: string
    noGit?: boolean
  }): Promise<{
    projectDir: string
    written: string[]
    modules: number
    pages: number
    iterations: number
    commit?: string
    git?: { committed: boolean; note?: string }
  }> => {
    const vaultPath = options.vaultPath ?? resolved.wikiVaultPath
    if (vaultPath === '') {
      throw new Error(
        '未配置 wikiVaultPath（也没给 --vault）：请在 profile 的 workmate 配置里指定 Obsidian/Tolaria 库目录',
      )
    }
    const project = basename(options.projectRoot)
    const all = await proposals.list()
    const mine = all.filter((proposal) => proposal.projects.includes(project) || proposal.id === project)
    // Proposals are authoritative; archived OpenSpec changes fill in the history a
    // project that never used WorkMate would otherwise lack (no fabricated edges).
    const archived = await collectArchivedIterations({
      projectRoot: options.projectRoot,
      openspecRoot: resolved.openspecRoot,
      gitLog: (root) =>
        new Promise((resolvePromise) => {
          execFile(
            'git',
            ['-C', root, 'log', '--all', '--format=%h%x09%s', '-n', '2000'],
            { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 },
            (error: Error | null, stdout: string) => resolvePromise(error ? '' : stdout),
          )
        }),
    })
    const iterations = mergeIterations(iterationsFromProposals(mine), archived)
    const result = await exportWikiToVault({
      projectRoot: options.projectRoot,
      project,
      vaultPath,
      subdir: resolved.wikiVaultSubdir,
      iterations,
      // Semantic fallback for iterations whose Impact section names no file: the judgement
      // layer picks one module (or abstains), and only `act` answers become graph edges.
      // Local embedding match first: free, deterministic, no provider needed. It also
      // tells us whether the judgement layer is even reachable (see `classify.llm`).
      matchModuleByVector: async (text, modules) => {
        const model = resolved.wikiVaultEmbeddingModel
        if (model === '') return undefined
        const cache = new EmbeddingCache(
          resolved.wikiVaultEmbeddingCache !== ''
            ? resolved.wikiVaultEmbeddingCache
            : join(proposals.rootDir(), 'wiki-embeddings.json'),
        )
        const asked = await embedText(text, { model, baseUrl: resolved.wikiVaultOllamaUrl })
        if (asked.vector === undefined) return undefined
        let best: { slug: string; score: number } | undefined
        for (const module of modules) {
          const key = embeddingKey(model, `${module.name} ${module.slug}`)
          let vector = await cache.get(key)
          if (vector === undefined) {
            const embedded = await embedText(`${module.name} ${module.slug}`, {
              model,
              baseUrl: resolved.wikiVaultOllamaUrl,
            })
            if (embedded.vector === undefined) continue
            vector = embedded.vector
            await cache.put(key, vector)
          }
          const score = cosine(asked.vector, vector)
          if (best === undefined || score > best.score) best = { slug: module.slug, score }
        }
        // Only a clearly better-than-noise match becomes a graph edge.
        return best !== undefined && best.score >= 0.55 ? best : undefined
      },
      ...(decision.enabled
        ? {
            classifyModule: async (text: string, modules: readonly { name: string; slug: string }[]) => {
              const outcome = await decision.decide({
                node: 'module-match',
                state: text,
                question: '这次变更主要影响哪个模块？',
                options: [...modules.map((module) => module.slug), 'none'],
              })
              return outcome?.action === 'act' && outcome.choice !== undefined && outcome.choice !== 'none'
                ? outcome.choice
                : undefined
            },
            classifyMax: resolved.wikiVaultClassifyMax,
          }
        : {}),
    })
    // One aggregate trace per export: batch judgements must not vanish silently.
    await events
      .append({
        at: new Date().toISOString(),
        kind: 'decision',
        proposalId: `_wiki_${project}`,
        actor: 'system',
        node: 'module-match-batch',
        action: (result.classify?.vectorMatched ?? 0) + (result.classify?.llmMatched ?? 0) > 0 ? 'act' : 'abstain',
        certainty: 0,
        provider: result.classify?.llm === 'ok' ? 'agent' : 'rules',
        threshold: resolved.decisionActThreshold,
        detail: JSON.stringify({
          ...result.classify,
          llmReachable: llmRef !== undefined,
          model: resolved.decisionModel,
          // A route needs a non-empty model: the agent provider resolves it from config or
          // from the provider's model list, and an empty model means "no answer, silently".
          listedProviders: llmRef?.listProviders?.().length ?? 0,
          listedModels: llmRef?.listProviders?.()[0]?.models?.length ?? 0,
        }),
      })
      .catch(() => undefined)

    if ((result.classify?.llmAsked ?? 0) > 0 && (result.classify?.llmMatched ?? 0) === 0) {
      result.note =
        `判断层问了 ${result.classify?.llmAsked} 次但没有一条 act 档结论——` +
        `先查 decisionModel（当前 '${resolved.decisionModel}'）与 provider 的模型列表：` +
        '路由解析不到非空 model 时 agent provider 会直接放弃且不写缓存。'
    }

    const wantCommit = options.noGit !== true && resolved.wikiVaultGitCommit
    if (!wantCommit) {
      return { ...result, git: { committed: false, note: 'git 提交未开启（wikiVaultGitCommit=false 或 --no-git）' } }
    }
    const git = (args: string[], cwd: string): Promise<string> =>
      new Promise((resolvePromise, reject) => {
        execFile('git', args, { cwd, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error: Error | null, stdout: string) => {
          if (error) reject(new Error(error.message))
          else resolvePromise(stdout)
        })
      })
    try {
      const inside = await git(['rev-parse', '--is-inside-work-tree'], vaultPath).catch(() => '')
      if (inside.trim() !== 'true') {
        return { ...result, git: { committed: false, note: 'vault 不是 git 仓库，跳过提交' } }
      }
      const status = (await git(['status', '--porcelain'], vaultPath)).trim()
      if (status === '') return { ...result, git: { committed: false, note: '无改动，未提交' } }
      await git(['add', '-A'], vaultPath)
      await git(['commit', '-m', `WorkMate: 更新 ${project} wiki @${result.commit ?? 'unknown'}`], vaultPath)
      return { ...result, git: { committed: true, note: `WorkMate: 更新 ${project} wiki @${result.commit ?? 'unknown'}` } }
    } catch (error) {
      return {
        ...result,
        git: { committed: false, note: `提交失败（不影响导出）：${error instanceof Error ? error.message : String(error)}` },
      }
    }
  }

  registerTools(ctx, { proposals, archive, registry, worktree, swarm, decision, vaultExport: runVaultExport, resolved, events })
  // Native guidance surfaces: two runtime skills + one flow section. Lazy, so
  // a composition without those services keeps the plugin ACTIVE.
  registerGuidance(ctx, {
    ensureProxy: () =>
      ensureSseProxy({
        enabled: resolved.gitnexusSseProxyEnabled,
        port: resolved.gitnexusSseProxyPort,
        upstream: resolved.gitnexusSseProxyUpstream,
      }),
    projects: () => registry.list(),
    searchVault: (input) =>
      searchVaultSmart({
        vaultPath: input.vaultPath ?? resolved.wikiVaultPath,
        subdir: resolved.wikiVaultSubdir,
        query: input.query,
        model: input.semantic === true ? (resolved.wikiVaultEmbeddingModel || '') : '',
        baseUrl: resolved.wikiVaultOllamaUrl,
        cachePath:
          resolved.wikiVaultEmbeddingCache !== ''
            ? resolved.wikiVaultEmbeddingCache
            : join(proposals.rootDir(), 'wiki-embeddings.json'),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      }),
    exportToVault: (input) =>
      runVaultExport({
        projectRoot: input.projectRoot,
        ...(input.vaultPath !== undefined ? { vaultPath: input.vaultPath } : {}),
        ...(input.noGit !== undefined ? { noGit: input.noGit } : {}),
      }),
    status: (projectRoot) => gitnexusStatus(projectRoot),
    analyze: (projectRoot) => gitnexusAnalyze(projectRoot, { force: false }),
    wiki: (projectRoot, options) =>
      gitnexusWiki(projectRoot, {
        ...(options.force ? { force: true } : {}),
        lang: options.lang,
        timeoutMs: resolved.gitnexusWikiTimeoutMs,
      }),
    configuredLang: resolved.gitnexusWikiLang,
  })
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
      approvalsRequired: resolved.approvalsRequired,
      allowAgentApproval: resolved.allowAgentApproval,
      reviewBlockingSeverities: resolved.reviewBlockingSeverities,
      decision,
      events,
      vaultExport: (input) =>
        runVaultExport({
          projectRoot: input.projectRoot,
          ...(input.vaultPath !== undefined ? { vaultPath: input.vaultPath } : {}),
          ...(input.gitCommit === true ? { noGit: false } : {}),
        }),
      wikiSearch: (input) =>
        searchVaultSmart({
          vaultPath: resolved.wikiVaultPath,
          subdir: resolved.wikiVaultSubdir,
          model: input.semantic === true ? resolved.wikiVaultEmbeddingModel : '',
          baseUrl: resolved.wikiVaultOllamaUrl,
          cachePath:
            resolved.wikiVaultEmbeddingCache !== ''
              ? resolved.wikiVaultEmbeddingCache
              : join(proposals.rootDir(), 'wiki-embeddings.json'),
          ...(input.project !== undefined ? { project: input.project } : {}),
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
          query: input.query,
        }),
      gitnexusEnabled: resolved.gitnexusEnabled,
      gitnexusWikiLang: resolved.gitnexusWikiLang,
      gitnexusWikiTimeoutMs: resolved.gitnexusWikiTimeoutMs,
      gitnexusSseProxyEnabled: resolved.gitnexusSseProxyEnabled,
      gitnexusSseProxyPort: resolved.gitnexusSseProxyPort,
      gitnexusSseProxyUpstream: resolved.gitnexusSseProxyUpstream,
      gitnexusApiKeyFromEnv: resolved.gitnexusApiKeyFromEnv,
      gitnexusApiKeyKeychainService: resolved.gitnexusApiKeyKeychainService,
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
  swarm: SwarmManager
  decision: DecisionService
  /** Export the project wiki into the configured vault (shared with `/workmate export`). */
  vaultExport: (options: { projectRoot: string; vaultPath?: string; noGit?: boolean }) => Promise<{
    projectDir: string
    written: string[]
    modules: number
    pages: number
    iterations: number
    commit?: string
    git?: { committed: boolean; note?: string }
  }>
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
            // Without these two the injection judgement and its `decision` trace never ran
            // on the tool path — only the REST path was protected (found by live probe).
            decision: deps.decision,
            events: deps.events,
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
      async execute(args, exec) {
        const proposal = await deps.proposals.get(args.id)
        if (proposal === undefined) throw new Error(`proposal not found: ${args.id}`)

        // Judgement layer (change `add-decision-layer`): a silent reversal is what
        // the mechanical check cannot see — `supersedes` must reference an EXISTING
        // entry, but nothing stops a new decision from contradicting an old one.
        // The layer may only tighten: `act + contradicts` refuses, everything else
        // leaves the pre-existing behaviour untouched (design D4).
        if (deps.decision.enabled) {
          const history = (proposal.decisions ?? [])
            .map((entry, index) => `${index + 1}. ${entry.decision} — ${entry.rationale}`)
            .join('\n')
          const outcome = await deps.decision.decide(
            {
              node: 'decision-consistency',
              state: `既有决策：\n${history === '' ? '（无）' : history}\n\n新决策：${args.decision}\n理由：${args.rationale}${
                args.supersedes !== undefined ? `\n（调用方已声明 supersedes=${args.supersedes}）` : ''
              }`,
              question: '新决策是否与既有决策矛盾（或应当声明推翻某条旧决策）？',
              options: ['consistent', 'contradicts'],
            },
            exec.signal,
          )
          if (outcome !== undefined) {
            await deps.events.append({
              at: new Date().toISOString(),
              proposalId: args.id,
              kind: 'decision',
              actor: 'system',
              node: outcome.node,
              action: outcome.action,
              ...(outcome.choice !== undefined ? { choice: outcome.choice } : {}),
              certainty: outcome.certainty,
              provider: outcome.provider,
              ...(outcome.samples !== undefined ? { samples: outcome.samples } : {}),
              threshold: outcome.threshold,
              latencyMs: outcome.latencyMs,
              degraded: outcome.degraded,
              ...(outcome.cached === true ? { cached: true } : {}),
            ...(outcome.cached === true ? { cached: true } : {}),
              ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
            })
            if (outcome.action === 'act' && outcome.choice === 'contradicts' && args.supersedes === undefined) {
              throw new Error(
                `判断层认为这条决策与既有决策矛盾（certainty ${outcome.certainty.toFixed(2)}，provider ${outcome.provider}）：` +
                  '请显式声明 supersedes=<被推翻的决策 id>，或改写决策使其不构成推翻。',
              )
            }
          }
        }

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
        const result = await runBandsCheck(
          {
            proposals,
            events: deps.events,
            bandsFile: join(proposals.rootDir(), 'bands.json'),
            createProposal: async (input) => {
              const created = await createProposal(
                {
                  proposals,
                  archive,
                  registry,
                  openspecRoot: resolved.openspecRoot,
                  projectRoot: resolved.projectRoot,
                  qualitySyncEnabled: resolved.qualitySyncEnabled,
                  claudeAssetsEnabled: resolved.claudeAssetsEnabled,
                  decision: deps.decision,
                  events: deps.events,
                },
                input,
              )
              return { id: created.proposal.id }
            },
          },
          {
            ...(args.apply !== undefined ? { apply: args.apply } : {}),
            ...(args.windowDays !== undefined ? { windowDays: args.windowDays } : {}),
          },
        )
        return asJson(result)
      },
    }),
  )

  /** Resolve the project root a swarm task runs against (explicit → config → registry). */
  const swarmRoot = async (proposal: Proposal, explicit?: string): Promise<string> => {
    if (explicit !== undefined && explicit !== '') return explicit
    if (resolved.projectRoot !== '') return resolved.projectRoot
    for (const name of proposal.projects) {
      const registered = await registry.get(name)
      if (registered !== undefined) return registered.root
    }
    throw new Error('no project root: pass projectRoot, set Config.projectRoot, or register a project')
  }

  ctx.tools.register(
    defineTool({
      name: 'workmate_swarm_plan',
      description:
        'Plan parallel task execution for a proposal: derive tasks from its tasks.md (each line may declare <!-- writes: src/a/**, docs/** -->), batch them so no two tasks in a batch share a write scope, and record one worktree/branch carrier per task. Reports conflicting task pairs and undeclared scopes. Call workmate_swarm_task to start or merge one.',
      parameters: {
        id: { type: 'string', required: true, description: 'Proposal id.' },
        maxParallel: { type: 'number', description: 'Tasks per batch (default 3).' },
        projectRoot: { type: 'string', description: 'Absolute project root; defaults to Config.projectRoot or the first registered project.' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
      isConcurrencySafe: () => true,
      async execute(args) {
        const proposal = await proposals.get(args.id)
        if (proposal === undefined) throw new Error(`proposal not found: ${args.id}`)
        const root = await swarmRoot(proposal, args.projectRoot)
        const tasksFile = join(root, resolved.openspecRoot, 'changes', proposal.openspecChangeId, 'tasks.md')
        const content = await readFile(tasksFile, 'utf8').catch(() => '')
        const inputs = parseSwarmTasks(content)
        if (inputs.length === 0) {
          return asJson({ note: `no task lines found in ${tasksFile}`, tasks: [] })
        }
        const planned = await deps.swarm.plan(args.id, inputs, {
          ...(args.maxParallel !== undefined ? { maxParallel: args.maxParallel } : {}),
        })
        return asJson({ tasksFile, plan: planned.plan, tasks: planned.tasks })
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'workmate_swarm_task',
      description:
        'Start or merge one planned swarm task. action=start creates the task worktree + branch (feature/<proposal>--<task>) and marks it running; action=merge merges that branch back into the proposal implementation branch inside the proposal worktree. A merge conflict aborts the merge, marks the task failed, and returns the conflicted files for adjudication: merge the implementation branch INTO the task worktree, resolve and commit there, then retry this merge.',
      parameters: {
        id: { type: 'string', required: true, description: 'Proposal id.' },
        action: { type: 'string', required: true, description: 'start | merge.' },
        taskId: { type: 'string', required: true, description: 'Task id from workmate_swarm_plan (e.g. t1).' },
        projectRoot: { type: 'string', description: 'Absolute project root; defaults to Config.projectRoot or the first registered project.' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
      async execute(args, exec) {
        const proposal = await proposals.get(args.id)
        if (proposal === undefined) throw new Error(`proposal not found: ${args.id}`)
        const root = await swarmRoot(proposal, args.projectRoot)
        if (args.action === 'start') {
          const record = await deps.swarm.start(args.id, args.taskId, { projectRoot: root, ...(exec.signal !== undefined ? { signal: exec.signal } : {}) })
          return asJson({ task: record, workspace: record.worktreePath, branch: record.branch })
        }
        if (args.action === 'merge') {
          const result = await deps.swarm.merge(args.id, args.taskId, { projectRoot: root, ...(exec.signal !== undefined ? { signal: exec.signal } : {}) })
          return asJson(result)
        }
        throw new Error(`unknown action '${args.action}' — valid: start, merge`)
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'workmate_plan_drift',
      description:
        'Compare the plan against the code: declared scopes come from tasks.md (<!-- writes: ... -->) and design.md (<!-- files: ... -->), the actual set from the files the proposal\'s [proposal:<id>] commits touched. Returns undeclared changes, declared-but-untouched scopes and a drift ratio; with Config.planDriftGate enabled the same comparison blocks archiving. Run it before merging so declarations or the diff can still be fixed.',
      parameters: {
        id: { type: 'string', required: true, description: 'Proposal id.' },
        projectRoot: { type: 'string', description: 'Absolute project root; defaults to Config.projectRoot or the first registered project.' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
      isConcurrencySafe: () => true,
      async execute(args) {
        const proposal = await proposals.get(args.id)
        if (proposal === undefined) throw new Error(`proposal not found: ${args.id}`)
        const root = await swarmRoot(proposal, args.projectRoot)
        const drift = await collectProjectDrift(
          proposal,
          { project: proposal.projects[0] ?? '(explicit)', root },
          { openspecRoot: resolved.openspecRoot },
        )
        return asJson(
          drift === undefined
            ? { id: args.id, note: 'no [proposal:<id>] commits found — nothing to compare yet' }
            : { id: args.id, projectRoot: root, drift },
        )
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'workmate_assess_risk',
      description:
        'Judge a proposal\'s change risk (low | medium | high) from its declared scopes, the files its [proposal:<id>] commits touched and its spec artifacts, then persist it. A high-risk proposal additionally requires a HUMAN approval to reach Config.highRiskExtraGates (default implementing), on top of approvalsRequired. Does nothing when the judgement layer is disabled.',
      parameters: {
        id: { type: 'string', required: true, description: 'Proposal id.' },
        projectRoot: { type: 'string', description: 'Absolute project root; defaults to Config.projectRoot or the first registered project.' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
      async execute(args, exec) {
        const proposal = await proposals.get(args.id)
        if (proposal === undefined) throw new Error(`proposal not found: ${args.id}`)
        if (!deps.decision.enabled) {
          return asJson({ id: args.id, note: 'judgement layer disabled (Config.decisionEnabled=false)', risk: proposal.risk ?? null })
        }
        const root = await swarmRoot(proposal, args.projectRoot)
        const drift = await collectProjectDrift(
          proposal,
          { project: proposal.projects[0] ?? '(explicit)', root },
          { openspecRoot: resolved.openspecRoot },
        )
        const state = [
          `提案：${proposal.title}`,
          `项目：${proposal.projects.join(', ') || '(未关联)'}`,
          `声明范围：${(drift?.declared ?? []).join(', ') || '(未声明)'}`,
          `实际改动（前 20 个）：${(drift?.actual ?? []).slice(0, 20).join(', ') || '(无标记提交)'}`,
          `标记提交数：${(drift?.actual.length ?? 0) > 0 ? proposal.commits.length : 0}`,
        ].join('\n')
        const outcome = await deps.decision.decide(
          {
            node: 'risk-tier',
            state,
            question: '这次变更的风险等级是？',
            options: ['low', 'medium', 'high'],
          },
          exec.signal,
        )
        if (outcome !== undefined) {
          await deps.events.append({
            at: new Date().toISOString(),
            proposalId: args.id,
            kind: 'decision',
            actor: 'system',
            node: outcome.node,
            action: outcome.action,
            ...(outcome.choice !== undefined ? { choice: outcome.choice } : {}),
            certainty: outcome.certainty,
            provider: outcome.provider,
            ...(outcome.samples !== undefined ? { samples: outcome.samples } : {}),
            threshold: outcome.threshold,
            latencyMs: outcome.latencyMs,
            degraded: outcome.degraded,
            ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
          })
        }
        // Only a confident judgement becomes a fact (design D2).
        if (outcome?.action === 'act' && outcome.choice !== undefined) {
          await proposals.patchFields(args.id, { risk: outcome.choice as 'low' | 'medium' | 'high' })
        }
        return asJson({
          id: args.id,
          risk: outcome?.action === 'act' ? outcome.choice : (proposal.risk ?? null),
          judgement: outcome ?? null,
          extraGates: resolved.highRiskExtraGates,
        })
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'workmate_wiki_generate',
      description:
        'Generate a readable project wiki from the GitNexus knowledge graph (per-module documents + an index.html reader under <projectRoot>/.gitnexus/wiki/). Prefer this over running `gitnexus wiki` directly: the SSE-normalizing proxy and the gateway key injection live on this path. Works on any gitnexus-indexed repository — no proposal needed. Reports index staleness first; pass analyze:true to re-index before generating (that is the slow full rebuild). Verdict: complete=true means the reader was written; pages counts the files actually produced.',
      parameters: {
        projectRoot: {
          type: 'string',
          description:
            'Repository root. Omit to use the current session project (agent session cwd), or the sole registered project when no cwd applies.',
        },
        analyze: { type: 'boolean', description: 'Re-index (gitnexus analyze) before generating. Default false — the result then reports stale:true when the index is behind.' },
        force: { type: 'boolean', description: 'Force full wiki regeneration even when GitNexus thinks it is up to date.' },
        lang: { type: 'string', description: 'Output language (e.g. chinese); defaults to Config.gitnexusWikiLang.' },
        review: { type: 'boolean', description: 'Stop after module grouping so the structure can be reviewed before pages are written.' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
      timeoutMs: resolved.gitnexusWikiTimeoutMs + 30_000,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        if (!resolved.gitnexusEnabled) {
          return asJson({ note: 'gitnexus bridge disabled by config (gitnexusEnabled: false)' })
        }
        const known = await registry.list()
        const sessionCwd = exec.agent?.session?.header?.cwd
        const requested =
          args.projectRoot ?? (sessionCwd === undefined && known.length === 1 ? known[0]?.root : undefined)
        const resolvedRoot = resolveProjectRoot({
          ...(requested !== undefined ? { input: requested } : {}),
          ...(sessionCwd !== undefined ? { cwd: sessionCwd } : {}),
          projects: known,
        })
        if ('error' in resolvedRoot) throw new Error(resolvedRoot.error)
        const projectRoot = resolvedRoot.root
        // Gateways that stream `data:{` (no space) need the normalizing proxy first;
        // reuse an existing matching instance rather than spawning another.
        const credentials = describeGitnexusCredentials({
          env: process.env,
          fromEnvName: resolved.gitnexusApiKeyFromEnv,
          keychainService: resolved.gitnexusApiKeyKeychainService,
          configPath: join(homedir(), '.gitnexus', 'config.json'),
        })
        const sseProxy = await ensureSseProxy({
          enabled: resolved.gitnexusSseProxyEnabled,
          port: resolved.gitnexusSseProxyPort,
          upstream: resolved.gitnexusSseProxyUpstream,
        })
        const status = args.analyze === true ? undefined : await gitnexusStatus(projectRoot, exec.signal)
        let analyzed = false
        if (args.analyze === true) {
          const reindex = await gitnexusAnalyze(projectRoot, { force: false }, exec.signal)
          analyzed = reindex.note === undefined
        }
        const result = await gitnexusWiki(
          projectRoot,
          {
            ...(args.force === true ? { force: true } : {}),
            ...(args.review === true ? { review: true } : {}),
            lang: args.lang ?? resolved.gitnexusWikiLang,
            timeoutMs: resolved.gitnexusWikiTimeoutMs,
          },
          exec.signal,
        )
        return asJson({
          projectRoot: projectRoot,
          analyzed,
          stale: analyzed ? false : (status?.stale ?? true),
          ...(status?.note !== undefined ? { statusNote: status.note } : {}),
          wikiDir: result.wikiDir,
          indexHtml: result.indexHtml,
          pages: result.pages,
          complete: result.complete,
          ...(result.upToDate === true ? { upToDate: true } : {}),
          ...(result.mode !== undefined ? { mode: result.mode } : {}),
          ...(result.elapsedMs !== undefined ? { elapsedMs: result.elapsedMs } : {}),
          sseProxy,
          credentials,
          output: result.output,
          ...(result.note !== undefined ? { note: result.note } : {}),
        })
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'workmate_wiki_export',
      description:
        'Export a project wiki into an Obsidian/Tolaria vault as human-readable notes an AI can also read directly: index.md (MOC), one note per module, one per proposal (with depends_on/supersedes front-matter), and an append-only changelog. projectRoot may be omitted (session cwd / sole registered project). Commit is optional (Config.wikiVaultGitCommit) and never fatal.',
      parameters: {
        projectRoot: { type: 'string', description: 'Repository root; omit to use the current session project.' },
        vaultPath: { type: 'string', description: 'Vault root override; defaults to Config.wikiVaultPath.' },
        gitCommit: { type: 'boolean', description: 'Force a vault git commit for this run (vault must be a git repo).' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
      timeoutMs: 120_000,
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const known = await deps.registry.list()
        const sessionCwd = exec.agent?.session?.header?.cwd
        const requested =
          args.projectRoot ?? (sessionCwd === undefined && known.length === 1 ? known[0]?.root : undefined)
        const resolvedRoot = resolveProjectRoot({
          ...(requested !== undefined ? { input: requested } : {}),
          ...(sessionCwd !== undefined ? { cwd: sessionCwd } : {}),
          projects: known,
        })
        if ('error' in resolvedRoot) throw new Error(resolvedRoot.error)
        const exported = await deps.vaultExport({
          projectRoot: resolvedRoot.root,
          ...(args.vaultPath !== undefined ? { vaultPath: args.vaultPath } : {}),
          ...(args.gitCommit === true ? { noGit: false } : {}),
        })
        return asJson({ projectRoot: resolvedRoot.root, how: resolvedRoot.how, ...exported })
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'workmate_wiki_search',
      description:
        'Search the exported wiki vault (Obsidian/Tolaria) for a query and return ranked hits WITH file and line numbers, so answers can cite the human-readable notes directly. Lexical (grep-style), not semantic: results are explainable and always in sync with the files. Scope with project to search one project directory.',
      parameters: {
        query: { type: 'string', required: true, description: 'Search terms (CJK kept whole, latin words split).' },
        project: { type: 'string', description: 'Limit to one project directory inside the vault.' },
        limit: { type: 'integer', description: 'Maximum hits (default 20).' },
        semantic: { type: 'boolean', description: 'Use the local embedding model (Config.wikiVaultEmbeddingModel) instead of lexical-only search.' },
        vaultPath: { type: 'string', description: 'Vault root override; defaults to Config.wikiVaultPath.' },
      },
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
      timeoutMs: 60_000,
      isConcurrencySafe: () => true,
      async execute(args) {
        const vaultPath = args.vaultPath ?? resolved.wikiVaultPath
        if (vaultPath === '') throw new Error('未配置 wikiVaultPath：先 /workmate export 或设置配置')
        const model = args.semantic === true ? resolved.wikiVaultEmbeddingModel : ''
        if (args.semantic === true && model === '') {
          throw new Error('语义检索未配置：设置 Config.wikiVaultEmbeddingModel（本机可用 nomic-embed-text）')
        }
        return asJson(
          await searchVaultSmart({
            vaultPath,
            subdir: resolved.wikiVaultSubdir,
            ...(args.project !== undefined ? { project: args.project } : {}),
            query: args.query,
            model,
            baseUrl: resolved.wikiVaultOllamaUrl,
            cachePath:
              resolved.wikiVaultEmbeddingCache !== ''
                ? resolved.wikiVaultEmbeddingCache
                : join(proposals.rootDir(), 'wiki-embeddings.json'),
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
          }),
        )
      },
    }),
  )

  console.log(
    '[workmate] tools registered (lifecycle + decide/block/unblock + wiki + knowledge + metrics + bands + swarm)',
  )
}
