/**
 * REST face of the proposal middleware, mounted under `/workmate/` by
 * `src/index.ts`. Same pattern as the Helmsman UI hosts: the Router owns
 * `/workmate/api/*`; everything else falls through to the static SPA.
 *
 * REST is the shared transport for the panel (browser) and any scripting —
 * the tools registered for agents are the semantic twin of these endpoints.
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Router, readJsonBody } from './http.ts'
import { aggregateMetrics, proposalMetrics } from './features/proposal/metrics.ts'
import type { EventLog } from './features/proposal/events.ts'
import { assessReadiness } from './features/proposal/readiness.ts'
import { evaluateBands, loadBands } from './features/metrics/bands.ts'
import { runBandsCheck } from './features/metrics/check.ts'
import { CONFIG_DEFAULTS } from './config.ts'
import type { DecisionService } from './features/decision/service.ts'
import { gitnexusAnalyze, gitnexusStatus, gitnexusWiki } from './features/knowledge-bridge/gitnexus.ts'
import { ensureSseProxy } from './features/knowledge-bridge/sse-proxy.ts'
import { prescreenInjection } from './features/decision/injection.ts'
import { describeGitnexusCredentials } from './features/knowledge-bridge/gitnexus-credentials.ts'
import type { ProposalSource, ProposalTarget, Provenance } from './features/proposal/store.ts'
import type { ProposalService } from './features/proposal/service.ts'
import type { LifecycleServiceImpl } from './features/archive/service.ts'
import { PROPOSAL_STATES, isProposalState } from './features/proposal/state-machine.ts'
import { linkWikiToProposal } from './features/wiki/links.ts'
import type { ProjectRegistry } from './features/project/registry.ts'
import { listProjectBranches } from './features/project/branches.ts'
import { getProjectGitStatus } from './features/project/status.ts'
import { listWorkspaceCandidates, type WorkspaceRegistryLike } from './features/project/workspace-candidates.ts'
import { deriveBranchOccupancy, findBranchConflicts, isOccupying } from './features/proposal/isolation.ts'
import { findWriteConflicts, readProposalWriteScopes } from './features/proposal/writes.ts'
import { checkTargetDrift } from './features/proposal/drift.ts'
import { effectiveTargets } from './features/proposal/targets.ts'
import { syncProjectAssets } from './features/quality/sync.ts'
import { buildProposalStatus } from './features/proposal/status.ts'
import { generateChangeDir, readChangeState, validateProjectRoot } from './features/proposal/openspec.ts'
import { readProposalFile } from './features/archive/service.ts'
import { listProposalCommits } from './features/proposal/git.ts'
import type { TaskServiceImpl } from './features/task/service.ts'

/** Explicit per-call root wins, then the config default, else disabled. */
function resolveRoot(deps: ApiDeps, explicit?: string): string {
  return explicit || deps.projectRoot || ''
}

export interface ApiDeps {
  proposals: ProposalService
  archive: LifecycleServiceImpl
  registry: ProjectRegistry
  openspecRoot: string
  /** Generate the change dir only in the primary target or in every target. @default 'primary' */
  openspecTargets?: 'primary' | 'all'
  /** Config-level default project root; may be empty. */
  projectRoot: string
  /** Official Workspace registry getter; absent = candidate import hidden. */
  workspaceRegistry?: () => WorkspaceRegistryLike | undefined
  /** Integration trunk used when projecting legacy single-target branches. */
  lifecycleMainBranch?: string
  /** Sync quality assets into the target project on creation. @default true */
  qualitySyncEnabled: boolean
  /** Also distribute the Claude Code asset set (.claude/**). @default true */
  claudeAssetsEnabled: boolean
  /** Wiki vault export (shared with the tool and `/workmate export`). */
  vaultExport?: (input: { projectRoot: string; vaultPath?: string; gitCommit?: boolean }) => Promise<unknown>
  /** Vault search (lexical-first, semantic fallback). */
  wikiSearch?: (input: { query: string; project?: string; limit?: number; semantic?: boolean }) => Promise<unknown>
  /** Proposal event log; omitted in tests that do not measure. */
  events?: EventLog
  /** Control-band file; defaults to `<DSH home>/<workmateHome>/bands.json`. */
  bandsFile?: string
  /** States gated on a human approval (`Config.approvalsRequired`). */
  approvalsRequired?: string[]
  /** Set when the agent may cross gated states (`Config.allowAgentApproval`). */
  allowAgentApproval?: boolean
  /** Judgement layer; omitted = disabled (change `add-decision-nodes`). */
  decision?: DecisionService
  /** GitNexus bridge switch (`Config.gitnexusEnabled`); omitted = enabled. */
  gitnexusEnabled?: boolean
  /** Wiki output language (`Config.gitnexusWikiLang`). */
  gitnexusWikiLang?: string
  /** Wiki generation timeout in ms (`Config.gitnexusWikiTimeoutMs`). */
  gitnexusWikiTimeoutMs?: number
  /** SSE proxy knobs (`Config.gitnexusSseProxy*`). */
  gitnexusSseProxyEnabled?: boolean
  gitnexusSseProxyPort?: number
  gitnexusSseProxyUpstream?: string
  /** Credential plumbing (`Config.gitnexusApiKeyFromEnv` / `...KeychainService`). */
  gitnexusApiKeyFromEnv?: string
  gitnexusApiKeyKeychainService?: string
  /** Severities whose open findings block archiving (`Config.reviewBlockingSeverities`). */
  reviewBlockingSeverities?: string[]
  /** 任务簿与 Super-agent 投影（change `adopt-superagent-openspec-source`）。 */
  tasks?: TaskServiceImpl
  /** worktree 回收与遗留清单（change `adopt-superagent-openspec-source`）。 */
  worktreeReclaim?: {
    leftover(): Promise<{ entries: Array<{ taskId: string; repo: string; directory: string; ticketId?: string }> }>
    reclaim(taskId: string, options: { force?: boolean }): Promise<unknown>
  }
}

