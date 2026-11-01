import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProposalServiceImpl } from '../proposal/service.ts'
import { ProposalStore } from '../proposal/store.ts'
import { ProjectRegistry } from '../project/registry.ts'
import type { TaskRecord } from './files.ts'
import { branchOf, expectedWorktreePath, isWorkmateBranch, writeBackTarget, writeBackTargets } from './project-targets.ts'
import type { TicketView } from '../superagent/project.ts'

const exec = promisify(execFile)
let dir: string
let proposals: ProposalServiceImpl
let registry: ProjectRegistry

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wm-writeback-'))
  proposals = new ProposalServiceImpl(new ProposalStore({ homeRoot: dir, subdir: 'workmate' }))
  registry = new ProjectRegistry({ homeRoot: dir, subdir: 'workmate' })
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const task = (overrides: Partial<TaskRecord> = {}): TaskRecord => ({
  id: 'task-1',
  title: 'T',
  intent: 'i',
  repo: 'repo-a',
  baseBranch: 'main',
  acceptance: '',
  priority: 'P1',
  mode: 'superagent',
  dependsOn: [],
  assigned: true,
  abandoned: false,
  attempt: 1,
  createdBy: 'u',
  createdAt: 't',
  updatedAt: 't',
  proposalId: 'p1',
  ...overrides,
})

const ticket = (overrides: Partial<TicketView> = {}): TicketView => ({
  id: 'tkt-1',
  title: 'T',
  directory: '/repo/.workmates/workmate-abcdef123456',
  ...overrides,
})

describe('命名约定', () => {
  it('分支名取目录末段，与 prepare 一致', () => {
    expect(branchOf('/repo/.workmates/workmate-abcdef123456')).toBe('workmate/workmate-abcdef123456')
    expect(branchOf('/repo/.workmates/x', 'feature/')).toBe('feature/x')
    expect(isWorkmateBranch('workmate/x')).toBe(true)
    expect(isWorkmateBranch('feature/x')).toBe(false)
  })

  it('回收路径与目录约定一致', () => {
    expect(expectedWorktreePath('/repo', '/anywhere/workmate-x')).toBe('/repo/.workmates/workmate-x')
  })
})

describe('writeBackTarget', () => {
  it('写入 featureBranch 与 baseCommit', async () => {
    await proposals.upsert({
      id: 'p1',
      title: 'P',
      targets: [{ project: 'repo-a', baseBranch: 'main' }],
    })
    const root = join(dir, 'repo-a')
    await mkdir(root, { recursive: true })
    await exec('git', ['init', '-b', 'main'], { cwd: root })
    await exec('git', ['config', 'user.email', 't@t'], { cwd: root })
    await exec('git', ['config', 'user.name', 't'], { cwd: root })
    await writeFile(join(root, 'a.txt'), 'x', 'utf8')
    await exec('git', ['add', '-A'], { cwd: root })
    await exec('git', ['commit', '-m', 'init'], { cwd: root })
    await registry.upsert('repo-a', root, { defaultBranch: 'main' })

    const outcome = await writeBackTarget({ proposals, registry }, task(), ticket())
    expect(outcome).toBe('updated')
    const updated = await proposals.get('p1')
    const target = updated?.targets?.[0]
    expect(target?.featureBranch).toBe('workmate/workmate-abcdef123456')
    expect(target?.baseCommit).toMatch(/^[a-f0-9]{40}$/)
  })

  it('同值幂等，不同值报冲突且不覆盖', async () => {
    await proposals.upsert({
      id: 'p1',
      title: 'P',
      targets: [{ project: 'repo-a', baseBranch: 'main', featureBranch: 'workmate/other' }],
    })
    expect(await writeBackTarget({ proposals, registry }, task(), ticket())).toBe('conflict')
    expect((await proposals.get('p1'))?.targets?.[0]?.featureBranch).toBe('workmate/other')

    await proposals.patchFields('p1', {
      targets: [{ project: 'repo-a', baseBranch: 'main', featureBranch: 'workmate/workmate-abcdef123456' }],
    })
    expect(await writeBackTarget({ proposals, registry }, task(), ticket())).toBe('skipped')
  })

  it('没有目录或没有提案时跳过', async () => {
    expect(await writeBackTarget({ proposals, registry }, task(), ticket({ directory: undefined }))).toBe('skipped')
    expect(await writeBackTarget({ proposals, registry }, task({ proposalId: undefined }), ticket())).toBe('skipped')
    expect(await writeBackTarget({ proposals, registry }, task({ proposalId: 'missing' }), ticket())).toBe('missing')
  })

  it('target 不存在时 missing', async () => {
    await proposals.upsert({ id: 'p1', title: 'P', targets: [{ project: 'repo-b', baseBranch: 'main' }] })
    expect(await writeBackTarget({ proposals, registry }, task(), ticket())).toBe('missing')
  })

  it('多 target 时只写 targets，不动旧标量', async () => {
    await proposals.upsert({
      id: 'p1',
      title: 'P',
      targets: [
        { project: 'repo-a', baseBranch: 'main' },
        { project: 'repo-b', baseBranch: 'test' },
      ],
      worktreePath: '/old/path',
      featureBranch: 'feature/p1',
    })
    await writeBackTarget({ proposals, registry }, task(), ticket())
    const updated = await proposals.get('p1')
    expect(updated?.targets?.[0]?.featureBranch).toBe('workmate/workmate-abcdef123456')
    expect(updated?.targets?.[1]?.featureBranch).toBeUndefined()
    // 多 target 提案的标量投影由 store 统一留空（既有语义），回写不得把它填回来。
    expect(updated?.featureBranch ?? undefined).toBeUndefined()
  })
})

describe('writeBackTargets', () => {
  it('汇总 updated/conflicts/missing', async () => {
    await proposals.upsert({ id: 'p1', title: 'P', targets: [{ project: 'repo-a', baseBranch: 'main' }] })
    const result = await writeBackTargets({ proposals, registry }, [
      { task: task(), ticket: ticket() },
      { task: task({ id: 'task-2', repo: 'repo-b' }), ticket: ticket({ directory: '/x/y' }) },
    ])
    expect(result.updated).toEqual(['p1/repo-a'])
    expect(result.missing).toEqual(['p1/repo-b'])
    expect(result.conflicts).toEqual([])
  })
})
