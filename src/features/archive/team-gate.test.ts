import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LifecycleServiceImpl } from './service.ts'
import { ProposalServiceImpl } from '../proposal/service.ts'
import { ProposalStore } from '../proposal/store.ts'
import { WorktreeManager } from '../worktree/manager.ts'
import { DEFAULT_TEAM_BUDGET, type TeamRun } from '../team/types.ts'

let home: string
let project: string
let proposals: ProposalServiceImpl

const lifecycle = (teamEvidenceGate: 'off' | 'warn' | 'block', teamRuns?: TeamRun[]): LifecycleServiceImpl =>
  new LifecycleServiceImpl({
    proposals,
    worktree: new WorktreeManager({
      homeRoot: home,
      subdir: 'workmate',
      basePort: 3000,
      portStep: 10,
      copyFiles: [],
      packageManager: 'pnpm',
    }),
    openspecRoot: 'openspec',
    mainBranch: 'main',
    approvalsRequired: [],
    resolveProjectRoots: async () => [{ project: 'demo', root: project }],
    teamEvidenceGate,
    ...(teamRuns !== undefined ? { teamRuns: { list: async () => teamRuns } as never } : {}),
    orchestrate: async () => ({ ok: true, steps: [] }),
  })

const changeDir = (): string => join(project, 'openspec', 'changes', 'p1')

const writeTasks = async (): Promise<void> => {
  await mkdir(changeDir(), { recursive: true })
  await writeFile(
    join(changeDir(), 'TASKS.json'),
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

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wm-team-gate-'))
  project = await mkdtemp(join(tmpdir(), 'wm-team-gate-proj-'))
  proposals = new ProposalServiceImpl(new ProposalStore({ homeRoot: home, subdir: 'workmate' }))
  await proposals.upsert({ id: 'p1', title: 'p1', projects: ['demo'] })
  await proposals.setStatus('p1', 'merging')
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
})