export interface CreateProjectBody {
  name?: string
  root?: string
  /** Branch a new proposal targets by default (main/master when omitted). */
  defaultBranch?: string
  /** Optional grouping label for the panel tree. */
  workspace?: string
}

export interface CreateProposalBody {
  id?: string
  title?: string
  projects?: string[]
  /** Per-project carriers (project × base branch). */
  targets?: ProposalTarget[]
  /** Project that owns the OpenSpec change directory (defaults to the first target). */
  primaryProject?: string
  projectRoot?: string
  /** Origin of the proposal (change `add-feedback-loop`). */
  source?: ProposalSource
  /** External reference for `source` (ticket id, alert id, URL). */
  sourceRef?: string
  /** Related proposal ids. */
  relatesTo?: string[]
  /** Capture facts for externally derived input. */
  provenance?: Provenance
  /** Free-form problem statement rendered into the seeded `proposal.md`. */
  notes?: string
}

const PROPOSAL_SOURCES: ProposalSource[] = ['spec', 'incident', 'review-finding', 'metric-regression', 'maintenance']

export interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): void
}

export function mountWorkmateApi(webServer: WebServerLike, deps: ApiDeps): void {
  const router = new Router()
  registerApiRoutes(router, deps)
  const assetsDir = join(dirname(fileURLToPath(import.meta.url)), 'client')

  webServer.register({
    kind: 'prefix',
    path: '/workmate',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://local')
      const pathname = url.pathname
      if (pathname.startsWith('/workmate/api/')) {
        await router.handle(pathname.replace(/^\/workmate/, '') + url.search, req, res)
        return
      }
      const relative = pathname.replace(/^\/workmate\/?/, '') || 'index.html'
      await router.serveStatic('/' + relative, res, assetsDir)
    },
  })
}

