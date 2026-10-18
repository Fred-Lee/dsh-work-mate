import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LifecycleServiceImpl } from './service.ts'
import { ProposalServiceImpl } from '../proposal/service.ts'
import { ProposalStore } from '../proposal/store.ts'
import { WorktreeManager } from '../worktree/manager.ts'

let home: string
let project: string
let proposals: ProposalServiceImpl

const lifecycle = (teamEvidenceGate: 'off' | 'warn' | 'block'): LifecycleServiceImpl =>
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
})
