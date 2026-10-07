import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { queryTerms, searchVault } from './search.ts'
import { dataviewViews, vaultViews } from './views.ts'
import { extractTouches } from './iterations.ts'

async function seedVault(): Promise<string> {
  const vault = await mkdtemp(join(tmpdir(), 'wm-search-'))
  const dir = join(vault, 'WorkMate', 'demo', 'modules')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'grading.md'),
    ['---', 'title: 阅卷模块', '---', '# 阅卷模块', '', '批改并发控制使用分布式锁。', '错题同步在批改后触发。'].join('\n'),
    'utf8',
  )
  await writeFile(join(vault, 'WorkMate', 'demo', 'index.md'), '# demo\n\n索引页。\n', 'utf8')
  return vault
}

describe('vault search (wiki-search-in-vault)', () => {
  it('splits terms and returns file:line hits ranked by match count', async () => {
    const vault = await seedVault()
    const result = await searchVault({ vaultPath: vault, project: 'demo', query: '批改 并发' })

    expect(result.scannedFiles).toBe(2)
    expect(result.hits[0]?.file).toContain('grading.md')
    expect(result.hits[0]?.line).toBeGreaterThan(1)
    expect(result.hits[0]?.text).toContain('批改并发控制')
    await rm(vault, { recursive: true, force: true })
  })

  it('is honest about empty results and empty queries', async () => {
    const vault = await seedVault()
    expect(await searchVault({ vaultPath: vault, project: 'demo', query: '不存在的词' })).toMatchObject({ hits: [] })
    expect(await searchVault({ vaultPath: vault, query: '   ' })).toMatchObject({ hits: [], note: '空查询' })
    await rm(vault, { recursive: true, force: true })
  })

  it('reports a missing vault instead of throwing', async () => {
    const result = await searchVault({ vaultPath: '/definitely/not/here', query: 'x' })

    expect(result.hits).toEqual([])
    expect(result.note).toContain('vault 里没有可搜索的笔记')
  })

  it('caps hits and says so', async () => {
    const vault = await seedVault()
    const result = await searchVault({ vaultPath: vault, project: 'demo', query: '批改', limit: 1 })

    expect(result.hits).toHaveLength(1)
    expect(result.note).toContain('已返回前 1 行')
    await rm(vault, { recursive: true, force: true })
  })
})

describe('dataview view notes (dataview-views-in-vault)', () => {
  it('only queries fields the exporter writes', () => {
    const note = dataviewViews({ project: 'demo', subdir: 'WorkMate', modules: 13, pages: 47, iterations: 62 })

    expect(note).toContain('type: "views"')
    expect(note).toContain('FROM "WorkMate/demo/iterations"')
    expect(note).toContain('SORT date ASC')
    expect(note).toContain('touches')
    expect(note).toContain('未装 Dataview 时')
    // No invented keys:
    for (const key of ['priority', 'owner', 'sprint']) expect(note).not.toContain(key)
  })

  it('lists projects in the vault-level note', () => {
    const note = vaultViews(['alpha', 'beta'], 'WorkMate')

    expect(note).toContain('[[WorkMate/alpha/index|alpha]]')
    expect(note).toContain('[[WorkMate/beta/index|beta]]')
  })
})

describe('bare-path touches (classify-touches-by-decision)', () => {
  it('accepts paths without backticks when the Impact section has none', () => {
    const proposal = [
      '## Why',
      '修复并发问题。',
      '## Impact',
      '- Affected code: src/main/java/com/zujuan/homework/service/CommitReplyOptimized.java',
      '- 也涉及 WrongQuesRate.java',
    ].join('\n')

    const touches = extractTouches(proposal)

    expect(touches).toContain('src/main/java/com/zujuan/homework/service/CommitReplyOptimized.java')
    expect(touches).toContain('WrongQuesRate.java')
  })

  it('prefers backticked values and still ignores pure prose', () => {
    const proposal = '## Impact\n- `a/b/C.java`\n- 只有中文描述，没有路径'
    expect(extractTouches(proposal)).toEqual(['a/b/C.java'])
    expect(extractTouches('## Why\n没有 Impact 段')).toEqual([])
  })
})

describe('queryTerms', () => {
  it('keeps CJK runs and splits latin words', () => {
    expect(queryTerms('批改 并发 control')).toEqual(['批改', '并发', 'control'])
    expect(queryTerms('   ')).toEqual([])
  })
})
