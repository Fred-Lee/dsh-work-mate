/**
 * The `dev → done` archival-gate adjudicator (board design D4/D5).
 *
 * The two facts the gate needs live outside `@helmsman/board`: whether a run of
 * this card has been merged (orchestrator's durable timeline) and whether a
 * merge audit record is on file (the JSONL audit journal). Board deliberately
 * stays self-contained, so the host that can reach both wires the probe in.
 *
 * `ui-board` is that host: it holds `helmsman.board` as a required service and
 * resolves `helmsman.orchestrator` lazily, exactly like its run panel does.
 * Without this wiring the gate has no probe and refuses every `dev → done` with
 * "未配置 gate probe" — the standalone degradation, not a pass.
 *
 * Failure semantics follow the board's `probeFlag` contract (service.ts):
 * **throw** for "cannot verify", return `false` for "verified as no". A thrown
 * error surfaces as `合并状态无法验证:<err>` / `合并审计记录无法验证:<err>`,
 * whereas a `false` would be reported as "该卡片还没有任何 run 被合并" — a
 * claim about the card that a broken orchestrator is in no position to make.
 */
import type { GateProbeLike, OrchestratorLike } from './api.ts'

/** The item shape the probe reads: only the run references matter here. */
export interface GateProbeItem {
  runs?: Array<{ taskId?: string }> | undefined
}

/**
 * Builds the probe over a lazily-resolved orchestrator.
 *
 * The getter (not the service) is captured so the probe works no matter when
 * `helmsman.orchestrator` comes up — and so a missing service is reported at
 * gate time rather than at wiring time.
 */
export function createBoardGateProbe(
  orchestrator: () => OrchestratorLike | undefined,
): GateProbeLike {
  const require_ = (what: string): OrchestratorLike => {
    const orch = orchestrator()
    if (!orch) throw new Error(`helmsman.orchestrator 不可用,无法${what}`)
    return orch
  }

  const taskIdsOf = (item: GateProbeItem): string[] =>
    (item.runs ?? [])
      .map((run) => run.taskId)
      .filter((taskId): taskId is string => typeof taskId === 'string' && taskId !== '')

  return {
    /** True when ≥1 of the card's runs carries a `merge-decision{outcome:'merged'}`. */
    async hasMergedRun(item: GateProbeItem): Promise<boolean> {
      const orch = require_('读取合并状态')
      const history = orch.history
      if (!history?.getEvents) throw new Error('orchestrator.history.getEvents 不可用')
      for (const taskId of taskIdsOf(item)) {
        const page = await history.getEvents(taskId, 0)
        for (const event of page?.events ?? []) {
          if (event.kind !== 'merge-decision') continue
          const payload = (event.payload ?? {}) as { outcome?: unknown }
          if (payload.outcome === 'merged') return true
        }
      }
      return false
    },

    /** True when a completed merge audit record is on file for ≥1 of the card's runs. */
    async hasAuditOnRecord(item: GateProbeItem): Promise<boolean> {
      const orch = require_('读取审计记录')
      if (!orch.getAudit) throw new Error('orchestrator.getAudit 不可用')
      for (const taskId of taskIdsOf(item)) {
        const entries = await orch.getAudit({ taskId })
        for (const entry of entries ?? []) {
          if (entry.type !== 'run-completion') continue
          if (entry.operation !== 'merge') continue
          if (entry.outcome === 'completed') return true
        }
      }
      return false
    },
  }
}
