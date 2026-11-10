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
  new WorktreeManager({ subdir: 'workmate', basePort: 3000, portStep: 10 })

const lifecycleFor = (deps: Partial<ConstructorParameters<typeof LifecycleServiceImpl>[0]> = {}): LifecycleServiceImpl =>
  new LifecycleServiceImpl({ proposals, worktree: worktree(), ...deps })

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wm-approval-'))
  store = new ProposalStore({ homeRoot: home, subdir: 'workmate' })
  events = new EventLog({ homeRoot: home, subdir: 'workmate' })
  proposals = new ProposalServiceImpl(store, undefined, events)
  await proposals.upsert({ id: 'p1', title: '待合并的变更' })
  // Park the proposal right before the first gated state.
  await proposals.setStatus('p1', 'implementing', { actor: 'agent' })
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('archive manifest persistence', () => {
  it('writes the delivery summary onto the proposal after a successful archive', async () => {
    const manifest = { at: '2026-10-05T10:00:00.000Z', projects: [{ project: 'demo', root: '/tmp/demo', commits: ['abc1234'], reindexed: true }] }
    const lifecycle = new LifecycleServiceImpl({
      proposals,
      worktree: worktree(),
      orchestrate: async () => ({
        ok: true,
        steps: [{ step: 'status' as const, status: 'ok' as const, summary: 'archived' }],
        manifest,
      }),
      approvalsRequired: [],
    })
    await proposals.setStatus('p1', 'archiving', { actor: 'human' })

    const outcome = await lifecycle.runArchive('p1')

    expect(outcome.proposal.status).toBe('archived')
    expect((await proposals.get('p1'))?.archiveManifest).toEqual(manifest)
  })

  it('leaves the manifest untouched when the run fails', async () => {
    const lifecycle = new LifecycleServiceImpl({
      proposals,
      worktree: worktree(),
      orchestrate: async () => ({
        ok: false,
        steps: [{ step: 'review-gate' as const, status: 'failed' as const, summary: 'missing review.md' }],
      }),
      approvalsRequired: [],
    })
    await proposals.setStatus('p1', 'archiving', { actor: 'human' })

    await lifecycle.runArchive('p1')

    expect((await proposals.get('p1'))?.archiveManifest).toBeUndefined()
  })
})