export function registerApiRoutes(router: Router, deps: ApiDeps): void {

  // 任务面板的写侧与回收入口（change `adopt-superagent-openspec-source`）。
  // 它们与团队路由不是同一件事：`remove-team-executor` 曾把这一段连同
  // `/api/team/*` 一起删掉，导致面板主视图整体 404（真机复核发现）。
  router.get('/api/worktrees/leftover', async () => {
    if (deps.worktreeReclaim === undefined) return { entries: [], note: '回收服务未装配' }
    return await deps.worktreeReclaim.leftover()
  })

  router.post('/api/worktrees/reclaim', async (r) => {
    if (deps.worktreeReclaim === undefined) throw new Error('回收服务未装配：本 profile 缺少 worktree 回收依赖')
    const body = await readJsonBody<{ taskId?: string; force?: boolean }>(r.req)
    const taskId = (body.taskId ?? '').trim()
    if (taskId === '') throw new Error('taskId 必填 — 一次只回收一个任务，避免误删')
    return await deps.worktreeReclaim.reclaim(taskId, { force: body.force === true })
  })

  // 执行器只有一个（Super-agent）；保留该端点供旧客户端读取。
  router.get('/api/config', async () => ({ taskExecutor: 'superagent' as const }))

  router.get('/api/tasks', async () => {
    if (deps.tasks === undefined) throw new Error('任务服务未装配：本 profile 缺少 taskFile 配置')
    return deps.tasks.board()
  })

  router.post('/api/tasks', async (r) => {
    if (deps.tasks === undefined) throw new Error('任务服务未装配：本 profile 缺少 taskFile 配置')
    const body = await readJsonBody<{
      intent?: string
      repo?: string
      baseBranch?: string
      acceptance?: string
      priority?: string
      mode?: string
      proposalId?: string
      dependsOn?: string[]
    }>(r.req)
    const intent = (body.intent ?? '').trim()
    if (intent === '') throw new Error('目标不能为空')
    const priority = body.priority === 'P0' || body.priority === 'P1' ? body.priority : 'P2'
    const mode = body.mode === 'superagent' || body.mode === 'proposal' ? body.mode : 'record'
    const repo = (body.repo ?? deps.projectRoot ?? '').trim()
    const task = await deps.tasks.create({
      intent,
      repo,
      ...(body.baseBranch !== undefined ? { baseBranch: body.baseBranch } : {}),
      ...(body.acceptance !== undefined ? { acceptance: body.acceptance } : {}),
      priority,
      mode,
      ...(body.proposalId !== undefined ? { proposalId: body.proposalId } : {}),
      ...(body.dependsOn !== undefined ? { dependsOn: body.dependsOn } : {}),
    })
    // `mode: 'proposal'` 必须真的建一条提案草稿，否则单选里的
    // 「先走方案评审与 planHash」是空承诺（真机 2026-11-10：选中它创建的仍是普通待办）。
    // 提案不置 assigned：指派与否由人在提案视图里决定。
    if (mode === 'proposal' && body.proposalId === undefined) {
      const created = await createProposal(deps, {
        id: task.id,
        title: intent.split('\n')[0]?.slice(0, 120) ?? intent.slice(0, 120),
        projects: repo === '' ? [] : [repo],
        source: 'spec',
      })
      return { task, proposal: created.proposal }
    }
    return { task }
  })

  router.post('/api/tasks/:id/assign', async (r) => {
    if (deps.tasks === undefined) throw new Error('任务服务未装配：本 profile 缺少 taskFile 配置')
    return { task: await deps.tasks.assign(r.params['id'] ?? '') }
  })

  router.post('/api/tasks/:id/retry', async (r) => {
    if (deps.tasks === undefined) throw new Error('任务服务未装配：本 profile 缺少 taskFile 配置')
    return { task: await deps.tasks.assign(r.params['id'] ?? '', { retry: true }) }
  })

  router.post('/api/tasks/:id/reply', async (r) => {
    if (deps.tasks === undefined) throw new Error('任务服务未装配：本 profile 缺少 taskFile 配置')
    const body = await readJsonBody<{ text?: string; replyTo?: string }>(r.req)
    const text = (body.text ?? '').trim()
    if (text === '') throw new Error('回答不能为空')
    return await deps.tasks.reply(r.params['id'] ?? '', text, {
      ...(body.replyTo !== undefined ? { replyTo: body.replyTo } : {}),
    })
  })

  router.post('/api/tasks/:id/stop', async (r) => {
    if (deps.tasks === undefined) throw new Error('任务服务未装配：本 profile 缺少 taskFile 配置')
    return await deps.tasks.stop(r.params['id'] ?? '')
  })

  router.post('/api/tasks/:id/reopen', async (r) => {
    if (deps.tasks === undefined) throw new Error('任务服务未装配：本 profile 缺少 taskFile 配置')
    return { task: await deps.tasks.reopen(r.params['id'] ?? '') }
  })

  router.get('/api/proposals', async () => {
    const proposals = await deps.proposals.list()
    return { proposals }
  })

  router.get('/api/proposals/:id/readiness', async (r) => {
    const id = r.params['id'] ?? ''
    const proposal = await deps.proposals.get(id)
    if (proposal === undefined) throw new Error(`proposal not found: ${id}`)
    const primary = proposal.primaryProject ?? proposal.projects[0]
    const registered = primary === undefined ? undefined : await deps.registry.get(primary)
    const root = (registered?.root ?? deps.projectRoot).trim() || undefined
    return assessReadiness(proposal, {
      ...(root !== undefined ? { projectRoot: root } : {}),
      openspecRoot: deps.openspecRoot,
    })
  })

  router.post('/api/proposals', async (r) => {
    const body = await readJsonBody<CreateProposalBody>(r.req)
    return createProposal(deps, body)
  })

  router.get('/api/proposals/:id/events', async (r) => {
    const id = r.params['id'] ?? ''
    const proposal = await deps.proposals.get(id)
    if (proposal === undefined) throw new Error(`proposal not found: ${id}`)
    const read = deps.events === undefined ? { events: [] } : await deps.events.read()
    return { events: read.events.filter((event) => event.proposalId === id) }
  })

  router.get('/api/proposals/:id', async (r) => {
    const root = resolveRoot(deps, r.query.get('projectRoot') ?? undefined)
    return buildProposalStatus(deps.proposals, r.params['id'] ?? '', {
      projectRoot: root || undefined,
      openspecRoot: deps.openspecRoot,
      resolveRoot: async (name) => (await deps.registry.get(name))?.root,
      withReviewReport: true,
      approvalsRequired: deps.approvalsRequired ?? CONFIG_DEFAULTS.approvalsRequired,
      allowAgentApproval: deps.allowAgentApproval ?? CONFIG_DEFAULTS.allowAgentApproval,
      reviewBlockingSeverities: deps.reviewBlockingSeverities ?? CONFIG_DEFAULTS.reviewBlockingSeverities,
    })
  })

  router.post('/api/proposals/:id/advance', async (r) => {
    // The panel/API path is the HUMAN actor: it is the only way across a gated
    // state (separation of duties, change `add-approval-records`).
    const body = await readJsonBody<{ rationale?: string }>(r.req).catch(() => ({}) as { rationale?: string })
    const result = await deps.archive.advance(r.params['id'] ?? '', {
      actor: 'human',
      ...(body.rationale !== undefined ? { rationale: body.rationale } : {}),
    })
    return { proposal: result.proposal, ...(result.worktree !== undefined ? { worktree: result.worktree } : {}) }
  })

  router.post('/api/proposals/:id/transition', async (r) => {
    const body = await readJsonBody<{ to?: string; rationale?: string }>(r.req)
    const to = body.to ?? ''
    if (!isProposalState(to)) {
      throw new Error(`unknown state '${to}' — valid: ${PROPOSAL_STATES.join(', ')}`)
    }
    const result = await deps.archive.transition(r.params['id'] ?? '', to, {
      actor: 'human',
      ...(body.rationale !== undefined ? { rationale: body.rationale } : {}),
    })
    return { proposal: result.proposal, ...(result.worktree !== undefined ? { worktree: result.worktree } : {}) }
  })

  router.post('/api/proposals/:id/archive', async (r) => {
    // `force` **跳过三道门**（审查门 / 任务门 / 计划漂移门），不只是审查门——
    // 旧注释与面板文案都写「只跳过审查门」，与实际行为不符（实测 2026-11-10）。
    // openspec + gitnexus 步骤与 archiving 前置仍然生效。
    // `rationale` 必须解析并落库：面板强制填写的理由曾被这里丢弃。
    const body = await readJsonBody<{ force?: boolean; rationale?: string }>(r.req).catch(() => ({ force: false, rationale: '' }))
    const rationale = typeof body.rationale === 'string' ? body.rationale.trim() : ''
    const result = await deps.archive.runArchive(r.params['id'] ?? '', {
      force: body.force === true,
      actor: 'human',
      ...(rationale !== '' ? { rationale } : {}),
    })
    return { proposal: result.proposal, ...(result.orchestration !== undefined ? { orchestration: result.orchestration } : {}) }
  })

  const bandsRunner = async (r: { query: URLSearchParams }, apply: boolean): Promise<unknown> => {
    // The proposal store already resolved the DSH home for us.
    const bandsFile = deps.bandsFile ?? join(deps.proposals.rootDir(), 'bands.json')
    const windowDays = r.query.get('windowDays')
    if (deps.events === undefined) {
      // Read-only fallback for embeddings without an event log.
      const config = await loadBands(bandsFile)
      const evaluations = evaluateBands(await deps.proposals.list(), [], {
        config,
        ...(windowDays !== null && windowDays !== '' ? { windowDays: Number(windowDays) } : {}),
      })
      return { evaluations, rules: config.rules, windowDays: config.windowDays }
    }
    const result = await runBandsCheck(
      {
        proposals: deps.proposals,
        events: deps.events,
        bandsFile,
        createProposal: async (input) => {
          const created = await createProposal(deps, input)
          return { id: created.proposal.id }
        },
      },
      {
        apply,
        ...(windowDays !== null && windowDays !== '' ? { windowDays: Number(windowDays) } : {}),
      },
    )
    const config = await loadBands(bandsFile)
    return { ...result, rules: config.rules }
  }

  // GET stays read-only: no band-breach events, no proposals (design D2).
  router.get('/api/bands', async (r) => {
    const bandsFile = deps.bandsFile ?? join(deps.proposals.rootDir(), 'bands.json')
    const config = await loadBands(bandsFile)
    const windowDays = r.query.get('windowDays')
    const evaluations = evaluateBands(await deps.proposals.list(), (await deps.events?.read())?.events ?? [], {
      config,
      ...(windowDays !== null && windowDays !== '' ? { windowDays: Number(windowDays) } : {}),
    })
    return { evaluations, rules: config.rules, windowDays: config.windowDays }
  })

  router.post('/api/bands', async (r) => {
    const body = await readJsonBody<{ apply?: boolean; windowDays?: number }>(r.req).catch(
      (): { apply?: boolean; windowDays?: number } => ({}),
    )
    if (body.windowDays !== undefined) {
      r.query.set('windowDays', String(body.windowDays))
    }
    return bandsRunner(r, body.apply === true)
  })

  router.get('/api/metrics', async (r) => {
    const id = r.query.get('id')
    const read = deps.events === undefined ? { events: [], skippedLines: 0 } : await deps.events.read()
    if (id !== null && id !== '') {
      const proposal = await deps.proposals.get(id)
      if (!proposal) throw new Error(`proposal not found: ${id}`)
      return { id, metrics: proposalMetrics(proposal, read.events), skippedLines: read.skippedLines }
    }
    return { metrics: aggregateMetrics(await deps.proposals.list(), read.events, { skippedLines: read.skippedLines }) }
  })

  router.post('/api/wiki/export', async (r) => {
    if (deps.vaultExport === undefined) throw new Error('vault export is not wired in this profile')
    type ExportBody = { projectRoot?: string; vaultPath?: string; gitCommit?: boolean }
    const body = await readJsonBody<ExportBody>(r.req).catch((): ExportBody => ({}))
    const projectRoot = resolveRoot(deps, body.projectRoot)
    return deps.vaultExport({
      projectRoot,
      ...(body.vaultPath !== undefined ? { vaultPath: body.vaultPath } : {}),
      ...(body.gitCommit !== undefined ? { gitCommit: body.gitCommit } : {}),
    })
  })

  router.post('/api/wiki/search', async (r) => {
    if (deps.wikiSearch === undefined) throw new Error('vault search is not wired in this profile')
    type SearchBody = { query?: string; project?: string; limit?: number; semantic?: boolean }
    const body = await readJsonBody<SearchBody>(r.req).catch((): SearchBody => ({}))
    if (body.query === undefined || body.query === '') throw new Error('query is required')
    return deps.wikiSearch({
      query: body.query,
      ...(body.project !== undefined ? { project: body.project } : {}),
      ...(body.limit !== undefined ? { limit: body.limit } : {}),
      ...(body.semantic !== undefined ? { semantic: body.semantic } : {}),
    })
  })

  router.post('/api/wiki', async (r) => {
    if (deps.gitnexusEnabled === false) return { note: 'gitnexus bridge disabled by config (gitnexusEnabled: false)' }
    const wikiBody = { projectRoot: '', analyze: false, force: false, lang: '' }
    const parsed = await readJsonBody<typeof wikiBody>(r.req).catch(() => wikiBody)
    const body = { ...wikiBody, ...parsed }
    if (body.projectRoot === '') throw new Error('projectRoot is required')
    const credentials = describeGitnexusCredentials({
      env: process.env,
      fromEnvName: deps.gitnexusApiKeyFromEnv ?? '',
      keychainService: deps.gitnexusApiKeyKeychainService ?? '',
    })
    const sseProxy = await ensureSseProxy({
      enabled: deps.gitnexusSseProxyEnabled === true,
      port: deps.gitnexusSseProxyPort ?? 8787,
      upstream: deps.gitnexusSseProxyUpstream ?? '',
    })
    const status = body.analyze === true ? undefined : await gitnexusStatus(body.projectRoot)
    let analyzed = false
    if (body.analyze === true) {
      const reindex = await gitnexusAnalyze(body.projectRoot, { force: false })
      analyzed = reindex.note === undefined
    }
    const result = await gitnexusWiki(body.projectRoot, {
      ...(body.force === true ? { force: true } : {}),
      lang: body.lang ?? deps.gitnexusWikiLang ?? '',
      ...(deps.gitnexusWikiTimeoutMs !== undefined ? { timeoutMs: deps.gitnexusWikiTimeoutMs } : {}),
    })
    return {
      projectRoot: body.projectRoot,
      analyzed,
      stale: analyzed ? false : (status?.stale ?? true),
      wikiDir: result.wikiDir,
      indexHtml: result.indexHtml,
      pages: result.pages,
      complete: result.complete,
      sseProxy,
      credentials,
      output: result.output,
      ...(result.note !== undefined ? { note: result.note } : {}),
    }
  })

  router.post('/api/proposals/:id/plan-approve', async (r) => {
    const body = await readJsonBody<{ rationale?: string }>(r.req)
    const id = r.params['id'] ?? ''
    const result = await deps.archive.approvePlan(id, {
      ...(body.rationale !== undefined ? { rationale: body.rationale } : {}),
    })
    return result
  })

  router.post('/api/proposals/:id/reject-merge', async (r) => {
    const body = await readJsonBody<{ category?: string; rationale?: string }>(r.req)
    const category = body.category
    if (category !== 'plan' && category !== 'implementation') {
      throw new Error("category must be 'plan' or 'implementation'")
    }
    if (body.rationale === undefined || body.rationale.trim() === '') throw new Error('rationale is required')
    return deps.archive.rejectMerge(r.params['id'] ?? '', {
      category,
      rationale: body.rationale,
      actor: 'human',
    })
  })

  router.post('/api/proposals/:id/reconcile', async (r) => {
    return deps.archive.reconcile(r.params['id'] ?? '')
  })

  router.get('/api/projects', async () => {
    return { projects: await deps.registry.list() }
  })

  router.post('/api/projects', async (r) => {
    const body = await readJsonBody<CreateProjectBody>(r.req)
    const name = (body.name ?? '').trim()
    const root = (body.root ?? '').trim()
    const registered = await deps.registry.upsert(name, root, {
      ...(body.defaultBranch !== undefined ? { defaultBranch: body.defaultBranch } : {}),
      ...(body.workspace !== undefined ? { workspace: body.workspace } : {}),
    })
    return { project: registered }
  })

  router.get('/api/isolation', async () => {
    const proposals = await deps.proposals.list()
    const occupancy = deriveBranchOccupancy(proposals, deps.lifecycleMainBranch ?? 'main')
    return { occupancy, conflicts: findBranchConflicts(occupancy) }
  })

  router.get('/api/isolation/drift', async () => {
    const drifts = []
    for (const proposal of await deps.proposals.list()) {
      if (!isOccupying(proposal)) continue
      for (const target of effectiveTargets(proposal, deps.lifecycleMainBranch ?? 'main')) {
        const project = await deps.registry.get(target.project)
        if (project === undefined) continue
        const drift = await checkTargetDrift(project.root, target)
        if (drift !== undefined) drifts.push(drift)
      }
    }
    return { drifts }
  })

  router.get('/api/isolation/writes', async () => {
    const proposals = await deps.proposals.list()
    const claims: Array<{ proposalId: string; project: string; writes: string[] }> = []
    for (const proposal of proposals) {
      if (!isOccupying(proposal)) continue
      for (const target of effectiveTargets(proposal, deps.lifecycleMainBranch ?? 'main')) {
        const project = await deps.registry.get(target.project)
        if (project === undefined) continue
        const writes = await readProposalWriteScopes(project.root, deps.openspecRoot, proposal.openspecChangeId)
        if (writes.length > 0) claims.push({ proposalId: proposal.id, project: target.project, writes })
      }
    }
    return { claims, conflicts: findWriteConflicts(claims) }
  })

  router.get('/api/projects/candidates', async () => {
    const workspaceRegistry = deps.workspaceRegistry?.()
    if (workspaceRegistry === undefined) {
      return { candidates: [], note: '宿主未提供 workspaceRegistry — 手动注册项目' }
    }
    return { candidates: await listWorkspaceCandidates(workspaceRegistry, deps.registry) }
  })

  router.get('/api/projects/:name/status', async (r) => {
    const name = r.params['name'] ?? ''
    const project = await deps.registry.get(name)
    if (project === undefined) throw new Error(`project not found: ${name}`)
    const status = await getProjectGitStatus(project.root)
    return { project: name, ...(status !== undefined ? { status } : {}) }
  })

  router.get('/api/projects/:name/branches', async (r) => {
    const name = r.params['name'] ?? ''
    const project = await deps.registry.get(name)
    if (project === undefined) {
      const known = (await deps.registry.list()).map((entry) => entry.name)
      throw new Error(`project not found: ${name}（已注册：${known.join(', ') || '无'}）`)
    }
    return {
      project: project.name,
      branches: await listProjectBranches(project.root, project.defaultBranch),
    }
  })

  router.delete('/api/projects/:name', async (r) => {
    const removed = await deps.registry.remove(r.params['name'] ?? '')
    return { removed }
  })
  router.get('/api/graph', async (r) => {
    return buildGraphData(deps, resolveRoot(deps, r.query.get('projectRoot') ?? undefined) || undefined, {
      includeArchived: r.query.get('scope') === 'all',
    })
  })
  router.post('/api/proposals/:id/wiki-links', async (r) => {
    const body = await readJsonBody<{ url?: string; pageType?: string; version?: number; commit?: string; taskId?: string }>(r.req)
    const link = await linkWikiToProposal(deps.proposals, r.params['id'] ?? '', {
      url: body.url ?? '',
      pageType: body.pageType ?? '',
      ...(body.version !== undefined ? { version: body.version } : {}),
      ...(body.commit !== undefined ? { commit: body.commit } : {}),
      ...(body.taskId !== undefined ? { taskId: body.taskId } : {}),
    })
    return { link }
  })

  router.post('/api/proposals/:id/decisions', async (r) => {
    const body = await readJsonBody<{ decision?: string; rationale?: string; supersedes?: string }>(r.req)
    const entry = await deps.proposals.addDecision(r.params['id'] ?? '', {
      decision: body.decision ?? '',
      rationale: body.rationale ?? '',
      ...(body.supersedes !== undefined ? { supersedes: body.supersedes } : {}),
    })
    return { decision: entry }
  })

  router.post('/api/proposals/:id/unabandon', async (r) => {
    return { proposal: await deps.proposals.unabandon(r.params['id'] ?? '', 'human') }
  })

  router.post('/api/proposals/:id/abandon', async (r) => {
    const body = await readJsonBody<{ reason?: string }>(r.req)
    const proposal = await deps.proposals.abandon(r.params['id'] ?? '', body.reason ?? '')
    return { proposal }
  })

  router.post('/api/proposals/:id/block', async (r) => {
    const body = await readJsonBody<{ question?: string; tried?: string }>(r.req)
    const blocker = await deps.proposals.block(r.params['id'] ?? '', {
      question: body.question ?? '',
      ...(body.tried !== undefined ? { tried: body.tried } : {}),
    })
    return { blocker }
  })

  router.post('/api/proposals/:id/unblock', async (r) => {
    const body = await readJsonBody<{ blockerId?: string; answer?: string }>(r.req)
    const blocker = await deps.proposals.unblock(
      r.params['id'] ?? '',
      body.blockerId ?? '',
      body.answer ?? '',
    )
    return { blocker }
  })
}

