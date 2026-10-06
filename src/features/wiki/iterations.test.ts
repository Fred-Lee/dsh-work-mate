import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  collectArchivedIterations,
  extractSummary,
  extractTouches,
  humanizeSlug,
  indexCommitMarks,
  mergeIterations,
  parseArchiveDirName,
} from './iterations.ts'

const PROPOSAL = `## Why
提交处理存在并发安全问题，需要补充同步错题逻辑。

## What Changes
- 修缺陷

## Impact
- **Affected code**: \`src/main/java/com/zujuan/homework/service/CommitReplyOptimized.java\`
- **Related systems**: \`homework-management\`, 错题同步
`

async function seedArchive(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wm-iter-'))
  const archive = join(root, 'openspec', 'changes', 'archive')
  await mkdir(join(archive, '2025-11-24-analyze-commit-reply-optimized'), { recursive: true })
  await mkdir(join(archive, '2026-01-30-add-option-percent-statistics'), { recursive: true })
  await writeFile(join(archive, '2025-11-24-analyze-commit-reply-optimized', 'proposal.md'), PROPOSAL, 'utf8')
  await writeFile(
    join(archive, '2026-01-30-add-option-percent-statistics', 'proposal.md'),
    '## Why\n百分比统计选项缺失。\n',
    'utf8',
  )
  return root
}

describe('archive-derived iterations (derive-iterations-from-archive)', () => {
  it('parses the date and id from the archive directory name', () => {
    expect(parseArchiveDirName('2026-01-30-add-option-percent-statistics')).toEqual({
      date: '2026-01-30',
      id: 'add-option-percent-statistics',
    })
    expect(parseArchiveDirName('not-a-change')).toBeUndefined()
    expect(humanizeSlug('add-option-percent-statistics')).toBe('Add option percent statistics')
  })

  it('extracts a one-line summary and the touched code paths', () => {
    expect(extractSummary(PROPOSAL)).toBe('提交处理存在并发安全问题，需要补充同步错题逻辑。')
    expect(extractTouches(PROPOSAL)).toContain('src/main/java/com/zujuan/homework/service/CommitReplyOptimized.java')
    expect(extractTouches('## Why\n什么都没有\n')).toEqual([])
  })

  it('indexes [proposal:<id>] commit marks in one pass', () => {
    const marks = indexCommitMarks('abc12345\tfeat(proposal): x [proposal:iter-2]\ndef67890\tchore: y')

    expect(marks.get('iter-2')).toEqual(['abc12345'])
    expect(marks.get('iter-1')).toBeUndefined()
  })

  it('collects archived changes oldest first with a DERIVED predecessor link', async () => {
    const root = await seedArchive()
    const iterations = await collectArchivedIterations({
      projectRoot: root,
      gitLog: async () => 'abc12345\tfix [proposal:add-option-percent-statistics]',
    })

    expect(iterations.map((iteration) => iteration.id)).toEqual([
      'analyze-commit-reply-optimized',
      'add-option-percent-statistics',
    ])
    expect(iterations[0]?.origin).toBe('archive')
    expect(iterations[0]?.sequence).toBeUndefined()          // nothing precedes the first
    expect(iterations[1]?.sequence).toBe('analyze-commit-reply-optimized')
    expect(iterations[1]?.commits).toEqual(['abc12345'])
    // Declared dependencies are never invented from history:
    expect(iterations.every((iteration) => iteration.dependsOn.length === 0)).toBe(true)
    expect(iterations[0]?.touches).toContain('src/main/java/com/zujuan/homework/service/CommitReplyOptimized.java')

    await rm(root, { recursive: true, force: true })
  })

  it('returns nothing for a project without an archive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wm-iter-empty-'))
    expect(await collectArchivedIterations({ projectRoot: root })).toEqual([])
    await rm(root, { recursive: true, force: true })
  })

  it('lets proposal-driven iterations win over archive entries with the same id', () => {
    const proposal = {
      id: 'iter-1',
      title: '来自提案',
      status: 'archived',
      archived: true,
      dependsOn: ['iter-0'],
      supersedes: [],
      commits: [],
      origin: 'proposal' as const,
    }
    const archived = { ...proposal, title: '来自归档', origin: 'archive' as const, date: '2026-01-01' }

    const merged = mergeIterations([proposal], [archived])

    expect(merged).toHaveLength(1)
    expect(merged[0]?.title).toBe('来自提案')
  })
})
