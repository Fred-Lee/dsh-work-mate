import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { autoPlanTeamRun, inferTemplate } from './auto-plan.ts'
import { TeamRunner } from './runner.ts'
import { TeamRunStore } from './store.ts'

let home: string
let project: string
let store: TeamRunStore
let runner: TeamRunner

const dir = (): string => join(project, 'openspec', 'changes', 'p1')

const write = async (name: string, content: string): Promise<void> => {
  await mkdir(dir(), { recursive: true })
  await writeFile(join(dir(), name), content, 'utf8')
}

const tasks = (roles: string[]): string =>
  JSON.stringify({
    tasks: roles.map((role, index) => ({
      id: `t${index + 1}`,
      title: role,
      role,
      project: 'demo',
      writes: [],
      dependsOn: index === 0 ? [] : ['t1'],
      acceptance: 'ok',
    })),
  })

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wm-team-auto-'))
  project = await mkdtemp(join(tmpdir(), 'wm-team-auto-proj-'))
  store = new TeamRunStore({ homeRoot: home, subdir: 'workmate' })
  runner = new TeamRunner(store)
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
})

describe('autoPlanTeamRun', () => {
  it('infers a template from task roles', () => {
    expect(inferTemplate(['backend-dev'])).toBe('delivery')
    expect(inferTemplate(['solution-evaluator', 'backend-dev'])).toBe('bug-fix')
    expect(inferTemplate(['requirement-evaluator', 'backend-dev'])).toBe('requirement-full')
  })

  it('creates a planned run after G2 when artifacts are complete', async () => {
    await write('REQ.md', '## 目标\n## 边界与禁止项\n## 验收判据\n## 假设与开放问题\n')
    await write('PLAN.md', '## 方案\n## 目标矩阵\n## 依赖与波次\n## 风险与回滚\n')
    await write('TASKS.json', tasks(['backend-dev']))

    const result = await autoPlanTeamRun({
      proposalId: 'p1',
      changeId: 'p1',
      projectRoot: project,
      openspecRoot: 'openspec',
      store,
      runner,
    })
    expect(result.created).toBe(true)
    expect(result.run).toMatchObject({ proposalId: 'p1', status: 'planned', template: 'delivery' })
  })

  it('does not duplicate an active run and skips incomplete artifacts', async () => {
    await write('PLAN.md', '## 方案\n## 目标矩阵\n## 依赖与波次\n## 风险与回滚\n')
    await write('TASKS.json', tasks(['backend-dev']))
    const input = {
      proposalId: 'p1',
      changeId: 'p1',
      projectRoot: project,
      openspecRoot: 'openspec',
      store,
      runner,
    }
    const first = await autoPlanTeamRun(input)
    expect(first.created).toBe(true)
    const second = await autoPlanTeamRun(input)
    expect(second).toMatchObject({ created: false, skipped: 'already has an active run' })

    await rm(dir(), { recursive: true, force: true })
    await write('TASKS.json', tasks(['requirement-evaluator']))
    await expect(
      autoPlanTeamRun({ ...input, proposalId: 'p2' }),
    ).resolves.toMatchObject({ created: false, skipped: expect.stringContaining('incomplete') })
  })
})
