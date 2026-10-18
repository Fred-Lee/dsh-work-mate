import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildTeamSummary, parseTeamSummary, writeTeamSummary } from './summary.ts'
import { DEFAULT_TEAM_BUDGET, type TeamRun } from './types.ts'

const run = (): TeamRun => ({
  id: 'r1',
  proposalId: 'p1',
  template: 'bug-fix',
  status: 'partial',
  tasks: [
    { id: 't1', title: 'a', role: 'backend-dev', project: 'repo', writes: [], dependsOn: [], acceptance: 'ok', status: 'done', attempts: 1 },
    { id: 't2', title: 'b', role: 'frontend-dev', project: 'repo', writes: [], dependsOn: ['t1'], acceptance: 'ok', status: 'failed', attempts: 2 },
  ],
  dispatches: [
    { id: 'd1', taskId: 't1', role: 'backend-dev', status: 'done', reportPath: 'TEST.md', outcome: 'ok' },
    { id: 'd2', taskId: 't2', role: 'frontend-dev', status: 'failed', outcome: 'build failed' },
  ],
  budget: DEFAULT_TEAM_BUDGET,
  createdAt: '2026-10-19T00:00:00.000Z',
  updatedAt: '2026-10-19T00:00:00.000Z',
})

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wm-team-summary-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('team summary', () => {
  it('renders the required sections, evidence and unresolved blockers', () => {
    const text = buildTeamSummary(run())
    expect(text).toContain('## Run')
    expect(text).toContain('## 逐任务结果')
    expect(text).toContain('| t1 | backend-dev | done | 1 | TEST.md；ok |')
    expect(text).toContain('## 未解阻塞')
    expect(text).toContain('t2（failed）：build failed')
    expect(text).toContain('## 终态')
    expect(text).toContain('- partial')
  })

  it('writes SUMMARY.md under the change directory', async () => {
    const path = await writeTeamSummary({ projectRoot: root, openspecRoot: 'openspec', changeId: 'p1', run: run() })
    expect(path).toBe(join(root, 'openspec', 'changes', 'p1', 'SUMMARY.md'))
    await expect(readFile(path, 'utf8')).resolves.toContain('# SUMMARY — p1')
  })
  it('parses terminal status and done/total for the manifest', () => {
    expect(parseTeamSummary(buildTeamSummary(run()))).toMatchObject({
      status: 'partial',
      tasksDone: 1,
      tasksTotal: 2,
    })
    expect(parseTeamSummary('no summary here')).toEqual({ tasksDone: 0, tasksTotal: 0 })
  })

})
