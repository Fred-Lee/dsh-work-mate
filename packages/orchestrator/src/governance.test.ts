/**
 * Engine governance tests — approval gate (6.1) + conflict semantics (7.5) at
 * the OrchestratorCore level, using fake worktrees (deterministic, no git).
 * Real-git semantics are exercised in merge-conflicts.e2e.test.ts.
 *
 * Findings fixed here (lane L-C-fix):
 *  - A: decide-step approve/deny is journaled (stage 'decide'), so an operator
 *    denial — and a grant that is never executed — both leave audit records.
 *  - B: run-completion outcomes derive from the real terminal state
 *    (CANCELLED → 'cancelled', ALL_FAILED/PARTIAL_FAILED → 'failed').
 *  - D: a merge without the mergeDryRun seam fails loudly (no silent partial
 *    applies), and cancel before the task is RUNNING rejects before the gate
 *    is consulted or a confirmation token is consumed (E).
 */
import { describe, expect, it } from 'vitest'
import { OrchestratorCore } from './core.ts'
import type { AgentAdapter, AgentExecuteResult, FileDiffSummary, TaskState, WorktreeLike } from './types.ts'
import { GateDeniedError } from './gate/gate.ts'
import { AuditUnavailableError, MemoryAuditJournal, type AuditCompletionEntry } from './audit/journal.ts'
import { confirmAllPolicy } from './gate/policy.ts'
import type { AuditJournal } from './audit/journal.ts'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function ok(): AgentExecuteResult {
  return { exitCode: 0, stdout: 'done', stderr: '', timedOut: false }
}

function adapter(name: string): AgentAdapter {
  return { name, checkInstalled: async () => ({ installed: true, version: '1.0' }), execute: async () => ok() }
}

/** Adapter whose execute hangs until the abort signal fires (for cancel tests). */
function hangingAdapter(name: string): AgentAdapter {
  return {
    name,
    checkInstalled: async () => ({ installed: true, version: '1.0' }),
    execute: async (req): Promise<AgentExecuteResult> => {
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (req.signal.aborted) {
            clearInterval(timer)
            resolve()
          }
        }, 5)
      })
      return { exitCode: null, stdout: '', stderr: 'SIGTERM', timedOut: false }
    },
  }
}

