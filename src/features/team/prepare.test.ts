import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prepareTeamArtifacts } from './prepare.ts'
import { parseTeamTasks } from './tasks.ts'

let root: string
const dir = (): string => join(root, 'openspec', 'changes', 'p1')

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wm-prepare-'))
  await mkdir(dir(), { recursive: true })
  await writeFile(join(dir(), 'proposal.md'), '# p\n\n## Why\n因为订单流程太长。\n', 'utf8')
  await writeFile(join(dir(), 'design.md'), '# d\n\n## 方案\n拆成两个任务。\n', 'utf8')
  await writeFile(
    join(dir(), 'tasks.md'),
    '- [ ] 实现订单 <!-- role: backend-dev project: demo writes: src/order/** accepts: 单测通过 -->\n- [ ] 测试订单 <!-- role: integration-tester project: demo writes: tests/** accepts: E2E 通过 -->\n',
    'utf8',
  )
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('prepareTeamArtifacts', () => {
  it('derives REQ/PLAN/TASKS from OpenSpec sources without overwriting', async () => {
    const first = await prepareTeamArtifacts({
      projectRoot: root,
      openspecRoot: 'openspec',
      changeId: 'p1',
      primaryProject: 'demo',
      targets: [
        { project: 'demo', baseBranch: 'main' },
        { project: 'other', baseBranch: 'master' },
      ],
    })
    expect(first.written).toEqual(['REQ.md', 'PLAN.md', 'TASKS.json'])
    expect(await readFile(join(dir(), 'REQ.md'), 'utf8')).toContain('因为订单流程太长')
    const plan = await readFile(join(dir(), 'PLAN.md'), 'utf8')
    expect(plan).toContain('other @ master')
    const tasks = parseTeamTasks(await readFile(join(dir(), 'TASKS.json'), 'utf8'))
    expect(tasks.map((task) => task.role)).toEqual(['backend-dev', 'integration-tester'])

    const second = await prepareTeamArtifacts({
      projectRoot: root,
      openspecRoot: 'openspec',
      changeId: 'p1',
      primaryProject: 'demo',
    })
    expect(second.written).toEqual([])
    expect(second.skipped).toEqual(['REQ.md', 'PLAN.md', 'TASKS.json'])
  })

  it('warns when role/project annotations are missing', async () => {
    await writeFile(join(dir(), 'tasks.md'), '- [ ] 无注解任务\n', 'utf8')
    const result = await prepareTeamArtifacts({
      projectRoot: root,
      openspecRoot: 'openspec',
      changeId: 'p1',
      primaryProject: 'demo',
    })
    expect(result.warnings.join()).toContain('未声明 role')
    const tasks = parseTeamTasks(await readFile(join(dir(), 'TASKS.json'), 'utf8'))
    expect(tasks[0]).toMatchObject({ project: 'demo', role: 'backend-dev' })
  })
})
