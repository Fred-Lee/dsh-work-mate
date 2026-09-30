import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  PROPOSAL_STATES,
  checkTransition,
  migrateStatus,
  nextState,
  STATE_HINTS,
} from './state-machine.ts'
import { ProposalStore } from './store.ts'
import { ProposalServiceImpl } from './service.ts'
import { WorktreeManager } from '../worktree/manager.ts'
import { LifecycleServiceImpl, InvalidTransitionError } from '../archive/service.ts'

let home: string
let store: ProposalStore
let proposals: ProposalServiceImpl
let lifecycle: LifecycleServiceImpl

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wm-lifecycle-'))
  store = new ProposalStore({ homeRoot: home, subdir: 'workmate' })
  proposals = new ProposalServiceImpl(store)
  const worktree = new WorktreeManager({
    subdir: 'workmate',
    basePort: 3000,
    portStep: 10,
    copyFiles: [],
    packageManager: 'pnpm',
  })
  lifecycle = new LifecycleServiceImpl({ proposals, worktree })
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('state machine structure', () => {
  it('defines the eight-state chain with hints', () => {
    expect(PROPOSAL_STATES).toEqual([
      'draft',
      'proposing',
      'reviewing',
      'ready',
      'implementing',
      'merging',
      'archiving',
      'archived',
    ])
    expect(Object.keys(STATE_HINTS)).toHaveLength(8)
  })

  it('rejects jumps with adjacent targets in the message', () => {
    const check = checkTransition('proposing', 'implementing')
    expect(check.ok).toBe(false)
    expect(check.reason).toContain('adjacent states are: draft, reviewing')
  })

  it('allows only adjacent transitions in both directions', () => {
    expect(checkTransition('draft', 'proposing')).toMatchObject({ ok: true, direction: 'forward' })
    expect(checkTransition('proposing', 'draft')).toMatchObject({ ok: true, direction: 'backward' })
    expect(checkTransition('merging', 'archiving')).toMatchObject({ ok: true, direction: 'forward' })
  })

  it('migrates the old four statuses onto the new chain', () => {
    expect(migrateStatus('draft')).toBe('draft')
    expect(migrateStatus('reviewing')).toBe('reviewing')
    expect(migrateStatus('executing')).toBe('implementing')
    expect(migrateStatus('archived')).toBe('archived')
    expect(migrateStatus('whatever')).toBe('draft')
  })

  it('reports undefined next at the terminal state', () => {
    expect(nextState('archived')).toBeUndefined()
    expect(nextState('draft')).toBe('proposing')
  })
})

describe('lifecycle transitions (headless)', () => {
  it('advances step by step; jumps are refused by construction', async () => {
    await proposals.upsert({ id: 'p1', title: 't' })

    // draft → proposing is blocked for headless proposals? No: headless skips
    // project-side facts entirely, so the whole chain walks freely.
    for (const expected of PROPOSAL_STATES.slice(1)) {
      const result = await lifecycle.advance('p1')
      expect(result.proposal.status).toBe(expected)
    }
    await expect(lifecycle.advance('p1')).rejects.toThrow('already archived')
  })

  it('transitions backward freely and refuses unknown targets', async () => {
    await proposals.upsert({ id: 'p2', title: 't' })
    await lifecycle.advance('p2')
    await lifecycle.advance('p2')

    const back = await lifecycle.transition('p2', 'proposing')
    expect(back.proposal.status).toBe('proposing')

    await expect(lifecycle.transition('p2', 'implementing')).rejects.toBeInstanceOf(InvalidTransitionError)
    await expect(lifecycle.transition('p2', 'nope' as never)).rejects.toThrow()
  })

  it('runArchive requires the archiving state', async () => {
    await proposals.upsert({ id: 'p3', title: 't' })
    await expect(lifecycle.runArchive('p3')).rejects.toThrow('advance to archiving first')
  })
})