describe('team evidence gate', () => {
  it('blocks archiving a team-managed change without TEST/REVIEW', async () => {
    await writeTasks()
    await expect(lifecycle('block').transition('p1', 'archiving')).rejects.toThrow(/团队证据不完整/)
    expect((await proposals.get('p1'))?.status).toBe('merging')
  })

  it('does not block when the gate is off', async () => {
    await writeTasks()
    await lifecycle('off').transition('p1', 'archiving')
    expect((await proposals.get('p1'))?.status).toBe('archiving')
  })

  it('allows a complete evidence set', async () => {
    await writeTasks()
    await writeFile(join(changeDir(), 'TEST.md'), '## 场景\n## 执行命令\n## 结果与证据\n## 覆盖缺口\n', 'utf8')
    await writeFile(
      join(changeDir(), 'TEAM-REVIEW.md'),
      '<!-- reviewer: independent -->\n## 确认项\n## 疑问项\n## 建议补充项\n## CRITICAL 问题\n',
      'utf8',
    )
    await writeFile(join(changeDir(), 'SUMMARY.md'), '## Run\n## 逐任务结果\n## 未解阻塞\n## 终态\n', 'utf8')
    await lifecycle('block').transition('p1', 'archiving')
    expect((await proposals.get('p1'))?.status).toBe('archiving')
  })
  it('rejects a TEAM-REVIEW reviewer marker that matches an implementer session', async () => {
    await writeTasks()
    await writeFile(join(changeDir(), 'TEST.md'), '## 场景\n## 执行命令\n## 结果与证据\n## 覆盖缺口\n', 'utf8')
    await writeFile(
      join(changeDir(), 'TEAM-REVIEW.md'),
      '<!-- reviewer: d1 -->\n## 确认项\n## 疑问项\n## 建议补充项\n## CRITICAL 问题\n',
      'utf8',
    )
    await writeFile(join(changeDir(), 'SUMMARY.md'), '## Run\n## 逐任务结果\n## 未解阻塞\n## 终态\n', 'utf8')
    const run = {
      id: 'r1',
      proposalId: 'p1',
      template: 'bug-fix',
      status: 'succeeded',
      tasks: [],
      dispatches: [
        { id: 'd1', taskId: 'impl', role: 'backend-dev', sessionId: 'session-impl', status: 'done' },
        { id: 'd2', taskId: 'review', role: 'reviewer', sessionId: 'session-review', status: 'done' },
      ],
      budget: DEFAULT_TEAM_BUDGET,
      createdAt: '2026-10-19T00:00:00.000Z',
      updatedAt: '2026-10-19T00:00:00.000Z',
    } as TeamRun
    await expect(lifecycle('block', [run]).transition('p1', 'archiving')).rejects.toThrow(/与实现者 Dispatch 相同/)
  })

  it('blocks archiving when the latest team run is partial', async () => {
    await writeTasks()
    await writeFile(join(changeDir(), 'TEST.md'), '## 场景\n## 执行命令\n## 结果与证据\n## 覆盖缺口\n', 'utf8')
    await writeFile(
      join(changeDir(), 'TEAM-REVIEW.md'),
      '<!-- reviewer: d2 -->\n## 确认项\n## 疑问项\n## 建议补充项\n## CRITICAL 问题\n',
      'utf8',
    )
    await writeFile(join(changeDir(), 'SUMMARY.md'), '## Run\n## 逐任务结果\n## 未解阻塞\n## 终态\n', 'utf8')
    const run = {
      id: 'r1',
      proposalId: 'p1',
      template: 'bug-fix',
      status: 'partial',
      tasks: [],
      dispatches: [
        { id: 'd2', taskId: 'review', role: 'reviewer', sessionId: 'session-review', status: 'done' },
      ],
      budget: DEFAULT_TEAM_BUDGET,
      createdAt: '2026-10-19T00:00:00.000Z',
      updatedAt: '2026-10-19T00:00:00.000Z',
    } as TeamRun
    await expect(lifecycle('block', [run]).transition('p1', 'archiving')).rejects.toThrow(/终态为 partial/)
  })

  it('does not let a missing TASKS.json disable the team evidence gate when a run exists', async () => {
    const run = {
      id: 'r1',
      proposalId: 'p1',
      template: 'bug-fix',
      status: 'succeeded',
      tasks: [],
      dispatches: [],
      budget: DEFAULT_TEAM_BUDGET,
      createdAt: '2026-10-19T00:00:00.000Z',
      updatedAt: '2026-10-19T00:00:00.000Z',
    } as TeamRun
    await expect(lifecycle('block', [run]).transition('p1', 'archiving')).rejects.toThrow(/TASKS\.json 缺失/)
  })

  it('blocks a running run even when all evidence files exist', async () => {
    await writeTasks()
    await writeFile(join(changeDir(), 'TEST.md'), '## 场景\n## 执行命令\n## 结果与证据\n## 覆盖缺口\n', 'utf8')
    await writeFile(
      join(changeDir(), 'TEAM-REVIEW.md'),
      '<!-- reviewer: d2 -->\n## 确认项\n## 疑问项\n## 建议补充项\n## CRITICAL 问题\n',
      'utf8',
    )
    await writeFile(join(changeDir(), 'SUMMARY.md'), '## Run\n## 逐任务结果\n## 未解阻塞\n## 终态\n', 'utf8')
    const run = {
      id: 'r1',
      proposalId: 'p1',
      template: 'bug-fix',
      status: 'running',
      tasks: [],
      dispatches: [
        { id: 'd2', taskId: 'review', role: 'reviewer', sessionId: 'session-review', status: 'done' },
      ],
      budget: DEFAULT_TEAM_BUDGET,
      createdAt: '2026-10-19T00:00:00.000Z',
      updatedAt: '2026-10-19T00:00:00.000Z',
    } as TeamRun
    await expect(lifecycle('block', [run]).transition('p1', 'archiving')).rejects.toThrow(/终态为 running/)
  })

  it('re-checks team evidence when runArchive starts from archiving', async () => {
    await writeTasks()
    await writeFile(join(changeDir(), 'TEST.md'), '## 场景\n## 执行命令\n## 结果与证据\n## 覆盖缺口\n', 'utf8')
    await writeFile(
      join(changeDir(), 'TEAM-REVIEW.md'),
      '<!-- reviewer: d2 -->\n## 确认项\n## 疑问项\n## 建议补充项\n## CRITICAL 问题\n',
      'utf8',
    )
    await writeFile(join(changeDir(), 'SUMMARY.md'), '## Run\n## 逐任务结果\n## 未解阻塞\n## 终态\n', 'utf8')
    const run = {
      id: 'r1',
      proposalId: 'p1',
      template: 'bug-fix',
      status: 'running',
      tasks: [],
      dispatches: [
        { id: 'd2', taskId: 'review', role: 'reviewer', sessionId: 'session-review', status: 'done' },
      ],
      budget: DEFAULT_TEAM_BUDGET,
      createdAt: '2026-10-19T00:00:00.000Z',
      updatedAt: '2026-10-19T00:00:00.000Z',
    } as TeamRun
    await proposals.setStatus('p1', 'archiving')
    await expect(lifecycle('block', [run]).runArchive('p1')).rejects.toThrow(/终态为 running/)
  })

  it('re-checks missing TASKS.json when runArchive starts from archiving', async () => {
    const run = {
      id: 'r1',
      proposalId: 'p1',
      template: 'bug-fix',
      status: 'succeeded',
      tasks: [],
      dispatches: [],
      budget: DEFAULT_TEAM_BUDGET,
      createdAt: '2026-10-19T00:00:00.000Z',
      updatedAt: '2026-10-19T00:00:00.000Z',
    } as TeamRun
    await proposals.setStatus('p1', 'archiving')
    await expect(lifecycle('block', [run]).runArchive('p1')).rejects.toThrow(/TASKS\.json 缺失/)
  })

})
