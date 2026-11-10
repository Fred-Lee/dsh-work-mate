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

  it('excludes only the abandon persisted form (archived + abandonedAt); residual abandonedAt still occupies', () => {
    const occupancy = deriveBranchOccupancy(
      [
        proposal({ id: 'legacy', proposalBranch: 'proposal/legacy', featureBranch: 'feature/legacy' }),
        proposal({ id: 'done', status: 'archived', featureBranch: 'feature/done' }),
        // abandon 落盘形态：status=archived + abandonedAt 才算「已终止」。
        proposal({ id: 'gone', status: 'archived', abandonedAt: '2026-10-19T00:00:00.000Z', featureBranch: 'feature/gone' }),
        // 残留 abandonedAt 但状态已回到活跃（真机 team-e2e-final 的 merging）：照常占用。
        proposal({
          id: 'residue',
          status: 'merging',
          abandonedAt: '2026-11-09T00:00:00.000Z',
          proposalBranch: 'proposal/residue',
          featureBranch: 'feature/residue',
        }),
        proposal({ id: 'draft', status: 'draft', featureBranch: 'feature/draft' }),
      ],
      'main',
    )

    // 每条提案先 feature 后 proposal，按输入顺序展开。
    expect(occupancy.map((entry) => entry.proposalId)).toEqual(['legacy', 'residue', 'legacy', 'residue'])
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
