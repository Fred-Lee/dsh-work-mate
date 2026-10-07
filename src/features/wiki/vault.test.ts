import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { exportWikiToVault, iterationsFromProposals } from './vault.ts'
import type { Proposal } from '../proposal/store.ts'

/** Minimal GitNexus wiki fixture: two modules, one with sub-pages. */
async function seedRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'wm-vault-repo-'))
  const wiki = join(root, '.gitnexus', 'wiki')
  await mkdir(wiki, { recursive: true })
  await writeFile(
    join(wiki, 'module_tree.json'),
    JSON.stringify([
      { name: 'Homework Management', slug: 'homework-management', files: 3 },
      { name: 'API Controllers', slug: 'api-controllers', files: 1 },
    ]),
    'utf8',
  )
  await writeFile(
    join(wiki, 'meta.json'),
    JSON.stringify({ fromCommit: 'f987767abcdef', generatedAt: '2026-10-07T00:00:00.000Z', lang: 'chinese' }),
    'utf8',
  )
  await writeFile(join(wiki, 'homework-management.md'), '# Homework Management\n\n总览正文。\n', 'utf8')
  await writeFile(join(wiki, 'homework-management-main.md'), '# 主流程\n\n批改主流程。\n', 'utf8')
  await writeFile(join(wiki, 'api-controllers.md'), '# API Controllers\n\n接口层。\n', 'utf8')
  return root
}

const proposalOf = (over: Partial<Proposal>): Proposal =>
  ({
    id: 'iter-2',
    title: '批量批改 v2',
    status: 'archived',
    projects: ['internal-homework'],
    relatesTo: ['iter-1'],
    decisions: [{ id: 'd1', decision: '改用异步', rationale: '吞吐', supersedes: 'iter-1' }],
    commits: ['f987767aaaa'],
    ...over,
  }) as unknown as Proposal

describe('vault export (export-wiki-to-vault)', () => {
  it('writes index, module notes, iteration notes and a changelog', async () => {
    const repo = await seedRepo()
    const vault = await mkdtemp(join(tmpdir(), 'wm-vault-'))

    const result = await exportWikiToVault({
      projectRoot: repo,
      project: 'internal-homework',
      vaultPath: vault,
      iterations: iterationsFromProposals([proposalOf({})]),
    })

    expect(result.modules).toBe(2)
    expect(result.pages).toBe(3)
    expect(result.iterations).toBe(1)
    expect(result.commit).toBe('f987767a')

    const index = await readFile(join(vault, 'WorkMate', 'internal-homework', 'index.md'), 'utf8')
    expect(index).toContain('type: "moc"')
    expect(index).toContain('[[WorkMate/internal-homework/modules/homework-management\\|Homework Management]]')
    expect(index).toContain('module')

    const module = await readFile(join(vault, 'WorkMate', 'internal-homework', 'modules', 'homework-management.md'), 'utf8')
    expect(module).toContain('title: "Homework Management"')
    expect(module).toContain('批改主流程')          // sub-page folded into the module note
    expect(module).toContain('[[WorkMate/internal-homework/index|')
    expect(module).toContain('commit `f987767a`')

    const iteration = await readFile(join(vault, 'WorkMate', 'internal-homework', 'iterations', 'iter-2.md'), 'utf8')
    expect(iteration).toContain('type: "iteration"')
    expect(iteration).toContain('[[WorkMate/internal-homework/iterations/iter-1|iter-1]]')
    expect(iteration).toContain('status: "archived"')

    const changelog = await readFile(join(vault, 'WorkMate', 'internal-homework', 'changelog.md'), 'utf8')
    expect(changelog.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(1)

    await rm(repo, { recursive: true, force: true })
    await rm(vault, { recursive: true, force: true })
  })

  it('is idempotent: re-export rewrites notes and does not duplicate the changelog line', async () => {
    const repo = await seedRepo()
    const vault = await mkdtemp(join(tmpdir(), 'wm-vault2-'))
    const input = {
      projectRoot: repo,
      project: 'internal-homework',
      vaultPath: vault,
      now: (): Date => new Date('2026-10-07T01:00:00.000Z'),
    }

    const first = await exportWikiToVault(input)
    const second = await exportWikiToVault(input)

    expect(second.written.sort()).toEqual(first.written.sort())
    const changelog = await readFile(join(vault, 'WorkMate', 'internal-homework', 'changelog.md'), 'utf8')
    expect(changelog.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(1)

    await rm(repo, { recursive: true, force: true })
    await rm(vault, { recursive: true, force: true })
  })

  it('tolerates a project without a GitNexus wiki or proposals', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'wm-vault-empty-'))
    const vault = await mkdtemp(join(tmpdir(), 'wm-vault3-'))

    const result = await exportWikiToVault({ projectRoot: repo, project: 'bare', vaultPath: vault })

    expect(result).toMatchObject({ modules: 0, pages: 0, iterations: 0 })
    const index = await readFile(join(vault, 'WorkMate', 'bare', 'index.md'), 'utf8')
    expect(index).toContain('| （无） | — |')

    await rm(repo, { recursive: true, force: true })
    await rm(vault, { recursive: true, force: true })
  })

  it('projects proposal dependencies into front-matter-ready fields', () => {
    const [iteration] = iterationsFromProposals([
      proposalOf({ relatesTo: ['a', 'b'], decisions: [{ id: 'x', decision: 'd', rationale: 'r', supersedes: 'old' }] as never }),
    ])

    expect(iteration?.dependsOn).toEqual(['a', 'b'])
    expect(iteration?.supersedes).toEqual(['old'])
    expect(iteration?.archived).toBe(true)
  })
})

