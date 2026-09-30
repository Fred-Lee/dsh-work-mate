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
import type { ProposalService } from './features/proposal/service.ts'
import type { LifecycleServiceImpl } from './features/archive/service.ts'
import { PROPOSAL_STATES, isProposalState } from './features/proposal/state-machine.ts'
import { linkWikiToProposal } from './features/wiki/links.ts'
import type { ProjectRegistry } from './features/project/registry.ts'
import { syncProjectAssets } from './features/quality/sync.ts'
import { buildProposalStatus } from './features/proposal/status.ts'
import { generateChangeDir, readChangeState, validateProjectRoot } from './features/proposal/openspec.ts'
import { listProposalCommits } from './features/proposal/git.ts'

/** Explicit per-call root wins, then the config default, else disabled. */
function resolveRoot(deps: ApiDeps, explicit?: string): string {
  return explicit || deps.projectRoot || ''
}

export interface ApiDeps {
  proposals: ProposalService
  archive: LifecycleServiceImpl
  registry: ProjectRegistry
  openspecRoot: string
  /** Config-level default project root; may be empty. */
  projectRoot: string
  /** Sync quality assets into the target project on creation. @default true */
  qualitySyncEnabled: boolean
}

export interface CreateProjectBody {
  name?: string
  root?: string
}

export interface CreateProposalBody {
  id?: string
  title?: string
  projects?: string[]
  projectRoot?: string
}

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

  router.get('/api/proposals', async () => {
    const proposals = await deps.proposals.list()
    return { proposals }
  })

  router.post('/api/proposals', async (r) => {
    const body = await readJsonBody<CreateProposalBody>(r.req)
    return createProposal(deps, body)
  })

  router.get('/api/proposals/:id', async (r) => {
    const root = resolveRoot(deps, r.query.get('projectRoot') ?? undefined)
    return buildProposalStatus(deps.proposals, r.params['id'] ?? '', {
      projectRoot: root || undefined,
      openspecRoot: deps.openspecRoot,
      resolveRoot: async (name) => (await deps.registry.get(name))?.root,
      withReviewReport: true,
    })
  })

  router.post('/api/proposals/:id/advance', async (r) => {
    const result = await deps.archive.advance(r.params['id'] ?? '')
    return { proposal: result.proposal, ...(result.worktree !== undefined ? { worktree: result.worktree } : {}) }
  })

  router.post('/api/proposals/:id/transition', async (r) => {
    const body = await readJsonBody<{ to?: string }>(r.req)
    const to = body.to ?? ''
    if (!isProposalState(to)) {
      throw new Error(`unknown state '${to}' — valid: ${PROPOSAL_STATES.join(', ')}`)
    }
    const result = await deps.archive.transition(r.params['id'] ?? '', to)
    return { proposal: result.proposal, ...(result.worktree !== undefined ? { worktree: result.worktree } : {}) }
  })

  router.post('/api/proposals/:id/archive', async (r) => {
    // `force` skips the review gate only (missing review.md / unresolved
    // CRITICAL); the openspec + gitnexus steps and the archiving precondition
    // still apply. An empty body keeps the gate on.
    const body = await readJsonBody<{ force?: boolean }>(r.req).catch(() => ({ force: false }))
    const result = await deps.archive.runArchive(r.params['id'] ?? '', { force: body.force === true })
    return { proposal: result.proposal, ...(result.orchestration !== undefined ? { orchestration: result.orchestration } : {}) }
  })

  router.get('/api/projects', async () => {
    return { projects: await deps.registry.list() }
  })

  router.post('/api/projects', async (r) => {
    const body = await readJsonBody<CreateProjectBody>(r.req)
    const name = (body.name ?? '').trim()
    const root = (body.root ?? '').trim()
    const registered = await deps.registry.upsert(name, root)
    return { project: registered }
  })

  router.delete('/api/projects/:name', async (r) => {
    const removed = await deps.registry.remove(r.params['name'] ?? '')
    return { removed }
  })
  router.get('/api/graph', async (r) => {
    return buildGraphData(deps, resolveRoot(deps, r.query.get('projectRoot') ?? undefined) || undefined)
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

  const proposal = await deps.proposals.upsert({
    id,
    title,
    ...(body.projects !== undefined ? { projects: body.projects } : {}),
  })

  const projectRoot = resolveRoot(deps, body.projectRoot)
  if (!projectRoot) {
    return { proposal, note: 'no projectRoot — openspec directory not generated' }
  }
  validateProjectRoot(projectRoot)
  const openspec = await generateChangeDir(projectRoot, deps.openspecRoot, id, title)

  let qualitySync: Awaited<ReturnType<typeof syncProjectAssets>> | undefined
  if (deps.qualitySyncEnabled) {
    qualitySync = await syncProjectAssets(projectRoot)
  }
  return {
    proposal,
    openspec,
    ...(qualitySync !== undefined
      ? { qualitySync: { written: qualitySync.written, skipped: qualitySync.skipped, note: qualitySync.note } }
      : {}),
  }
}

/** Aggregate the knowledge-graph face (M5) alongside per-proposal data. */
export async function buildGraphData(deps: ApiDeps, projectRoot: string | undefined): Promise<GraphPayload> {
  const proposals = await deps.proposals.list()
  const nodes: GraphPayload['nodes'] = []
  const edges: GraphPayload['edges'] = []

  for (const proposal of proposals) {
    nodes.push({ kind: 'proposal', id: `proposal:${proposal.id}`, label: proposal.title, status: proposal.status })
    for (const project of proposal.projects) {
      nodes.push({ kind: 'project', id: `project:${project}`, label: project })
      edges.push({ from: `proposal:${proposal.id}`, to: `project:${project}`, relation: '涉及' })
    }
    if (projectRoot) {
      const { commits } = await listProposalCommits(projectRoot, proposal.id)
      for (const commit of commits) {
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
