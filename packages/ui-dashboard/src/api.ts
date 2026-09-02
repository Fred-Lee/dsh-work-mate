/**
 * Dashboard REST API — thin JSON façade over the helmsman services.
 * Pure factory so the routes can be unit-tested without a real HTTP server.
 */
import type { OrchestratorService } from '@helmsman/orchestrator'
import type { ProjectTopology } from '@helmsman/memory-topology'
import { readJsonBody, Router } from './http.ts'

export interface DashboardApiDeps {
  orchestrator: OrchestratorService
  topology?: TopologyServiceLike
}

export interface TopologyServiceLike {
  listGroups(): Promise<string[]>
  loadTopology(group: string): Promise<ProjectTopology | null>
  saveTopology(topology: ProjectTopology): Promise<void>
  deleteGroup(group: string): Promise<boolean>
  createGroup(group: string, name?: string): Promise<ProjectTopology>
  scanRestApis(localPath: string): Promise<Array<{ method: string; path: string; handler?: string; description?: string }>>
  importPreview(source: 'docker-compose' | 'kubernetes' | 'openapi', text: string, inferDeps?: boolean): Promise<unknown>
  importApply(group: string, preview: unknown): Promise<ProjectTopology>
  exportYaml(group: string): Promise<string>
}

export function createApiRouter(deps: DashboardApiDeps): Router {
  const router = new Router()
  const { orchestrator, topology } = deps

  router.get('api/state', async () => {
    const [agents, tasks] = [await orchestrator.checkAgents(), orchestrator.listTasks()]
    return {
      serverTime: Date.now(),
      groups: topology ? await topology.listGroups() : [],
      agents,
      tasks: tasks.map(summarizeTask),
      usage: orchestrator.getUsage(),
    }
  })

  router.post('api/task', async ({ req }) => {
    const body = await readJsonBody(req)
    const prompt = String(body.prompt ?? '')
    const agents = Array.isArray(body.agents) ? body.agents.map(String) : []
    const result = await orchestrator.runParallelTask({
      prompt,
      agents,
      ...(typeof body.projectGroupId === 'string' && body.projectGroupId ? { projectGroupId: body.projectGroupId } : {}),
      ...(typeof body.repoPath === 'string' && body.repoPath ? { repoPath: body.repoPath } : {}),
      ...(body.cascade === true ? { cascade: true } : {}),
      ...(typeof body.timeoutSec === 'number' ? { timeoutSec: body.timeoutSec } : {}),
    })
    return result
  })

  router.post('api/task/:id/cancel', async ({ params }) => {
    orchestrator.cancelTask(params.id!)
    return { ok: true, taskId: params.id }
  })

  router.post('api/task/:id/retry', async ({ req, params }) => {
    const body = await readJsonBody(req)
    const agents = Array.isArray(body.agents) ? body.agents.map(String) : undefined
    return await orchestrator.retryTask(params.id!, agents)
  })

  router.get('api/task/:id/log', async ({ params, query }) => {
    const agent = query.get('agent') ?? ''
    const task = orchestrator.getTaskStatus(params.id!)
    const run = task?.agents[agent]
    return { agent, log: run?.log ?? '', state: run?.state ?? null }
  })

  router.post('api/task/:id/merge', async ({ req, params }) => {
    const body = await readJsonBody(req)
    return await orchestrator.mergeTask({
      taskId: params.id!,
      ...(Array.isArray(body.agents) ? { agents: body.agents.map(String) } : {}),
      ...(Array.isArray(body.files) ? { files: body.files.map(String) } : {}),
      ...(body.discardAfterMerge === true ? { discardAfterMerge: true } : {}),
    })
  })

  router.post('api/task/:id/discard', async ({ params }) => {
    await orchestrator.discardTask(params.id!)
    return { ok: true }
  })

  if (topology) {
    router.get('api/topology', async ({ query }) => {
      const group = query.get('group') ?? ''
      return { group, topology: await topology.loadTopology(group) }
    })

    router.post('api/topology/save', async ({ req }) => {
      const body = await readJsonBody(req)
      await topology.saveTopology(body.topology as ProjectTopology)
      return { ok: true }
    })

    router.post('api/topology/create', async ({ req }) => {
      const body = await readJsonBody(req)
      const group = String(body.group ?? '').trim()
      if (!group) throw new Error('group is required')
      return { topology: await topology.createGroup(group, typeof body.name === 'string' ? body.name : undefined) }
    })

    router.post('api/topology/delete', async ({ req }) => {
      const body = await readJsonBody(req)
      const ok = await topology.deleteGroup(String(body.group ?? ''))
      return { ok }
    })

    router.post('api/topology/scan-api', async ({ req }) => {
      const body = await readJsonBody(req)
      const localPath = String(body.localPath ?? '')
      const endpoints = await topology.scanRestApis(localPath)
      return { total: endpoints.length, endpoints }
    })

    router.post('api/topology/import-preview', async ({ req }) => {
      const body = await readJsonBody(req)
      return await topology.importPreview(
        body.source as 'docker-compose' | 'kubernetes' | 'openapi',
        String(body.text ?? ''),
        body.inferDeps !== false,
      )
    })

    router.post('api/topology/import-apply', async ({ req }) => {
      const body = await readJsonBody(req)
      const group = String(body.group ?? '')
      const topologyAfter = await topology.importApply(group, body.preview)
      return { topology: topologyAfter }
    })

    router.get('api/topology/export', async ({ query, res }) => {
      const group = query.get('group') ?? ''
      const yaml = await topology.exportYaml(group)
      res.writeHead(200, {
        'content-type': 'text/yaml; charset=utf-8',
        'content-disposition': `attachment; filename="helmsman-topology.json"`,
      })
      res.end(yaml)
      return undefined
    })
  }

  return router
}

function summarizeTask(task: ReturnType<OrchestratorService['listTasks']>[number]) {
  return {
    id: task.id,
    prompt: task.prompt,
    status: task.status,
    projectGroupId: task.projectGroupId ?? null,
    cascade: task.cascade,
    timeoutSec: task.timeoutSec,
    createdAt: task.createdAt,
    endedAt: task.endedAt ?? null,
    agents: Object.fromEntries(
      Object.entries(task.agents).map(([name, run]) => [
        name,
        {
          state: run.state,
          attempts: run.attempts,
          startedAt: run.startedAt ?? null,
          endedAt: run.endedAt ?? null,
          exitCode: run.exitCode ?? null,
          error: run.error ?? null,
          stats: run.stats ?? null,
          conflictingFiles: run.conflictingFiles ?? [],
          hasDiff: (run.diffs?.length ?? 0) > 0,
        },
      ]),
    ),
  }
}
