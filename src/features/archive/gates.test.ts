import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProposalStore } from '../proposal/store.ts'
import { ProposalServiceImpl } from '../proposal/service.ts'
import { EventLog } from '../proposal/events.ts'
import { WorktreeManager } from '../worktree/manager.ts'
import { InvalidTransitionError, LifecycleServiceImpl } from './service.ts'

let home: string
let store: ProposalStore
let events: EventLog
let proposals: ProposalServiceImpl

const worktree = (): WorktreeManager =>
  new WorktreeManager({ subdir: 'workmate', basePort: 3000, portStep: 10,  })

/** A dependency set that archives successfully and reports what the orchestration was asked to do. */
const lifecycleFor = (
  deps: Partial<ConstructorParameters<typeof LifecycleServiceImpl>[0]> = {},
): LifecycleServiceImpl =>
  new LifecycleServiceImpl({
    proposals,
    worktree: worktree(),
    approvalsRequired: [],
    resolveProjectRoots: async () => [],
    orchestrate: async () => ({
      ok: true,
      steps: [{ step: 'status' as const, status: 'ok' as const, summary: 'archived' }],
    }),
    ...deps,
  })

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wm-gates-'))
  store = new ProposalStore({ homeRoot: home, subdir: 'workmate' })
  events = new EventLog({ homeRoot: home, subdir: 'workmate' })
  proposals = new ProposalServiceImpl(store, undefined, events)
  await proposals.upsert({ id: 'p1', title: '归档门禁加固的测试提案' })
  await proposals.setStatus('p1', 'archiving', { actor: 'human' })
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('force is a human decision (harden-archive-gates)', () => {
  it('refuses an agent that tries to force the archive gates', async () => {
    const lifecycle = lifecycleFor()
    await expect(lifecycle.runArchive('p1', { force: true, actor: 'agent' })).rejects.toBeInstanceOf(
      InvalidTransitionError,
    )
    const proposal = await proposals.get('p1')
    expect(proposal?.status).toBe('archiving')
    expect(proposal?.approvals ?? []).toHaveLength(0)
  })

  it('records the refusal as a gate failure so the trail is not silent', async () => {
    const lifecycle = lifecycleFor()
    await expect(lifecycle.runArchive('p1', { force: true, actor: 'agent' })).rejects.toThrow(/allowAgentForceArchive/)
    const gateEvents = (await events.listFor('p1')).filter((event) => event.kind === 'gate-failed')
    expect(gateEvents).toHaveLength(1)
    expect(gateEvents[0]?.gate).toBe('force-archive')
  })

  it('points the agent at the human path and the exemption knob', async () => {
    const lifecycle = lifecycleFor()
    await expect(lifecycle.runArchive('p1', { force: true, actor: 'agent' })).rejects.toThrow(/面板/)
    await expect(lifecycle.runArchive('p1', { force: true, actor: 'agent' })).rejects.toThrow(/allowAgentForceArchive/)
  })

  it('lets an explicit exemption through but still leaves an approval record', async () => {
    const lifecycle = lifecycleFor({ allowAgentForceArchive: true })
    const outcome = await lifecycle.runArchive('p1', { force: true, actor: 'agent', rationale: '紧急修复回落' })
    expect(outcome.proposal.status).toBe('archived')
    const forced = (outcome.proposal.approvals ?? []).find((record) => record.forcedGates !== undefined)
    // The drift gate is only listed when it is configured on (default: off).
    expect(forced?.forcedGates).toEqual(['review-gate', 'tasks'])
    expect(forced?.rationale).toContain('紧急修复回落')
  })

  it('lets a human force the archive and records the bypassed gates', async () => {
    const lifecycle = lifecycleFor()
    const outcome = await lifecycle.runArchive('p1', { force: true, actor: 'human' })
    expect(outcome.proposal.status).toBe('archived')
    expect(outcome.forced).toBe(true)
    const forced = (outcome.proposal.approvals ?? []).find((record) => record.forcedGates !== undefined)
    expect(forced?.actor).toBe('human')
    // The drift gate is only listed when it is configured on (default: off).
    expect(forced?.forcedGates).toEqual(['review-gate', 'tasks'])
  })

  it('does not record a forced approval when the run was not forced', async () => {
    const lifecycle = lifecycleFor()
    const outcome = await lifecycle.runArchive('p1', { actor: 'human' })
    expect(outcome.forced).toBeUndefined()
    expect((outcome.proposal.approvals ?? []).some((record) => record.forcedGates !== undefined)).toBe(false)
  })

  it('reports forced only when the orchestration skipped a gate', async () => {
    const lifecycle = lifecycleFor({
      orchestrate: async (_proposal, _targets, options) =>
        options.reviewGate === false
          ? { ok: true, steps: [{ step: 'review-gate' as const, status: 'skipped' as const, summary: 'disabled by force' }], forced: true }
          : { ok: true, steps: [{ step: 'review-gate' as const, status: 'ok' as const, summary: '审查通过' }] },
    })
    expect((await lifecycle.runArchive('p1', { actor: 'human' })).forced).toBeUndefined()
    await proposals.setStatus('p1', 'archiving', { actor: 'human' })
    expect((await lifecycle.runArchive('p1', { actor: 'human', force: true })).forced).toBe(true)
  })

  it('still applies the human approval gate before force is considered', async () => {
    const lifecycle = lifecycleFor({ approvalsRequired: ['archiving', 'archived'] })
    await expect(lifecycle.runArchive('p1', { force: true, actor: 'agent' })).rejects.toThrow(/archived/)
  })
})
