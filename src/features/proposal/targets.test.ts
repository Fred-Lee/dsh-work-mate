import { describe, expect, it } from 'vitest'
import { effectiveTargets, normalizeTargets } from './targets.ts'
import type { Proposal } from './store.ts'

const legacy = (overrides: Partial<Proposal> = {}): Proposal => ({
  id: 'p1',
  title: 'legacy',
  status: 'proposing',
  projects: ['internal-homework'],
  commits: [],
  openspecChangeId: 'p1',
  worktreePath: '/repo/.workmates/p1',
  proposalBranch: 'proposal/p1',
  featureBranch: 'feature/p1',
  portRange: [3000, 3001],
  createdAt: '2026-10-19T00:00:00.000Z',
  updatedAt: '2026-10-19T00:00:00.000Z',
  ...overrides,
})

describe('effectiveTargets', () => {
  it('projects a legacy single-target proposal onto one target', () => {
    expect(effectiveTargets(legacy(), 'main')).toEqual([
      {
        project: 'internal-homework',
        baseBranch: 'main',
        proposalBranch: 'proposal/p1',
        featureBranch: 'feature/p1',
        worktreePath: '/repo/.workmates/p1',
        portRange: [3000, 3001],
      },
    ])
  })

  it('prefers explicit targets and copies their arrays', () => {
    const proposal = legacy({
      targets: [
        { project: 'a', baseBranch: 'main', featureBranch: 'feature/p1', portRange: [3000] },
        { project: 'b', baseBranch: 'master', featureBranch: 'feature/p1', portRange: [3010] },
      ],
    })
    const result = effectiveTargets(proposal, 'main')

    expect(result.map((target) => [target.project, target.baseBranch])).toEqual([
      ['a', 'main'],
      ['b', 'master'],
    ])
    result[0]!.portRange!.push(9999)
    expect(proposal.targets?.[0]?.portRange).toEqual([3000])
  })

  it('returns no targets for a headless proposal', () => {
    expect(effectiveTargets(legacy({ projects: [] }), 'main')).toEqual([])
  })
})

describe('normalizeTargets', () => {
  it('trims fields and copies arrays', () => {
    const source = [
      { project: ' a ', baseBranch: ' main ', featureBranch: 'feature/p1', portRange: [3000] },
    ]
    const normalized = normalizeTargets(source)

    expect(normalized).toEqual([
      { project: 'a', baseBranch: 'main', featureBranch: 'feature/p1', portRange: [3000] },
    ])
    normalized[0]!.portRange!.push(9999)
    expect(source[0]!.portRange).toEqual([3000])
  })

  it('rejects an empty project or branch', () => {
    expect(() => normalizeTargets([{ project: '', baseBranch: 'main' }])).toThrow('target.project')
    expect(() => normalizeTargets([{ project: 'a', baseBranch: ' ' }])).toThrow('baseBranch')
  })

  it('rejects duplicate projects', () => {
    expect(() =>
      normalizeTargets([
        { project: 'a', baseBranch: 'main' },
        { project: 'a', baseBranch: 'master' },
      ]),
    ).toThrow('duplicate target project')
  })

  it('rejects whitespace inside a branch token', () => {
    expect(() => normalizeTargets([{ project: 'a', baseBranch: 'feature branch' }])).toThrow(
      'must not contain whitespace',
    )
  })
})