describe('approval gate (separation of duties)', () => {
  it('refuses the agent actor at a gated state and says how to approve', async () => {
    const lifecycle = lifecycleFor()

    await expect(lifecycle.transition('p1', 'merging', { actor: 'agent' })).rejects.toThrow(InvalidTransitionError)
    await expect(lifecycle.transition('p1', 'merging', { actor: 'agent' })).rejects.toThrow(/需要人工批准/)
    await expect(lifecycle.transition('p1', 'merging', { actor: 'agent' })).rejects.toThrow(/approvalsRequired/)

    const proposal = await proposals.get('p1')
    expect(proposal?.status).toBe('implementing')
    expect(proposal?.approvals).toBeUndefined()
  })

  it('records the refusal as a gate failure attributed to the approval gate', async () => {
    const lifecycle = lifecycleFor()
    await lifecycle.transition('p1', 'merging', { actor: 'agent' }).catch(() => undefined)

    const { events: log } = await events.read()
    const refusal = log.find((event) => event.kind === 'gate-failed')
    expect(refusal?.gate).toBe('approval')
    expect(refusal?.to).toBe('merging')
    expect(refusal?.actor).toBe('agent')
  })

  it('lets a human cross the gate with a rationale and leaves an auditable trail', async () => {
    const lifecycle = lifecycleFor()
    // merging needs a resolvable project root to check the branch precondition;
    // this fixture registers none, so assert the approval happened first by
    // watching the record even when a later precondition refuses. A registered
    // root is out of scope for this unit: the gate is what is under test.
    await lifecycle.transition('p1', 'merging', { actor: 'human', rationale: '审过了' }).catch((error: unknown) => {
      expect(String(error)).not.toMatch(/需要人工批准/)
    })

    const { events: log } = await events.read()
    expect(log.some((event) => event.kind === 'approval' && event.actor === 'human')).toBe(true)
  })

  it('treats the plugin orchestration (system) as an approver', async () => {
    const lifecycle = lifecycleFor({ approvalsRequired: ['merging'] })
    await lifecycle.transition('p1', 'merging', { actor: 'system' }).catch((error: unknown) => {
      expect(String(error)).not.toMatch(/需要人工批准/)
    })

    const { events: log } = await events.read()
    expect(log.some((event) => event.kind === 'approval' && event.actor === 'system')).toBe(true)
  })

  it('adds a human gate for a high-risk proposal without relaxing the configured one', async () => {
    const lifecycle = lifecycleFor({ approvalsRequired: [], highRiskExtraGates: ['implementing'] })
    // Not high risk yet: the configured list is empty, so the agent may advance.
    await proposals.setStatus('p1', 'ready', { actor: 'agent' })
    await expect(lifecycle.transition('p1', 'implementing', { actor: 'agent' })).rejects.toThrow(
      /没有关联任何项目根|无关联项目根|no resolvable project|project root/i,
    )

    const stored = await store.load()
    const record = stored.find((entry) => entry.id === 'p1')
    if (record !== undefined) {
      record.risk = 'high'
      record.status = 'ready'
    }
    await store.save(stored)

    await expect(lifecycle.transition('p1', 'implementing', { actor: 'agent' })).rejects.toThrow(/高风险/)
  })

  it('leaves low-risk proposals on the configured gate only', async () => {
    const lifecycle = lifecycleFor({ approvalsRequired: [], highRiskExtraGates: ['implementing'] })
    const stored = await store.load()
    const record = stored.find((entry) => entry.id === 'p1')
    if (record !== undefined) {
      record.risk = 'low'
      record.status = 'ready'
    }
    await store.save(stored)

    await expect(lifecycle.transition('p1', 'implementing', { actor: 'agent' })).rejects.not.toThrow(/高风险/)
  })

  it('honours the allowAgentApproval escape hatch and an empty list', async () => {
    const permissive = lifecycleFor({ allowAgentApproval: true })
    await permissive.transition('p1', 'merging', { actor: 'agent' }).catch((error: unknown) => {
      expect(String(error)).not.toMatch(/需要人工批准/)
    })

    const disabled = lifecycleFor({ approvalsRequired: [] })
    await disabled.transition('p1', 'merging', { actor: 'agent' }).catch((error: unknown) => {
      expect(String(error)).not.toMatch(/需要人工批准/)
    })
  })

  it('falls back to the product default when the config is omitted', async () => {
    const lifecycle = new LifecycleServiceImpl({ proposals, worktree: worktree() })

    await expect(lifecycle.transition('p1', 'merging', { actor: 'agent' })).rejects.toThrow(/需要人工批准/)
  })

  it('does not let force bypass the gate (archived gated)', async () => {
    const lifecycle = lifecycleFor({ approvalsRequired: ['archived'] })
    await proposals.setStatus('p1', 'archiving', { actor: 'human' })

    await expect(lifecycle.runArchive('p1', { force: true, actor: 'agent' })).rejects.toThrow(/需要人工批准/)
  })

  it('records the covered commit when the proposal has one', async () => {
    const lifecycle = lifecycleFor({ approvalsRequired: ['merging'] })
    const stored = await store.load()
    const record = stored.find((entry) => entry.id === 'p1')
    if (record !== undefined) record.commits = ['deadbeef']
    await store.save(stored)
    await lifecycle.transition('p1', 'merging', { actor: 'human' }).catch(() => undefined)

    const proposal = await proposals.get('p1')
    expect(proposal?.approvals?.[0]).toMatchObject({ gate: 'merging', actor: 'human', decision: 'approve', commit: 'deadbeef' })
  })

  it('leaves the approval record free of empty optional fields', async () => {
    const lifecycle = lifecycleFor({ approvalsRequired: ['merging'] })
    await lifecycle.transition('p1', 'merging', { actor: 'human', rationale: '' }).catch(() => undefined)

    const record = (await proposals.get('p1'))?.approvals?.[0]
    expect(record?.rationale).toBeUndefined()
    expect(record?.commit).toBeUndefined()
  })
})

describe('unassessed risk must not bypass the risk gate (risk-gate-bypass)', () => {
  it('refuses an agent entering a risk-gated state while risk is unknown', async () => {
    const lifecycle = lifecycleFor({
      approvalsRequired: [],
      highRiskExtraGates: ['implementing'],
      riskGateEnabled: true,
    })
    await proposals.setStatus('p1', 'ready', { actor: 'human' })

    await expect(lifecycle.transition('p1', 'implementing', { actor: 'agent' })).rejects.toThrow(
      /必须先判定风险|risk/i,
    )
    // Humans stay unblocked by this guard (they own the risk decision).
    await expect(lifecycle.transition('p1', 'implementing', { actor: 'human' })).rejects.not.toThrow(
      /必须先判定风险/,
    )
  })

  it('keeps working when the judgement layer is off', async () => {
    const lifecycle = lifecycleFor({ approvalsRequired: [], highRiskExtraGates: ['implementing'] })
    await proposals.setStatus('p1', 'ready', { actor: 'human' })

    // No risk concept without the judgement layer: the configured gate list is empty,
    // so the only possible failure is the unrelated project-root check.
    await expect(lifecycle.transition('p1', 'implementing', { actor: 'agent' })).rejects.toThrow(
      /没有关联任何项目根|无关联项目根|no resolvable project|project root/i,
    )
  })
})
