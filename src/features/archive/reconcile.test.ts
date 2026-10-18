import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LifecycleServiceImpl } from './service.ts'
import { ProposalServiceImpl } from '../proposal/service.ts'
import { ProposalStore } from '../proposal/store.ts'
import { WorktreeManager } from '../worktree/manager.ts'

let home: string
let project: string
let proposals: ProposalServiceImpl
let lifecycle: LifecycleServiceImpl

const writePlan = async (changeId: string, tasks = '- [ ] 1. impl\n'): Promise<void> => {
  const dir = join(project, 'openspec', 'changes', changeId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'proposal.md'), `# ${changeId}\n`, 'utf8')
  await writeFile(join(dir, 'design.md'), '# design\n', 'utf8')
  await writeFile(join(dir, 'tasks.md'), tasks, 'utf8')
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wm-reconcile-'))
  project = await mkdtemp(join(tmpdir(), 'wm-reconcile-proj-'))
  proposals = new ProposalServiceImpl(new ProposalStore({ homeRoot: home, subdir: 'workmate' }))
  lifecycle = new LifecycleServiceImpl({
    proposals,
    worktree: new WorktreeManager({
      homeRoot: home,
      subdir: 'workmate',
      basePort: 3000,
      portStep: 10,
      copyFiles: [],
      packageManager: 'pnpm',
    }),
    openspecRoot: 'openspec',
    mainBranch: 'main',
    approvalsRequired: [],
    resolveProjectRoots: async () => [{ project: 'demo', root: project }],
    orchestrate: async () => ({ ok: true, steps: [] }),
  })
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
})

describe('evidence-driven authoring reconcile', () => {
  it('advances draft → proposing → reviewing, then stops at the G2 gate', async () => {
    await writePlan('p1')
    await proposals.upsert({ id: 'p1', title: 'p1', projects: ['demo'] })

    const first = await lifecycle.reconcile('p1')
    expect(first.transitions).toEqual([
      { from: 'draft', to: 'proposing' },
      { from: 'proposing', to: 'reviewing' },
    ])
    expect(first.proposal.status).toBe('reviewing')
    expect(first.blocked).toContain('G2')

    const fingerprint = await lifecycle.planFingerprint('p1')
    expect(fingerprint.hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('advances to ready once G2 approves the exact plan hash', async () => {
    await writePlan('p2')
    await proposals.upsert({ id: 'p2', title: 'p2', projects: ['demo'] })
    await lifecycle.reconcile('p2')

    const approved = await lifecycle.approvePlan('p2', { rationale: '方案可以' })
    expect(approved.fingerprint.hash).toBe(approved.approval.planHash)

    const after = await lifecycle.reconcile('p2')
    expect(after.transitions).toEqual([{ from: 'reviewing', to: 'ready' }])
    expect(after.proposal.status).toBe('ready')
    expect(after.proposal.approvals?.[0]).toMatchObject({ gate: 'ready', actor: 'human' })
  })

  it('rejects ready when the plan changed after approval', async () => {
    await writePlan('p3', '- [ ] old\n')
    await proposals.upsert({ id: 'p3', title: 'p3', projects: ['demo'] })
    await lifecycle.reconcile('p3')
    await lifecycle.approvePlan('p3')

    await writePlan('p3', '- [ ] new\n')
    await expect(lifecycle.transition('p3', 'ready')).rejects.toThrow(/G2 方案未确认/)

    const after = await lifecycle.reconcile('p3')
    expect(after.proposal.status).toBe('reviewing')
    expect(after.blocked).toContain('G2')
  })

  it('refuses to approve a missing plan', async () => {
    await mkdir(join(project, 'openspec', 'changes', 'p4'), { recursive: true })
    await proposals.upsert({ id: 'p4', title: 'p4', projects: ['demo'] })
    await expect(lifecycle.approvePlan('p4')).rejects.toThrow(/方案工件不完整/)
  })
  it('blocks implementing when the target plan no longer matches G2', async () => {
    await writePlan('p5', '- [ ] old\n')
    await proposals.upsert({
      id: 'p5',
      title: 'p5',
      targets: [{ project: 'demo', baseBranch: 'main' }],
    })
    await lifecycle.reconcile('p5')
    await lifecycle.approvePlan('p5')
    await proposals.setStatus('p5', 'ready', { actor: 'human' })

    await writePlan('p5', '- [ ] changed\n')
    await expect(lifecycle.transition('p5', 'implementing')).rejects.toThrow(/G2 方案已变化/)
    expect((await proposals.get('p5'))?.status).toBe('ready')
  })

  it('ignores tasks.md checkbox state in the plan hash', async () => {
    await writePlan('p6', '- [ ] 1. impl\n')
    await proposals.upsert({ id: 'p6', title: 'p6', projects: ['demo'] })
    const before = await lifecycle.planFingerprint('p6')
    await writePlan('p6', '- [x] 1. impl\n')
    const after = await lifecycle.planFingerprint('p6')
    expect(after.hash).toBe(before.hash)
  })

  it('invalidates G2 when the target matrix changes', async () => {
    await writePlan('p7')
    await proposals.upsert({ id: 'p7', title: 'p7', targets: [{ project: 'demo', baseBranch: 'main' }] })
    await lifecycle.reconcile('p7')
    await lifecycle.approvePlan('p7')
    await lifecycle.reconcile('p7')
    await proposals.patchFields('p7', {
      targets: [
        { project: 'demo', baseBranch: 'main' },
        { project: 'other', baseBranch: 'main' },
      ],
    })
    await expect(lifecycle.transition('p7', 'implementing')).rejects.toThrow(/G2 方案已变化/)
  })

  it('does not skip G2 for a legacy proposal that has plan artifacts', async () => {
    await writePlan('p8')
    await proposals.upsert({ id: 'p8', title: 'p8', projects: ['demo'] })
    await proposals.setStatus('p8', 'ready', { actor: 'human' })
    await expect(lifecycle.transition('p8', 'implementing')).rejects.toThrow(/G2 方案已变化/)
  })

})
