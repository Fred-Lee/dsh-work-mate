/**
 * Diff view REST API — exposes per-agent diffs, merge and discard operations
 * from the orchestrator. Pure factory for unit testing.
 */
import type { OrchestratorService } from '@helmsman/orchestrator'
import { readJsonBody, Router } from './http.ts'

export function createDiffApiRouter(orchestrator: OrchestratorService): Router {
  const router = new Router()

  router.get('api/tasks', async () => {
    return {
      tasks: orchestrator.listTasks().map((t) => ({
        id: t.id,
        prompt: t.prompt,
        status: t.status,
        createdAt: t.createdAt,
        agents: Object.fromEntries(
          Object.entries(t.agents).map(([name, run]) => [
            name,
            { state: run.state, stats: run.stats ?? null, conflictingFiles: run.conflictingFiles ?? [] },
          ]),
        ),
      })),
    }
  })

  router.get('api/task/:id', async ({ params }) => {
    const task = orchestrator.getTaskStatus(params.id!)
    if (!task) return { found: false }
    return {
      found: true,
      task: {
        id: task.id,
        prompt: task.prompt,
        status: task.status,
        createdAt: task.createdAt,
        agents: Object.fromEntries(
          Object.entries(task.agents).map(([name, run]) => [
            name,
            {
              state: run.state,
              error: run.error ?? null,
              stats: run.stats ?? null,
              conflictingFiles: run.conflictingFiles ?? [],
              diffs: run.diffs ?? [],
            },
          ]),
        ),
      },
    }
  })

  router.post('api/task/:id/merge', async ({ req, params }) => {
    const body = await readJsonBody(req)
    return await orchestrator.mergeTask({
      taskId: params.id!,
      ...(Array.isArray(body.agents) && body.agents.length > 0 ? { agents: body.agents.map(String) } : {}),
      ...(Array.isArray(body.files) && body.files.length > 0 ? { files: body.files.map(String) } : {}),
      ...(body.discardAfterMerge === true ? { discardAfterMerge: true } : {}),
    })
  })

  router.post('api/task/:id/discard', async ({ params }) => {
    await orchestrator.discardTask(params.id!)
    return { ok: true }
  })

  return router
}
