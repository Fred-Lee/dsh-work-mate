/**
 * Diff view REST API — exposes per-agent diffs, real conflict detection, merge
 * and discard operations from the orchestrator. Pure factory for unit testing.
 *
 * Merge/discard are gated in the service core: the caller passes a
 * confirmation token minted through the approval endpoints below, and merges
 * may carry a per-file `resolutions` adjudication payload for real conflict
 * files (spec merge-conflict-resolution).
 */
import type { GateOp, MergeResolution, OrchestratorService } from '@helmsman/orchestrator'
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

  // Real conflicts for the current task: files whose combined agent patches
  // fail a dry-run `git apply --check` (read-only; base repo untouched).
  router.get('api/task/:id/conflicts', async ({ params }) => {
    const conflictFiles = await orchestrator.getRealConflicts(params.id!)
    return { taskId: params.id, conflictFiles }
  })

  router.post('api/task/:id/merge', async ({ req, params }) => {
    const body = await readJsonBody(req)
    return await orchestrator.mergeTask({
      taskId: params.id!,
      ...(Array.isArray(body.agents) && body.agents.length > 0 ? { agents: body.agents.map(String) } : {}),
      ...(Array.isArray(body.files) && body.files.length > 0 ? { files: body.files.map(String) } : {}),
      ...(body.discardAfterMerge === true ? { discardAfterMerge: true } : {}),
      ...(typeof body.confirmationToken === 'string' ? { confirmationToken: body.confirmationToken } : {}),
      ...(body.resolutions != null && typeof body.resolutions === 'object'
        ? { resolutions: body.resolutions as Record<string, MergeResolution> }
        : {}),
      source: 'ui',
    })
  })

  router.post('api/task/:id/discard', async ({ req, params }) => {
    const body = await readJsonBody(req)
    // UI-originated discard → attribute the audit decision to 'ui' (not 'tool').
    await orchestrator.discardTask(params.id!, typeof body.confirmationToken === 'string' ? body.confirmationToken : undefined, 'ui')
    return { ok: true }
  })

  // ---- approval gate endpoints (mirror of the dashboard's) ----------------
  router.get('api/approvals/policy', async ({ query }) => {
    const op = String(query.get('op') ?? '')
    return { op, mode: orchestrator.policyMode(op as GateOp), confirmRequired: orchestrator.isConfirmRequired(op as GateOp) }
  })

  router.post('api/approvals', async ({ req }) => {
    const body = await readJsonBody(req)
    const op = String(body.op ?? '')
    if (!op) throw new Error('op is required (merge | discard | cancel | worktree-cleanup | topology-delete)')
    const approval = orchestrator.requestConfirmation(
      {
        op: op as GateOp,
        ...(typeof body.taskId === 'string' && body.taskId ? { taskId: body.taskId } : {}),
        ...(typeof body.group === 'string' && body.group ? { group: body.group } : {}),
      },
      'ui',
    )
    return {
      approvalId: approval.approvalId,
      op: approval.op,
      scope: approval.scope,
      source: approval.source,
      requestedAt: approval.requestedAt,
      expiresAt: approval.expiresAt,
    }
  })

  router.post('api/approvals/:id/decision', async ({ req, params }) => {
    const body = await readJsonBody(req)
    return orchestrator.decideConfirmation(params.id!, body.approve !== false)
  })

  return router
}
