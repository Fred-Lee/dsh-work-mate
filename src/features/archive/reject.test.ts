import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LifecycleServiceImpl } from './service.ts'
import { ProposalServiceImpl } from '../proposal/service.ts'
import { ProposalStore } from '../proposal/store.ts'
import { WorktreeManager } from '../worktree/manager.ts'

let home: string
let proposals: ProposalServiceImpl
let lifecycle: LifecycleServiceImpl

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wm-reject-'))
  proposals = new ProposalServiceImpl(new ProposalStore({ homeRoot: home, subdir: 'workmate' }))
  lifecycle = new LifecycleServiceImpl({
    proposals,
    worktree: new WorktreeManager({
      homeRoot: home,
      subdir: 'workmate',
      basePort: 3000,
      portStep: 10,
    }),
    openspecRoot: 'openspec',
    mainBranch: 'main',
    approvalsRequired: [],
    orchestrate: async () => ({ ok: true, steps: [] }),
  })
  await proposals.upsert({ id: 'p1', title: 'p1', projects: [] })
  await proposals.setStatus('p1', 'merging')
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('G5 rejection', () => {
  it('sends an implementation rejection back to implementing with a reject approval', async () => {
    const result = await lifecycle.rejectMerge('p1', { category: 'implementation', rationale: '空指针未修' })
    expect(result.proposal.status).toBe('implementing')
    expect(result.approval).toMatchObject({ gate: 'merging', decision: 'reject' })
    const approvals = (await proposals.get('p1'))?.approvals ?? []
    expect(approvals.filter((approval) => approval.decision === 'reject')).toHaveLength(1)
  })

  it('also invalidates the last G2 approval for a plan rejection', async () => {
    await lifecycle.rejectMerge('p1', { category: 'plan', rationale: '方案漏了回滚' })
    const approvals = (await proposals.get('p1'))?.approvals ?? []
    expect(approvals.some((approval) => approval.gate === 'ready' && approval.decision === 'reject')).toBe(true)
    expect((await proposals.get('p1'))?.status).toBe('ready')
  })

  it('refuses rejection outside merging and without a rationale', async () => {
    await proposals.setStatus('p1', 'implementing')
    await expect(lifecycle.rejectMerge('p1', { category: 'implementation', rationale: 'x' })).rejects.toThrow(
      /只有 merging/,
    )
    await proposals.setStatus('p1', 'merging')
    await expect(lifecycle.rejectMerge('p1', { category: 'implementation', rationale: '  ' })).rejects.toThrow(
      /理由/,
    )
  })
})
