import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkTeamCompleteness, requiredArtifacts } from './completeness.ts'

let root: string
const dir = (): string => join(root, 'openspec', 'changes', 'p1')

const write = async (name: string, content: string): Promise<void> => {
  await mkdir(dir(), { recursive: true })
  await writeFile(join(dir(), name), content, 'utf8')
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wm-team-complete-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('team completeness', () => {
  it('requires REQ/PLAN/TASKS for the full template and PLAN/TASKS for bug-fix', () => {
    expect(requiredArtifacts('requirement-full')).toEqual(['REQ.md', 'PLAN.md', 'TASKS.json'])
    expect(requiredArtifacts('bug-fix')).toEqual(['PLAN.md', 'TASKS.json'])
    expect(requiredArtifacts('research')).toEqual(['REQ.md', 'TASKS.json'])
  })

  it('reports missing files and missing sections', async () => {
    await write('TASKS.json', '{"tasks":[]}')
    const result = await checkTeamCompleteness(root, 'openspec', 'p1', 'requirement-full')
    expect(result.ok).toBe(false)
    expect(result.errors.join()).toContain('REQ.md 缺失')
    expect(result.errors.join()).toContain('PLAN.md 缺失')
  })

  it('passes a complete authoring set', async () => {
    await write('TASKS.json', '{"tasks":[]}')
    await write('REQ.md', '## 目标\n## 边界与禁止项\n## 验收判据\n## 假设与开放问题\n')
    await write('PLAN.md', '## 方案\n## 目标矩阵\n## 依赖与波次\n## 风险与回滚\n')
    await expect(checkTeamCompleteness(root, 'openspec', 'p1', 'requirement-full')).resolves.toMatchObject({
      ok: true,
      errors: [],
    })
  })
})
