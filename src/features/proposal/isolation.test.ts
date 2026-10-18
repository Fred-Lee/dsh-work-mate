import { describe, expect, it } from 'vitest'
import { deriveBranchOccupancy, findBranchConflicts } from './isolation.ts'
import type { Proposal } from './store.ts'

const proposal = (overrides: Partial<Proposal> & Pick<Proposal, 'id'>): Proposal => ({
  title: overrides.id,
  status: 'implementing',
  projects: ['repo'],
  commits: [],
  openspecChangeId: overrides.id,
  createdAt: '2026-10-19T00:00:00.000Z',
  updatedAt: '2026-10-19T00:00:00.000Z',
  ...overrides,
})

describe('isolation occupancy', () => {
  it('derives proposal+feature branches from explicit targets', () => {
    const occupancy = deriveBranchOccupancy(
      [
        proposal({
          id: 'a',
          targets: [
            { project: 'one', baseBranch: 'main', proposalBranch: 'proposal/a', featureBranch: 'feature/a' },
            { project: 'two', baseBranch: 'master', proposalBranch: 'proposal/a', featureBranch: 'feature/a' },
          ],
        }),
      ],
      'main',
    )

    expect(occupancy).toHaveLength(4)
    expect(occupancy.map((entry) => [entry.project, entry.branch, entry.kind])).toEqual([
      ['one', 'feature/a', 'feature'],
      ['one', 'proposal/a', 'proposal'],
      ['two', 'feature/a', 'feature'],
      ['two', 'proposal/a', 'proposal'],
    ])
  })

  it('includes legacy scalar branches and excludes archived/abandoned proposals', () => {
    const occupancy = deriveBranchOccupancy(
      [
        proposal({ id: 'legacy', proposalBranch: 'proposal/legacy', featureBranch: 'feature/legacy' }),
        proposal({ id: 'done', status: 'archived', featureBranch: 'feature/done' }),
        proposal({ id: 'gone', status: 'implementing', abandonedAt: '2026-10-19T00:00:00.000Z', featureBranch: 'feature/gone' }),
        proposal({ id: 'draft', status: 'draft', featureBranch: 'feature/draft' }),
      ],
      'main',
    )

    expect(occupancy.map((entry) => entry.proposalId)).toEqual(['legacy', 'legacy'])
  })

  it('reports a conflict only when two active proposals share project + branch', () => {
    const occupancy = deriveBranchOccupancy(
      [
        proposal({ id: 'a', targets: [{ project: 'repo', baseBranch: 'main', featureBranch: 'feature/shared' }] }),
        proposal({ id: 'b', targets: [{ project: 'repo', baseBranch: 'main', featureBranch: 'feature/shared' }] }),
        proposal({ id: 'c', targets: [{ project: 'repo', baseBranch: 'main', featureBranch: 'feature/c' }] }),
      ],
      'main',
    )

    expect(findBranchConflicts(occupancy)).toEqual([
      { project: 'repo', branch: 'feature/shared', proposalIds: ['a', 'b'] },
    ])
  })

  it('does not conflate different projects or a proposal/feature duplicate of one proposal', () => {
    const occupancy = deriveBranchOccupancy(
      [
        proposal({ id: 'a', targets: [{ project: 'one', baseBranch: 'main', featureBranch: 'same' }] }),
        proposal({ id: 'b', targets: [{ project: 'two', baseBranch: 'main', featureBranch: 'same' }] }),
        proposal({ id: 'c', targets: [{ project: 'three', baseBranch: 'main', proposalBranch: 'same', featureBranch: 'same' }] }),
      ],
      'main',
    )

    expect(findBranchConflicts(occupancy)).toEqual([])
  })
})
