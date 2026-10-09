import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { collectArtifactLedger, computeDrift, declaredScopes, scopeCovers } from './artifacts.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wm-artifacts-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('declaredScopes', () => {
  it('merges writes from tasks.md and files from design.md', () => {
    const declared = declaredScopes({
      tasksMd: '- [ ] 1. a <!-- writes: src/a/**, docs/a.md -->\n- [ ] 2. b <!-- writes: src/a/** -->',
      designMd: '<!-- files: src/b/**, package.json -->',
    })

    expect(declared).toEqual(['src/a/**', 'docs/a.md', 'src/b/**', 'package.json'])
  })

  it('is empty when nothing is declared', () => {
    expect(declaredScopes({ tasksMd: '- [ ] 1. a', designMd: '# Design' })).toEqual([])
  })
})

describe('scopeCovers', () => {
  it('covers the subtree and the exact file', () => {
    expect(scopeCovers('src/a/**', 'src/a/x.ts')).toBe(true)
    expect(scopeCovers('src/a/**', 'src/a')).toBe(true)
    expect(scopeCovers('package.json', 'package.json')).toBe(true)
  })

  it('does not cover siblings or parents', () => {
    expect(scopeCovers('src/a/**', 'src/b/x.ts')).toBe(false)
    expect(scopeCovers('src/a/x.ts', 'src/a')).toBe(false)
  })
})

describe('computeDrift', () => {
  it('lists undeclared changes and declared-but-untouched scopes', () => {
    const drift = computeDrift(['src/a/**', 'docs/plan.md'], ['src/a/x.ts', 'src/b/y.ts'])

    expect(drift.undeclared).toEqual(['src/b/y.ts'])
    expect(drift.missing).toEqual(['docs/plan.md'])
    expect(drift.driftRatio).toBeCloseTo(0.5)
    expect(drift.note).toBeUndefined()
  })

  it('says drift is unknowable without declarations instead of flagging everything', () => {
    const drift = computeDrift([], ['src/a/x.ts', 'src/b/y.ts'])

    expect(drift.undeclared).toEqual([])
    expect(drift.driftRatio).toBe(0)
    expect(drift.note).toContain('无法判定漂移')
  })

  it('reports no drift when the diff stays inside the declaration', () => {
    const drift = computeDrift(['src/a/**'], ['src/a/x.ts', 'src/a/y.ts'])

    expect(drift.undeclared).toEqual([])
    expect(drift.missing).toEqual([])
    expect(drift.driftRatio).toBe(0)
  })

  it('deduplicates and sorts the actual set', () => {
    const drift = computeDrift(['src/**'], ['src/b.ts', 'src/a.ts', 'src/a.ts'])

    expect(drift.actual).toEqual(['src/a.ts', 'src/b.ts'])
  })
})

describe('collectArtifactLedger', () => {
  it('hashes the known artifacts and skips directories', async () => {
    const changeDir = join(dir, '2026-10-05-demo')
    await mkdir(join(changeDir, 'specs'), { recursive: true })
    await writeFile(join(changeDir, 'proposal.md'), '# Proposal', 'utf8')
    await writeFile(join(changeDir, 'tasks.md'), '- [x] 1. done', 'utf8')
    await writeFile(join(changeDir, 'review.md'), '<!-- reviewer: a@1 -->', 'utf8')

    const ledger = await collectArtifactLedger(changeDir, { commit: 'abc1234' })
    const paths = ledger.map((record) => record.path.split('/').pop())

    expect(paths).toEqual(expect.arrayContaining(['proposal.md', 'tasks.md', 'review.md']))
    expect(paths).not.toContain('specs')
    const proposal = ledger.find((record) => record.path.endsWith('proposal.md'))
    expect(proposal?.sha256).toHaveLength(64)
    expect(proposal?.bytes).toBe(Buffer.byteLength('# Proposal'))
    expect(proposal?.commit).toBe('abc1234')
  })

  it('degrades to a note when the directory is unreadable', async () => {
    const ledger = await collectArtifactLedger(join(dir, 'missing'))

    expect(ledger).toHaveLength(1)
    expect(ledger[0]?.note).toContain('cannot read change directory')
  })
})

describe('excluded declarations', () => {
  it('reports declarations inside an ignored prefix as excluded, not missing', () => {
    const report = computeDrift(
      ['openspec/changes/p1/specs/**', 'src/a/**'],
      ['src/b.ts'],
      { ignoredPrefixes: ['openspec/changes/'] },
    )

    expect(report.excluded).toEqual(['openspec/changes/p1/specs/**'])
    expect(report.missing).toEqual(['src/a/**'])
    expect(report.undeclared).toEqual(['src/b.ts'])
  })

  it('treats a scope equal to the ignored prefix as excluded too', () => {
    const report = computeDrift(['openspec/changes/p1'], ['src/b.ts'], { ignoredPrefixes: ['openspec/changes/p1'] })

    expect(report.excluded).toEqual(['openspec/changes/p1'])
    expect(report.missing).toEqual([])
  })
})
