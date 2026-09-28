import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateChangeDir, readChangeState, validateProjectRoot } from './openspec.ts'

let projectRoot: string

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'workmate-openspec-'))
})

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true })
})

describe('validateProjectRoot', () => {
  it('rejects relative paths and upward traversal', () => {
    expect(() => validateProjectRoot('relative/path')).toThrow('absolute')
    expect(() => validateProjectRoot('/a/../b')).toThrow('traverse')
    expect(validateProjectRoot('/abs/project')).toBe('/abs/project')
  })
})

describe('generateChangeDir', () => {
  it('creates the three template files', async () => {
    const result = await generateChangeDir(projectRoot, 'openspec', 'batch-grading-v2', '批量批改 v2.1')

    expect(result.status).toBe('created')
    const proposal = await readFile(join(result.dir ?? '', 'proposal.md'), 'utf8')
    expect(proposal).toContain('# 批量批改 v2.1')
    await expect(readFile(join(result.dir ?? '', 'design.md'), 'utf8')).resolves.toContain('Design')
    await expect(readFile(join(result.dir ?? '', 'tasks.md'), 'utf8')).resolves.toContain('- [ ] 1.')
  })

  it('never overwrites an existing change directory', async () => {
    const changesDir = join(projectRoot, 'openspec', 'changes', 'p1')
    await (await import('node:fs/promises')).mkdir(changesDir, { recursive: true })
    await writeFile(join(changesDir, 'proposal.md'), '# 人工撰写的内容', 'utf8')

    const result = await generateChangeDir(projectRoot, 'openspec', 'p1', '标题')

    expect(result.status).toBe('existing')
    await expect(readFile(join(changesDir, 'proposal.md'), 'utf8')).resolves.toBe('# 人工撰写的内容')
    await expect(stat(join(changesDir, 'design.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('readChangeState', () => {
  it('reports missing / active / archived states with tasks progress', async () => {
    expect(await readChangeState(projectRoot, 'openspec', 'p1')).toEqual({ state: 'missing' })

    await generateChangeDir(projectRoot, 'openspec', 'p1', '标题')
    const active = await readChangeState(projectRoot, 'openspec', 'p1')
    expect(active.state).toBe('active')
    expect(active.tasks).toEqual({ done: 0, total: 3 })

    const tasksPath = join(projectRoot, 'openspec', 'changes', 'p1', 'tasks.md')
    await writeFile(tasksPath, '- [x] 1. 骨架\n- [x] 2. 实现\n- [ ] 3. 验证\n', 'utf8')
    expect((await readChangeState(projectRoot, 'openspec', 'p1')).tasks).toEqual({ done: 2, total: 3 })

    await (await import('node:fs/promises')).rename(
      join(projectRoot, 'openspec', 'changes', 'p1'),
      join(projectRoot, 'openspec', 'changes', 'archive-tmp'),
    )
    await (await import('node:fs/promises')).mkdir(join(projectRoot, 'openspec', 'changes', 'archive'), { recursive: true })
    await (await import('node:fs/promises')).rename(
      join(projectRoot, 'openspec', 'changes', 'archive-tmp'),
      join(projectRoot, 'openspec', 'changes', 'archive', '2026-09-28-p1'),
    )
    expect((await readChangeState(projectRoot, 'openspec', 'p1')).state).toBe('archived')
  })
})