/** Adapter that always fails (unretryable generic failure → agent state failed). */
function failingAdapter(name: string): AgentAdapter {
  return {
    name,
    checkInstalled: async () => ({ installed: true, version: '1.0' }),
    execute: async (): Promise<AgentExecuteResult> => ({ exitCode: 1, stdout: '', stderr: 'boom: task failed', timedOut: false }),
  }
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

async function waitForTaskState(core: OrchestratorCore, taskId: string, status: TaskState): Promise<void> {
  const deadline = Date.now() + 3_000
  for (;;) {
    const current = core.getTaskStatus(taskId)?.status
    if (current === status) return
    if (Date.now() > deadline) throw new Error(`task ${taskId} did not reach ${status}; last=${current}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** One diff per agent, keyed by agent name. */
function makeFileDiff(path: string, tag: string): FileDiffSummary {
  return { path, status: 'modified', additions: 3, deletions: 0, diff: `diff --git a/${path} b/${path}\n@@ -1,1 +1,3 @@\n+${tag}\n` }
}

interface FakeWorktree {
  worktree: WorktreeLike
  /** MergeWorktree calls in order: [{agent, files}] */
  applied: Array<{ worktreeId: string; files?: string[] }>
  removed: string[]
  /** Files the fake git apply would REJECT (real conflicts). */
  conflictPaths: string[]
  diffs: Record<string, FileDiffSummary[]>
}

function makeFakeWorktree(agentDiffs: Record<string, FileDiffSummary[]>, conflictPaths: string[] = []): FakeWorktree {
  const applied: Array<{ worktreeId: string; files?: string[] }> = []
  const removed: string[] = []
  const diffs = agentDiffs
  const created: Array<{ id: string; agent: string; taskId: string; path: string }> = []
  const wt = {
    createWorktree: async ({ taskId, agent }: { taskId: string; agent: string }) => {
      const id = `wt-${taskId}-${agent}`
      created.push({ id, agent, taskId, path: `/tmp/${id}` })
      return { id, path: `/tmp/${id}`, branch: `helmsman/${id}`, baseSha: 'abc' }
    },
    removeWorktree: async (id: string) => {
      removed.push(id)
    },
    listWorktrees: async () => [...created],
    getDiff: async (id: string) => {
      const agent = created.find((c) => c.id === id)?.agent ?? id
      const files = diffs[agent] ?? []
      return { worktreeId: id, files, additions: 3, deletions: 0 }
    },
    mergeWorktree: async (selection: { worktreeId: string; files?: string[]; commitMessage?: string }) => {
      applied.push({ worktreeId: selection.worktreeId, files: selection.files })
      const agent = created.find((c) => c.id === selection.worktreeId)?.agent ?? selection.worktreeId
      const requested = selection.files ?? diffs[agent]?.map((d) => d.path) ?? []
      return { ok: true, committed: true, message: `merged ${agent}`, conflictFiles: [] }
    },
    mergeDryRun: async (selection: { worktrees: Array<{ worktreeId: string; files?: string[] }> }) => {
      // Real conflicts = the same file patched by TWO agents (their hunks would
      // overlap in a combined patch and fail `git apply --check`). A file
      // patched by a single agent applies cleanly against an unchanged base.
      const touched = new Map<string, number>()
      for (const s of selection.worktrees) {
        const agent = created.find((c) => c.id === s.worktreeId)?.agent ?? s.worktreeId
        for (const f of diffs[agent] ?? []) {
          if (!s.files || s.files.includes(f.path)) touched.set(f.path, (touched.get(f.path) ?? 0) + 1)
        }
      }
      const real = [...touched.entries()].filter(([path, n]) => n > 1 && conflictPaths.includes(path)).map(([path]) => path)
      return { ok: real.length === 0, conflictFiles: real }
    },
    removeTaskWorktrees: async (taskId: string) => {
      for (const rec of created.filter((r) => r.taskId === taskId)) removed.push(rec.id)
    },
  }
  return { worktree: wt as unknown as WorktreeLike, applied, removed, conflictPaths, diffs }
}

/** Runs one parallel task to a terminal state (COMPLETED) and returns its id. */
async function runCompletedTask(core: OrchestratorCore, agents: string[]): Promise<string> {
  const { taskId } = await core.runParallelTask({ prompt: 'do it', agents, repoPath: '/repo' })
  await core.waitForTask(taskId)
  return taskId
}

function buildCore(fake: FakeWorktree, opts: { policy?: typeof confirmAllPolicy; journal?: AuditJournal } = {}) {
  const core = new OrchestratorCore({
    worktree: fake.worktree,
    delay: async () => undefined,
    policy: opts.policy,
    journal: opts.journal,
  })
  return core
}

describe('approval gate — merge/discard/cancel (tasks 6.1)', () => {
  it('default allow-all policy: cancelling a RUNNING task journals an auto-grant decision', async () => {
    const journal = new MemoryAuditJournal()
    const fake = makeFakeWorktree({ claude: [makeFileDiff('a.ts', 'A')] })
    const core = buildCore(fake, { journal })
    core.registerAdapter(hangingAdapter('claude'))
    const { taskId } = await core.runParallelTask({ prompt: 'do it', agents: ['claude'], repoPath: '/repo' })
    await waitForTaskState(core, taskId, 'RUNNING')

    await core.cancelTask(taskId)

    const entries = await journal.query({ taskId })
    const cancel = entries.find((e) => e.type === 'decision' && e.operation === 'cancel')
    expect(cancel?.type).toBe('decision')
    expect(cancel).toMatchObject({ decision: 'auto-grant', stage: 'enforce', source: 'ui' })
  })

  it('confirm-required merge without a token is denied and nothing is merged', async () => {
    const journal = new MemoryAuditJournal()
    const fake = makeFakeWorktree({ claude: [makeFileDiff('a.ts', 'A')] })
    const core = buildCore(fake, { policy: confirmAllPolicy, journal })
    core.registerAdapter(adapter('claude'))
    const taskId = await runCompletedTask(core, ['claude'])

    await expect(core.mergeTask({ taskId, source: 'tool' })).rejects.toThrow(GateDeniedError)
    expect(fake.applied).toHaveLength(0)
    const denials = await journal.query({ op: 'merge' })
    expect(denials.filter((e) => e.type === 'decision')).toHaveLength(1)
    expect(denials[0]).toMatchObject({ decision: 'denied', reason: 'missing-token', source: 'tool', stage: 'enforce' })
  })

  it('a granted merge token authorizes execution; audit records decide → enforce → completion', async () => {
    const journal = new MemoryAuditJournal()
    const fake = makeFakeWorktree({ claude: [makeFileDiff('a.ts', 'A')] })
    const core = buildCore(fake, { policy: confirmAllPolicy, journal })
    core.registerAdapter(adapter('claude'))
    const taskId = await runCompletedTask(core, ['claude'])

    const { approvalId } = core.requestConfirmation({ op: 'merge', taskId }, 'ui')
    const decision = await core.decideConfirmation(approvalId, true)
    expect(decision.granted).toBe(true)
    if (!decision.granted) throw new Error('unreachable')

    const result = await core.mergeTask({ taskId, confirmationToken: decision.token, source: 'ui' })
    expect(result.results[0]).toMatchObject({ ok: true, committed: true })
    expect(fake.applied).toHaveLength(1)

    const audit = await journal.query({ op: 'merge' })
    const decisions = audit.filter((e) => e.type === 'decision')
    const completions = audit.filter((e) => e.type === 'run-completion')
    // one human decide-stage grant + one enforce-stage grant, then the completion
    expect(decisions).toHaveLength(2)
    expect(completions).toHaveLength(1)
    expect(decisions[0]).toMatchObject({ decision: 'granted', source: 'ui', stage: 'decide', approvalId })
    expect(decisions[1]).toMatchObject({ decision: 'granted', source: 'ui', stage: 'enforce' })
    // decision records precede the completion entry (journal before effect)
    expect(audit.map((e) => e.type)).toEqual(['decision', 'decision', 'run-completion'])

    // resolution payload + merge-decision event live in the run timeline
    await core.history.flush()
    const events = await core.history.eventsAfter(taskId, 0)
    const mergeDecision = events.events.find((e) => e.kind === 'merge-decision')
    expect(mergeDecision).toBeDefined()
  })

  it('a decide-step denial is journaled (operator denial leaves an audit record, A)', async () => {
    const journal = new MemoryAuditJournal()
    const fake = makeFakeWorktree({ claude: [makeFileDiff('a.ts', 'A')] })
    const core = buildCore(fake, { policy: confirmAllPolicy, journal })
    core.registerAdapter(adapter('claude'))
    const taskId = await runCompletedTask(core, ['claude'])

    const { approvalId } = core.requestConfirmation({ op: 'merge', taskId }, 'ui')
    const result = await core.decideConfirmation(approvalId, false)
    expect(result).toMatchObject({ granted: false, reason: 'denied', op: 'merge', taskId, approvalId })

    const audit = await journal.query({ op: 'merge' })
    const decisions = audit.filter((e) => e.type === 'decision')
    expect(decisions).toHaveLength(1)
    expect(decisions[0]).toMatchObject({
      decision: 'denied',
      reason: 'operator-denied',
      stage: 'decide',
      operation: 'merge',
      approvalId,
      source: 'ui',
      taskId,
    })
    // the denied merge never executed → no merge completion record
    expect(audit.some((e) => e.type === 'run-completion' && e.operation === 'merge')).toBe(false)
    expect(fake.applied).toHaveLength(0)
  })

  it('an approved-but-never-executed grant is journaled at the decide step (A)', async () => {
    const journal = new MemoryAuditJournal()
    const fake = makeFakeWorktree({ claude: [makeFileDiff('a.ts', 'A')] })
    const core = buildCore(fake, { policy: confirmAllPolicy, journal })
    core.registerAdapter(adapter('claude'))
    const taskId = await runCompletedTask(core, ['claude'])

    const { approvalId } = core.requestConfirmation({ op: 'discard', taskId }, 'tool')
    const decision = await core.decideConfirmation(approvalId, true)
    expect(decision.granted).toBe(true)
    // …and nothing is executed: the discard never happens, yet the grant is on record
    expect(fake.removed).toHaveLength(0)

    const audit = await journal.query({ op: 'discard' })
    const decisions = audit.filter((e) => e.type === 'decision')
    expect(decisions).toHaveLength(1)
    expect(decisions[0]).toMatchObject({ decision: 'granted', stage: 'decide', operation: 'discard', approvalId, source: 'tool', taskId })
    expect(audit.some((e) => e.type === 'run-completion')).toBe(false)
  })

  it('journal-write failure at the decide step surfaces (fail-closed, A)', async () => {
    const journal = new MemoryAuditJournal()
    const fake = makeFakeWorktree({ claude: [makeFileDiff('a.ts', 'A')] })
    const core = buildCore(fake, { policy: confirmAllPolicy, journal })
    core.registerAdapter(adapter('claude'))
    const taskId = await runCompletedTask(core, ['claude'])
    const { approvalId } = core.requestConfirmation({ op: 'merge', taskId })

    journal.failWrites = true
    await expect(core.decideConfirmation(approvalId, true)).rejects.toThrow(AuditUnavailableError)
  })

  it('token reuse is refused (single-use)', async () => {
    const fake = makeFakeWorktree({ claude: [makeFileDiff('a.ts', 'A')] })
    const core = buildCore(fake, { policy: confirmAllPolicy })
    core.registerAdapter(adapter('claude'))
    const taskId = await runCompletedTask(core, ['claude'])
    const { approvalId } = core.requestConfirmation({ op: 'merge', taskId }, 'tool')
    const decision = await core.decideConfirmation(approvalId, true)
    if (!decision.granted) throw new Error('unreachable')
    await core.mergeTask({ taskId, confirmationToken: decision.token, source: 'tool' })
    await expect(core.mergeTask({ taskId, confirmationToken: decision.token, source: 'tool' })).rejects.toThrow(GateDeniedError)
  })

  it('journal-write failure aborts the gated operation (fail-closed, 6.1)', async () => {
    const journal = new MemoryAuditJournal()
    const fake = makeFakeWorktree({ claude: [makeFileDiff('a.ts', 'A')] })
    const core = buildCore(fake, { policy: confirmAllPolicy, journal })
    core.registerAdapter(adapter('claude'))
    const taskId = await runCompletedTask(core, ['claude'])
    const { approvalId } = core.requestConfirmation({ op: 'merge', taskId })
    const decision = await core.decideConfirmation(approvalId, true)
    if (!decision.granted) throw new Error('unreachable')

    journal.failWrites = true
    await expect(core.mergeTask({ taskId, confirmationToken: decision.token })).rejects.toThrow(AuditUnavailableError)
    expect(fake.applied).toHaveLength(0) // base repo untouched
  })

  it('discard is gated too: confirm-required discard without a token removes nothing', async () => {
    const fake = makeFakeWorktree({ claude: [makeFileDiff('a.ts', 'A')] })
    const core = buildCore(fake, { policy: confirmAllPolicy })
    core.registerAdapter(adapter('claude'))
    const taskId = await runCompletedTask(core, ['claude'])
    await expect(core.discardTask(taskId, undefined, 'tool')).rejects.toThrow(GateDeniedError)
    expect(fake.removed).toHaveLength(0)

    const { approvalId } = core.requestConfirmation({ op: 'discard', taskId }, 'tool')
    const d = await core.decideConfirmation(approvalId, true)
    if (!d.granted) throw new Error('unreachable')
    await core.discardTask(taskId, d.token, 'tool')
    expect(fake.removed.length).toBeGreaterThan(0)
  })
})

describe('run-completion outcomes derive from the real terminal state (finding B)', () => {
  it('a CANCELLED run journals outcome "cancelled", not "completed"', async () => {
    const journal = new MemoryAuditJournal()
    const fake = makeFakeWorktree({ claude: [makeFileDiff('a.ts', 'A')] })
    const core = buildCore(fake, { journal })
    core.registerAdapter(hangingAdapter('claude'))
    const { taskId } = await core.runParallelTask({ prompt: 'do it', agents: ['claude'], repoPath: '/repo' })
    await waitForTaskState(core, taskId, 'RUNNING')

    await core.cancelTask(taskId)
    await core.waitForTask(taskId)
    expect(core.getTaskStatus(taskId)?.status).toBe('CANCELLED')

    const entries = await journal.query({ taskId })
    const completion = entries.find((e) => e.type === 'run-completion' && e.operation === 'run')
    expect(completion).toBeDefined()
    expect((completion as AuditCompletionEntry).outcome).toBe('cancelled')
    // precise terminal state is preserved for downstream readers
    expect((completion as AuditCompletionEntry).detail?.status).toBe('CANCELLED')
  })

  it('an ALL_FAILED run journals outcome "failed", not "completed"', async () => {
    const journal = new MemoryAuditJournal()
    const fake = makeFakeWorktree({ claude: [makeFileDiff('a.ts', 'A')], codex: [makeFileDiff('b.ts', 'B')] })
    const core = buildCore(fake, { journal })
    core.registerAdapter(failingAdapter('claude'))
    core.registerAdapter(failingAdapter('codex'))
    const { taskId } = await core.runParallelTask({ prompt: 'do it', agents: ['claude', 'codex'], repoPath: '/repo' })
    await core.waitForTask(taskId)
    expect(core.getTaskStatus(taskId)?.status).toBe('ALL_FAILED')

    const entries = await journal.query({ taskId })
    const completion = entries.find((e) => e.type === 'run-completion' && e.operation === 'run')
    expect(completion).toBeDefined()
    expect((completion as AuditCompletionEntry).outcome).toBe('failed')
    expect((completion as AuditCompletionEntry).detail?.status).toBe('ALL_FAILED')
  })
})

describe('cancel reject-early semantics (finding E)', () => {
  it('cancel of an unknown or finished task rejects BEFORE the gate (nothing journaled)', async () => {
    const journal = new MemoryAuditJournal()
    const fake = makeFakeWorktree({ claude: [makeFileDiff('a.ts', 'A')] })
    const core = buildCore(fake, { journal })
    core.registerAdapter(adapter('claude'))
    const taskId = await runCompletedTask(core, ['claude']) // COMPLETED → not cancellable

    await expect(core.cancelTask('t-missing')).rejects.toThrow(/unknown task/)
    await expect(core.cancelTask(taskId)).rejects.toThrow(/not cancellable/)

    const cancels = (await journal.query({ op: 'cancel' })).filter((e) => e.type === 'decision')
    expect(cancels).toHaveLength(0) // rejected cancels are neither gated nor journaled
  })

  it('cancel during the worktree-creation window is rejected, token not consumed, no misleading audit entry', async () => {
    const journal = new MemoryAuditJournal()
    const fake = makeFakeWorktree({ claude: [makeFileDiff('a.ts', 'A')] })
    const holdCreate = deferred()
    const baseCreate = fake.worktree.createWorktree
    const worktree: WorktreeLike = {
      ...fake.worktree,
      createWorktree: async (p) => {
        await holdCreate.promise
        return baseCreate(p)
      },
    }
    const core = new OrchestratorCore({ worktree, delay: async () => undefined, policy: confirmAllPolicy, journal })
    core.registerAdapter(hangingAdapter('claude'))

    const { taskId } = await core.runParallelTask({ prompt: 'do it', agents: ['claude'], repoPath: '/repo' })
    await waitForTaskState(core, taskId, 'CREATING_WORKTREES')

    // A human approves the cancel — the grant itself is journaled at decide time.
    const { approvalId } = core.requestConfirmation({ op: 'cancel', taskId })
    const decision = await core.decideConfirmation(approvalId, true)
    if (!decision.granted) throw new Error('unreachable')
    const token = decision.token

    // Cancel arrives while the task is NOT cancellable → rejected before the
    // gate consumes anything.
    await expect(core.cancelTask(taskId, token, 'ui')).rejects.toThrow(/not cancellable/)

    const duringWindow = await journal.query({ taskId })
    const cancelDecisions = duringWindow.filter((e) => e.type === 'decision' && e.operation === 'cancel')
    expect(cancelDecisions).toHaveLength(1) // ONLY the decide-stage grant
    expect(cancelDecisions[0]).toMatchObject({ decision: 'granted', stage: 'decide', approvalId })
    expect(duringWindow.some((e) => e.type === 'run-completion')).toBe(false) // no misleading completion yet

    // Release the worktree-creation gate; the task reaches RUNNING. The SAME
    // token still spends → the rejected cancel never consumed it.
    holdCreate.resolve()
    await waitForTaskState(core, taskId, 'RUNNING')
    await expect(core.cancelTask(taskId, token, 'ui')).resolves.toBeUndefined()
    await core.waitForTask(taskId)
    expect(core.getTaskStatus(taskId)?.status).toBe('CANCELLED')

    const final = await journal.query({ taskId })
    const completion = final.find((e) => e.type === 'run-completion' && e.operation === 'run')
    expect((completion as AuditCompletionEntry).outcome).toBe('cancelled')
  })
})

describe('conflict semantics by real apply failure (design D5, tasks 7.x)', () => {
  it('disjoint multi-agent edits to the SAME file default-merge without a conflict prompt', async () => {
    const fake = makeFakeWorktree(
      { claude: [makeFileDiff('shared.txt', 'A')], codex: [makeFileDiff('shared.txt', 'B')] },
      [], // no apply failures → clean
    )
    const core = buildCore(fake)
    core.registerAdapter(adapter('claude'))
    core.registerAdapter(adapter('codex'))
    const taskId = await runCompletedTask(core, ['claude', 'codex'])

    const result = await core.mergeTask({ taskId })
    expect(result.results.map((r) => r.ok)).toEqual([true, true])
    // both agents merged the same file → applied twice (disjoint patches)
    expect(fake.applied).toHaveLength(2)
    expect(fake.applied.every((a) => a.files?.includes('shared.txt'))).toBe(true)
  })

  it('an overlapping edit is flagged only on apply failure and aborts the whole merge (base untouched)', async () => {
    const fake = makeFakeWorktree(
      { claude: [makeFileDiff('shared.txt', 'A')], codex: [makeFileDiff('shared.txt', 'B')] },
      ['shared.txt'], // real conflict
    )
    const core = buildCore(fake)
    core.registerAdapter(adapter('claude'))
    core.registerAdapter(adapter('codex'))
    const taskId = await runCompletedTask(core, ['claude', 'codex'])

    // headless merge (no resolutions): aborts wholesale, returns conflict list
    const result = await core.mergeTask({ taskId, source: 'tool' })
    expect(result.results.every((r) => r.ok === false)).toBe(true)
    expect(result.results[0]!.conflictFiles).toEqual(['shared.txt'])
    expect(fake.applied).toHaveLength(0) // nothing written to the base repo
  })

  it('adjudication resolutions drive the merge: adopt agent plan / manual-keep / skip', async () => {
    const fake = makeFakeWorktree(
      {
        claude: [makeFileDiff('f1.ts', 'A'), makeFileDiff('f2.ts', 'A'), makeFileDiff('f3.ts', 'A')],
        codex: [makeFileDiff('f1.ts', 'B'), makeFileDiff('f2.ts', 'B'), makeFileDiff('f3.ts', 'B')],
      },
      ['f1.ts', 'f2.ts', 'f3.ts'], // every file overlaps between the two agents
    )
    const core = buildCore(fake)
    core.registerAdapter(adapter('claude'))
    core.registerAdapter(adapter('codex'))
    const taskId = await runCompletedTask(core, ['claude', 'codex'])

    const result = await core.mergeTask({
      taskId,
      resolutions: {
        'f1.ts': { kind: 'agent', agent: 'claude' }, // adopt claude's plan
        'f2.ts': { kind: 'manual' }, // manual-edit keep → write nothing
        'f3.ts': { kind: 'skip' }, // skip → write nothing
      },
    })
    expect(result.results.map((r) => r.ok)).toEqual([true, true])
    // claude applies f1 only; every conflicted file dropped from codex's patch,
    // and manual/skip files never reach git apply for either agent.
    const claudeApplied = fake.applied.find((a) => a.worktreeId.includes('claude'))
    expect(claudeApplied?.files).toEqual(['f1.ts'])
    const codexApplied = fake.applied.find((a) => a.worktreeId.includes('codex'))
    expect(codexApplied).toBeUndefined() // codex has nothing left to merge
    expect(result.results.find((r) => r.agent === 'codex')).toMatchObject({ ok: true, committed: false })
    expect(fake.applied.some((a) => a.files?.includes('f2.ts') || a.files?.includes('f3.ts'))).toBe(false)

    // adjudication payload persisted to audit + timeline
    await core.history.flush()
    const audit = await core.getAudit({ taskId })
    const completion = audit?.find((e) => e.type === 'run-completion' && e.operation === 'merge')
    expect((completion as { detail?: { resolutions?: unknown } } | undefined)?.detail?.resolutions).toMatchObject({
      'f1.ts': { kind: 'agent', agent: 'claude' },
      'f2.ts': { kind: 'manual' },
      'f3.ts': { kind: 'skip' },
    })
    const page = await core.history.eventsAfter(taskId, 0)
    const mergeEvent = page.events.find((e) => e.kind === 'merge-decision')
    const payload = mergeEvent?.payload as { resolutions: unknown }
    expect(payload.resolutions).toMatchObject({ 'f3.ts': { kind: 'skip' } })
  })

  it('a conflict file lacking adjudication blocks the merge with guidance', async () => {
    const fake = makeFakeWorktree(
      { claude: [makeFileDiff('f1.ts', 'A')], codex: [makeFileDiff('f1.ts', 'B'), makeFileDiff('f2.ts', 'B')] },
      ['f1.ts'],
    )
    const core = buildCore(fake)
    core.registerAdapter(adapter('claude'))
    core.registerAdapter(adapter('codex'))
    const taskId = await runCompletedTask(core, ['claude', 'codex'])
    const result = await core.mergeTask({ taskId, resolutions: {} }) // empty adjudication
    expect(result.results.every((r) => r.ok === false)).toBe(true)
    expect(fake.applied).toHaveLength(0)
  })

  it('merge without the mergeDryRun seam fails loudly — no silent per-agent applies (D)', async () => {
    const journal = new MemoryAuditJournal()
    const fake = makeFakeWorktree({ claude: [makeFileDiff('a.ts', 'A')] })
    // Simulate a legacy fake / custom host that never gained the dry-run seam.
    const bare = fake.worktree as unknown as Record<string, unknown>
    delete bare.mergeDryRun
    const core = new OrchestratorCore({ worktree: fake.worktree, delay: async () => undefined, journal })
    core.registerAdapter(adapter('claude'))
    const taskId = await runCompletedTask(core, ['claude'])

    await expect(core.mergeTask({ taskId })).rejects.toThrow(/mergeDryRun/)
    expect(fake.applied).toHaveLength(0) // nothing reached the apply phase

    // the conflict-preview query is equally loud about the missing seam
    await expect(core.getRealConflicts(taskId)).rejects.toThrow(/mergeDryRun/)
  })
})
