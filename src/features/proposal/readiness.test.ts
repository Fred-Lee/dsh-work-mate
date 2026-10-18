import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assessReadiness } from './readiness.ts'
import type { Proposal } from './store.ts'
import { DEFAULT_TEAM_BUDGET, type TeamRun } from '../team/types.ts'

let root: string
const dir = (): string => join(root, 'openspec', 'changes', 'p1')

const proposal = (overrides: Partial<Proposal> = {}): Proposal =>
  ({
    id: 'p1',
    title: 'p1',
    status: 'ready',
    projects: ['demo'],
    targets: [{ project: 'demo', baseBranch: 'main' }],
    openspecChangeId: 'p1',
    createdAt: '2026-10-19T00:00:00.000Z',
    updatedAt: '2026-10-19T00:00:00.000Z',
    ...overrides,
  }) as Proposal

const writeArtifacts = async (): Promise<void> => {
  await mkdir(dir(), { recursive: true })
  await writeFile(join(dir(), 'proposal.md'), '# p\n', 'utf8')
  await writeFile(join(dir(), 'design.md'), '# d\n', 'utf8')
  await writeFile(join(dir(), 'tasks.md'), '- [ ] 1\n', 'utf8')
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wm-readiness-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('assessReadiness', () => {
  it('fails on incomplete artifacts and unapproved plan', async () => {
    const result = await assessReadiness(proposal(), { projectRoot: root, openspecRoot: 'openspec' })
    expect(result.ready).toBe(false)
    expect(result.checks.find((check) => check.id === 'artifacts')?.status).toBe('fail')
    expect(result.checks.find((check) => check.id === 'plan-approval')?.status).toBe('fail')
  })

  it('is ready when artifacts and planHash are approved', async () => {
    await writeArtifacts()
    const hashProbe = await assessReadiness(proposal(), { projectRoot: root, openspecRoot: 'openspec' })
    const artifacts = hashProbe.checks.find((check) => check.id === 'artifacts')
    expect(artifacts?.status).toBe('ok')
    const hash = artifacts?.detail.match(/planHash (\w+)/)?.[1]
    expect(hash).toBeDefined()

    // Recompute the full hash through the same path, then approve it.
    const { computePlanFingerprint } = await import('./plan.ts')
    const fingerprint = await computePlanFingerprint(root, 'openspec', 'p1')
    const approved = proposal({
      approvals: [
        {
          gate: 'ready',
          actor: 'human',
          decision: 'approve',
          at: '2026-10-19T00:00:00.000Z',
          planHash: fingerprint.hash,
        },
      ],
    })
    const result = await assessReadiness(approved, { projectRoot: root, openspecRoot: 'openspec' })
    expect(result.checks.find((check) => check.id === 'plan-approval')?.status).toBe('ok')
    expect(result.ready).toBe(true)
  })

  it('surfaces a failed team run', async () => {
    await writeArtifacts()
    const run = {
      id: 'r1',
      proposalId: 'p1',
      template: 'bug-fix',
      status: 'partial',
      tasks: [],
      budget: DEFAULT_TEAM_BUDGET,
      createdAt: '2026-10-19T00:00:00.000Z',
      updatedAt: '2026-10-19T00:00:00.000Z',
    } as TeamRun
    const result = await assessReadiness(proposal(), { projectRoot: root, openspecRoot: 'openspec', teamRun: run })
    expect(result.checks.find((check) => check.id === 'team-run')?.status).toBe('fail')
  })
})
