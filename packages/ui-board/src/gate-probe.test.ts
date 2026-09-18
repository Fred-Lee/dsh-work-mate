import { describe, expect, it, vi } from 'vitest'
import { createBoardGateProbe } from './gate-probe.ts'
import type { AuditEntryLike, ExecutionEventLike, OrchestratorLike } from './api.ts'

// ---------------------------------------------------------------------------
// Orchestrator doubles — only the two reads the gate performs
// ---------------------------------------------------------------------------

function event(kind: string, payload?: Record<string, unknown>): ExecutionEventLike {
  return { seq: 1, ts: 1_700_000_000_000, taskId: 't1', kind, ...(payload ? { payload } : {}) }
}

function fakeOrchestrator(over: {
  events?: Record<string, ExecutionEventLike[]>
  audit?: Record<string, AuditEntryLike[]>
  throwOnEvents?: boolean
  throwOnAudit?: boolean
  noAudit?: boolean
} = {}): OrchestratorLike {
  const history = {
    getEvents: vi.fn(async (taskId: string) => {
      if (over.throwOnEvents) throw new Error('history offline')
      return { events: over.events?.[taskId] ?? [], pruned: false }
    }),
    subscribe: vi.fn(() => () => {}),
  }
  const orch: OrchestratorLike = {
    getTaskStatus: () => undefined,
    listTasks: () => [],
    history,
  }
  if (!over.noAudit) {
    ;(orch as { getAudit?: unknown }).getAudit = vi.fn(async (query?: { taskId?: string }) => {
      if (over.throwOnAudit) throw new Error('audit offline')
      return over.audit?.[query?.taskId ?? ''] ?? []
    })
  }
  return orch
}

const card = (taskIds: string[]) => ({ runs: taskIds.map((taskId) => ({ taskId })) })

// ---------------------------------------------------------------------------

describe('gate probe: hasMergedRun', () => {
  it('is true when a run carries merge-decision{outcome:merged}', async () => {
    const probe = createBoardGateProbe(() =>
      fakeOrchestrator({ events: { t1: [event('merge-decision', { outcome: 'merged' })] } }),
    )
    await expect(probe.hasMergedRun!(card(['t1']))).resolves.toBe(true)
  })

  it('is false when the merge decision is anything but merged', async () => {
    const probe = createBoardGateProbe(() =>
      fakeOrchestrator({ events: { t1: [event('merge-decision', { outcome: 'aborted' })] } }),
    )
    await expect(probe.hasMergedRun!(card(['t1']))).resolves.toBe(false)
  })

  it('is false when the timeline has no merge decision at all', async () => {
    const probe = createBoardGateProbe(() =>
      fakeOrchestrator({ events: { t1: [event('agent-log'), event('task-state')] } }),
    )
    await expect(probe.hasMergedRun!(card(['t1']))).resolves.toBe(false)
  })

  it('is false when the card has no runs — no orchestrator read is attempted', async () => {
    const orch = fakeOrchestrator()
    const probe = createBoardGateProbe(() => orch)
    await expect(probe.hasMergedRun!({ runs: [] })).resolves.toBe(false)
    await expect(probe.hasMergedRun!({})).resolves.toBe(false)
    expect(orch.history.getEvents).not.toHaveBeenCalled()
  })

  it('checks every run, not just the first', async () => {
    const probe = createBoardGateProbe(() =>
      fakeOrchestrator({
        events: {
          t1: [event('task-state')],
          t2: [event('merge-decision', { outcome: 'merged' })],
        },
      }),
    )
    await expect(probe.hasMergedRun!(card(['t1', 't2']))).resolves.toBe(true)
  })

  it('ignores run references without a usable taskId', async () => {
    const orch = fakeOrchestrator()
    const probe = createBoardGateProbe(() => orch)
    await expect(probe.hasMergedRun!({ runs: [{}, { taskId: '' }] })).resolves.toBe(false)
    expect(orch.history.getEvents).not.toHaveBeenCalled()
  })

  // The gate's probeFlag turns a throw into "合并状态无法验证:<err>" and a
  // false into "该卡片还没有任何 run 被合并". Infrastructure trouble must
  // therefore throw — claiming "not merged" about a card we could not read is
  // exactly the silent misreport the gate contract forbids.
  it('throws rather than reporting "not merged" when orchestrator is absent', async () => {
    const probe = createBoardGateProbe(() => undefined)
    await expect(probe.hasMergedRun!(card(['t1']))).rejects.toThrow(/orchestrator 不可用/)
  })

  it('propagates a history read failure', async () => {
    const probe = createBoardGateProbe(() => fakeOrchestrator({ throwOnEvents: true }))
    await expect(probe.hasMergedRun!(card(['t1']))).rejects.toThrow('history offline')
  })
})

describe('gate probe: hasAuditOnRecord', () => {
  const merge = (outcome: string): AuditEntryLike => ({
    type: 'run-completion',
    operation: 'merge',
    outcome,
    taskId: 't1',
  })

  it('is true for a completed merge audit record', async () => {
    const probe = createBoardGateProbe(() => fakeOrchestrator({ audit: { t1: [merge('completed')] } }))
    await expect(probe.hasAuditOnRecord!(card(['t1']))).resolves.toBe(true)
  })

  it('is false when the merge was aborted', async () => {
    const probe = createBoardGateProbe(() => fakeOrchestrator({ audit: { t1: [merge('aborted')] } }))
    await expect(probe.hasAuditOnRecord!(card(['t1']))).resolves.toBe(false)
  })

  it('is false for non-merge completions', async () => {
    const probe = createBoardGateProbe(() =>
      fakeOrchestrator({
        audit: { t1: [{ type: 'run-completion', operation: 'run', outcome: 'completed', taskId: 't1' }] },
      }),
    )
    await expect(probe.hasAuditOnRecord!(card(['t1']))).resolves.toBe(false)
  })

  it('is false when the journal has no record for the run', async () => {
    const probe = createBoardGateProbe(() => fakeOrchestrator({ audit: {} }))
    await expect(probe.hasAuditOnRecord!(card(['t1']))).resolves.toBe(false)
  })

  it('queries the journal per run', async () => {
    const orch = fakeOrchestrator({ audit: { t2: [merge('completed')] } })
    const probe = createBoardGateProbe(() => orch)
    await expect(probe.hasAuditOnRecord!(card(['t1', 't2']))).resolves.toBe(true)
    expect(orch.getAudit).toHaveBeenCalledWith({ taskId: 't1' })
    expect(orch.getAudit).toHaveBeenCalledWith({ taskId: 't2' })
  })

  it('throws when the audit read is not offered', async () => {
    const probe = createBoardGateProbe(() => fakeOrchestrator({ noAudit: true }))
    await expect(probe.hasAuditOnRecord!(card(['t1']))).rejects.toThrow(/getAudit 不可用/)
  })

  it('propagates an audit read failure', async () => {
    const probe = createBoardGateProbe(() => fakeOrchestrator({ throwOnAudit: true }))
    await expect(probe.hasAuditOnRecord!(card(['t1']))).rejects.toThrow('audit offline')
  })
})

describe('gate probe wiring', () => {
  it('resolves the orchestrator on every call, never at build time', async () => {
    let current: OrchestratorLike | undefined
    const probe = createBoardGateProbe(() => current)

    await expect(probe.hasMergedRun!(card(['t1']))).rejects.toThrow(/不可用/)

    // The service appears later — the same probe must pick it up.
    current = fakeOrchestrator({ events: { t1: [event('merge-decision', { outcome: 'merged' })] } })
    await expect(probe.hasMergedRun!(card(['t1']))).resolves.toBe(true)
  })
})