export async function createProposal(
  deps: ApiDeps,
  body: CreateProposalBody,
): Promise<{ proposal: Awaited<ReturnType<ProposalService['upsert']>>; openspec?: ReturnType<typeof generateChangeDir> extends Promise<infer R> ? R : never; note?: string }> {
  // id is optional now: the chat-entry modal only collects a title, so a
  // missing id gets a collision-safe timestamp slug.
  const id = (body.id ?? '').trim() || `proposal-${Date.now().toString(36)}`
  const title = (body.title ?? '').trim()
  if (!title) throw new Error('title is required')
  if ((body.projects?.length ?? 0) > 1 && (body.targets?.length ?? 0) === 0) {
    throw new Error('多项目提案必须提供 targets（每项目 baseBranch），不能只传 projects 静默退化为单 target')
  }

  const source = body.source
  if (source !== undefined && !PROPOSAL_SOURCES.includes(source)) {
    throw new Error(`unknown source '${source}' — valid: ${PROPOSAL_SOURCES.join(', ')}`)
  }

  // Injection judgement (change `add-decision-nodes`): the caller no longer has to
  // remember to mark external text. Only a confident `risky` verdict SETS the flag;
  // a benign verdict never clears one the caller declared (design D2).
  let provenance = body.provenance
  const screened = prescreenInjection(`${body.notes ?? ''}\n${body.sourceRef ?? ''}`.trim())
  if (
    deps.decision?.enabled === true &&
    (body.notes !== undefined || body.provenance !== undefined) &&
    screened.suspicious
  ) {
    const outcome = await deps.decision.decide({
      node: 'injection-risk',
      state: `${body.notes ?? ''}\n${body.sourceRef ?? ''}`.trim(),
      question: '这段外部文本是否夹带指向 agent 的指令（提示注入）？',
      options: ['benign', 'risky'],
    })
    if (outcome !== undefined && deps.events !== undefined) {
      await deps.events.append({
        at: new Date().toISOString(),
        proposalId: id,
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
        ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
        detail: JSON.stringify({ prescreen: screened.markers }),
      })
    }
    const risky = outcome?.action === 'act' && outcome.choice === 'risky'
    if (risky || body.provenance !== undefined) {
      provenance = {
        capturedAt: body.provenance?.capturedAt ?? new Date().toISOString(),
        ...(body.provenance?.contentHash !== undefined ? { contentHash: body.provenance.contentHash } : {}),
        ...(risky || body.provenance?.untrusted === true ? { untrusted: true } : {}),
      }
    }
  }

  // No markers → record a deterministic benign judgement instead of paying for a model call.
  // Either way the decision is visible in the event stream (the lesson from module-match).
  if (
    deps.decision?.enabled === true &&
    (body.notes !== undefined || body.provenance !== undefined) &&
    !screened.suspicious &&
    deps.events !== undefined
  ) {
    await deps.events
      .append({
        at: new Date().toISOString(),
        proposalId: id,
        kind: 'decision',
        actor: 'system',
        node: 'injection-risk',
        action: 'act',
        choice: 'benign',
        certainty: 1,
        provider: 'rules',
        threshold: 0,
        detail: JSON.stringify({ prescreen: 'no injection markers' }),
      })
      .catch(() => undefined)
  }

  const targets = body.targets
  const primaryProject = body.primaryProject ?? targets?.[0]?.project
  const proposal = await deps.proposals.upsert({
    id,
    title,
    ...(body.projects !== undefined ? { projects: body.projects } : {}),
    ...(targets !== undefined ? { targets } : {}),
    ...(primaryProject !== undefined ? { primaryProject } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(body.sourceRef !== undefined ? { sourceRef: body.sourceRef } : {}),
    ...(body.relatesTo !== undefined ? { relatesTo: body.relatesTo } : {}),
    ...(provenance !== undefined ? { provenance } : {}),
  })

  const explicitRoot = (body.projectRoot ?? '').trim()
  const registered =
    explicitRoot === '' && primaryProject !== undefined ? await deps.registry.get(primaryProject) : undefined
  const projectRoot = explicitRoot !== '' ? explicitRoot : (registered?.root ?? deps.projectRoot)
  if (!projectRoot) {
    const reason =
      primaryProject !== undefined
        ? `primary project '${primaryProject}' 未注册根，且没有可用的默认 projectRoot — openspec directory not generated`
        : 'no projectRoot — openspec directory not generated'
    return { proposal, note: reason }
  }
  validateProjectRoot(projectRoot)
  const templateInput = {
    ...(source !== undefined ? { source } : {}),
    ...(body.sourceRef !== undefined ? { sourceRef: body.sourceRef } : {}),
    ...(body.relatesTo !== undefined ? { relatesTo: body.relatesTo } : {}),
    ...(provenance !== undefined ? { provenance } : {}),
    ...(body.notes !== undefined ? { notes: body.notes } : {}),
  }
  const openspec = await generateChangeDir(projectRoot, deps.openspecRoot, id, title, templateInput)
  const secondaryOpenspec: Array<{ project: string; status: string; dir: string }> = []
  if (deps.openspecTargets === 'all' && targets !== undefined && targets.length > 1) {
    for (const target of targets.slice(1)) {
      if (target.project === primaryProject) continue
      const registeredTarget = await deps.registry.get(target.project)
      if (registeredTarget?.root === undefined) continue
      const created = await generateChangeDir(registeredTarget.root, deps.openspecRoot, id, title, templateInput)
      if (created.dir !== undefined) secondaryOpenspec.push({ project: target.project, status: created.status, dir: created.dir })
    }
  }

  let qualitySync: Awaited<ReturnType<typeof syncProjectAssets>> | undefined
  if (deps.qualitySyncEnabled) {
    qualitySync = await syncProjectAssets(projectRoot, { claudeAssets: deps.claudeAssetsEnabled })
  }
  return {
    proposal,
    openspec,
    ...(secondaryOpenspec.length > 0 ? { openspecSecondary: secondaryOpenspec } : {}),
    ...(qualitySync !== undefined
      ? { qualitySync: { written: qualitySync.written, skipped: qualitySync.skipped, note: qualitySync.note } }
      : {}),
  }
}

/** Aggregate the knowledge-graph face (M5) alongside per-proposal data. */
export async function buildGraphData(
  deps: ApiDeps,
  projectRoot: string | undefined,
  options: { includeArchived?: boolean } = {},
): Promise<GraphPayload> {
  const proposals = (await deps.proposals.list()).filter(
    (proposal) =>
      proposal.abandonedAt === undefined && (options.includeArchived === true || proposal.status !== 'archived'),
  )
  const nodes: GraphPayload['nodes'] = []
  const edges: GraphPayload['edges'] = []
  const projectNodes = new Set<string>()
  const commitNodes = new Set<string>()

  for (const proposal of proposals) {
    nodes.push({ kind: 'proposal', id: `proposal:${proposal.id}`, label: proposal.title, status: proposal.status })
    for (const project of proposal.projects) {
      if (!projectNodes.has(project)) {
        projectNodes.add(project)
        nodes.push({ kind: 'project', id: `project:${project}`, label: project })
      }
      edges.push({ from: `proposal:${proposal.id}`, to: `project:${project}`, relation: '涉及' })
    }
    if (projectRoot) {
      const { commits } = await listProposalCommits(projectRoot, proposal.id)
      for (const commit of commits) {
        if (commitNodes.has(commit.hash)) continue
        commitNodes.add(commit.hash)
        nodes.push({ kind: 'commit', id: `commit:${commit.hash}`, label: commit.short })
        edges.push({ from: `project:${proposal.projects[0] ?? proposal.id}`, to: `commit:${commit.hash}`, relation: '提交' })
      }
    }
  }
  return { nodes, edges, generatedAt: new Date().toISOString() }
}

export interface GraphPayload {
  nodes: Array<{ kind: 'proposal' | 'project' | 'commit'; id: string; label: string; status?: string }>
  edges: Array<{ from: string; to: string; relation: string }>
  generatedAt: string
}

export { readChangeState }