describe('module heat and classify budget (vault-views-search follow-up)', () => {
  it('renders a module-heat section sourced from iteration touches', async () => {
    const repo = await seedRepo()
    const vault = await mkdtemp(join(tmpdir(), 'wm-vault-heat-'))

    await exportWikiToVault({
      projectRoot: repo,
      project: 'internal-homework',
      vaultPath: vault,
      iterations: [
        {
          id: 'iter-a',
          title: 'A',
          status: 'archived',
          archived: true,
          dependsOn: [],
          supersedes: [],
          commits: [],
          origin: 'archive',
          date: '2026-01-01',
          touches: ['HomeworkManagementService.java'],
        },
      ],
    })

    const index = await readFile(join(vault, 'WorkMate', 'internal-homework', 'index.md'), 'utf8')
    expect(index).toContain('## 模块热度')
    expect(index).toContain('| 触及迭代数 |')
    expect(index).toContain('iter-a')
    await rm(repo, { recursive: true, force: true })
    await rm(vault, { recursive: true, force: true })
  })

  it('respects classifyMax and only uses act-level answers', async () => {
    const repo = await seedRepo()
    const vault = await mkdtemp(join(tmpdir(), 'wm-vault-classify-'))
    const asked: string[] = []
    const iterations = ['a', 'b', 'c'].map((id) => ({
      id: `iter-${id}`,
      title: `迭代 ${id}`,
      status: 'archived',
      archived: true,
      dependsOn: [],
      supersedes: [],
      commits: [],
      origin: 'archive' as const,
      date: '2026-01-01',
      summary: '描述里没有任何路径',
    }))

    await exportWikiToVault({
      projectRoot: repo,
      project: 'internal-homework',
      vaultPath: vault,
      iterations,
      classifyMax: 2,
      classifyModule: async (text, modules) => {
        asked.push(text)
        return modules[0]?.slug
      },
    })

    expect(asked).toHaveLength(2)                       // budget honoured
    const note = await readFile(join(vault, 'WorkMate', 'internal-homework', 'iterations', 'iter-a.md'), 'utf8')
    expect(note).toContain('homework-management')       // classified module became an edge
    await rm(repo, { recursive: true, force: true })
    await rm(vault, { recursive: true, force: true })
  })
})

describe('classify diagnostics and vector fallback (classify-diagnostics)', () => {
  const iterations = (ids: string[]) =>
    ids.map((id) => ({
      id: `iter-${id}`,
      title: `迭代 ${id}`,
      status: 'archived',
      archived: true,
      dependsOn: [],
      supersedes: [],
      commits: [],
      origin: 'archive' as const,
      date: '2026-01-01',
      summary: '描述里没有任何路径',
    }))

  it('prefers the free vector match and reports what happened', async () => {
    const repo = await seedRepo()
    const vault = await mkdtemp(join(tmpdir(), 'wm-vault-diag-'))
    let llmCalls = 0

    const result = await exportWikiToVault({
      projectRoot: repo,
      project: 'internal-homework',
      vaultPath: vault,
      iterations: iterations(['a', 'b']),
      matchModuleByVector: async () => ({ slug: 'homework-management', score: 0.8 }),
      classifyModule: async () => {
        llmCalls += 1
        return undefined
      },
    })

    expect(result.classify).toMatchObject({ pathMatched: 0, vectorMatched: 2, llmAsked: 0, llm: 'ok' })
    expect(llmCalls).toBe(0)                       // free path wins, no tokens spent
    await rm(repo, { recursive: true, force: true })
    await rm(vault, { recursive: true, force: true })
  })

  it('reports missing judgement layer and unanswered iterations', async () => {
    const repo = await seedRepo()
    const vault = await mkdtemp(join(tmpdir(), 'wm-vault-diag2-'))

    const result = await exportWikiToVault({
      projectRoot: repo,
      project: 'internal-homework',
      vaultPath: vault,
      iterations: iterations(['a', 'b']),
    })

    expect(result.classify).toMatchObject({ vectorMatched: 0, llmAsked: 0, unanswered: 2, llm: 'missing' })
    await rm(repo, { recursive: true, force: true })
    await rm(vault, { recursive: true, force: true })
  })
})

describe('edge reasons (touch-reasons)', () => {
  it('labels path, token, vector and judgement-layer edges in the note', async () => {
    const repo = await seedRepo()
    const vault = await mkdtemp(join(tmpdir(), 'wm-reason-'))

    await exportWikiToVault({
      projectRoot: repo,
      project: 'internal-homework',
      vaultPath: vault,
      iterations: [
        {
          id: 'iter-reason',
          title: '理由标注',
          status: 'archived',
          archived: true,
          dependsOn: [],
          supersedes: [],
          commits: [],
          origin: 'archive',
          date: '2026-02-01',
          touches: ['homework-management', 'src/main/java/com/zujuan/HomeworkManagementService.java', 'api-controllers', '一些散文描述'],
          touchReasons: { 'api-controllers': 'llm' },
        },
      ],
    })

    const note = await readFile(join(vault, 'WorkMate', 'internal-homework', 'iterations', 'iter-reason.md'), 'utf8')
    expect(note).toContain('## 触及的模块（含匹配理由）')
    expect(note).toContain('（路径命中）')     // exact slug in the touch list
    expect(note).not.toContain('（token 命中）') // code paths are path evidence, even when matched by token
    expect(note).toContain('（判断层归类）')   // explicit reason from the judgement layer
    await rm(repo, { recursive: true, force: true })
    await rm(vault, { recursive: true, force: true })
  })
})
