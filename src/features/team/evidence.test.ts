import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkTeamEvidence } from './evidence.ts'

let root: string

const dir = (id: string): string => join(root, 'openspec', 'changes', id)

const writeTasks = async (id: string): Promise<void> => {
  await mkdir(dir(id), { recursive: true })
  await writeFile(
    join(dir(id), 'TASKS.json'),
    JSON.stringify({
      tasks: [
        {
          id: 't1',
          title: 't1',
          role: 'backend-dev',
          project: 'demo',
          writes: ['src/**'],
          dependsOn: [],
          acceptance: 'ok',
        },
      ],
    }),
    'utf8',
  )
}

const writeArtifact = async (id: string, name: string, sections: string[]): Promise<void> => {
  await writeFile(join(dir(id), name), `# ${name}\n${sections.join('\n')}\n`, 'utf8')
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wm-team-evidence-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('checkTeamEvidence', () => {
  it('skips changes that never opted into a team run', async () => {
    await expect(checkTeamEvidence(root, 'openspec', 'legacy')).resolves.toEqual({
      managed: false,
      ok: true,
      errors: [],
    })
  })

  it('reports missing TEST.md and TEAM-REVIEW.md', async () => {
    await writeTasks('p1')
    const result = await checkTeamEvidence(root, 'openspec', 'p1')
    expect(result.managed).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.errors.join()).toContain('TEST.md 缺失')
    expect(result.errors.join()).toContain('TEAM-REVIEW.md 缺失')
  })

  it('accepts complete artifacts and rejects missing sections', async () => {
    await writeTasks('p1')
    await writeArtifact('p1', 'TEST.md', ['## 场景', '## 执行命令', '## 结果与证据', '## 覆盖缺口'])
    await writeArtifact('p1', 'TEAM-REVIEW.md', ['## 确认项', '## 疑问项', '## 建议补充项'])
    const missing = await checkTeamEvidence(root, 'openspec', 'p1')
    expect(missing.ok).toBe(false)
    expect(missing.errors.join()).toContain('TEAM-REVIEW.md 缺「## CRITICAL 问题」')

    await writeArtifact('p1', 'TEAM-REVIEW.md', ['<!-- reviewer: independent -->', '## 确认项', '## 疑问项', '## 建议补充项', '## CRITICAL 问题'])
    await writeArtifact('p1', 'SUMMARY.md', ['## Run', '## 逐任务结果', '## 未解阻塞', '## 终态'])
    await expect(checkTeamEvidence(root, 'openspec', 'p1')).resolves.toMatchObject({ managed: true, ok: true })
  })

  it('flags an invalid TASKS.json', async () => {
    await mkdir(dir('p1'), { recursive: true })
    await writeFile(join(dir('p1'), 'TASKS.json'), '{oops', 'utf8')
    const result = await checkTeamEvidence(root, 'openspec', 'p1')
    expect(result.errors.join()).toContain('不是合法 JSON')
  })
})
