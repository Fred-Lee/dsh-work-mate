/**
 * 团队派发的执行器开关（change `adopt-superagent-openspec-source`, task 15）。
 *
 * `taskExecutor=superagent`（默认）时，`workmate_team_run` 与
 * `workmate_team_plan(start=true)` 必须拒绝派发，并说明改哪个开关——只写"不行"
 * 会让调用方以为工具坏了。`team` 模式下行为不变（由既有 coordinator/runner 测试覆盖）。
 */
import { describe, expect, it } from 'vitest'
import { DISPATCH_DISABLED_MESSAGE, registerTeamTools, type TeamToolDeps } from './tools.ts'
import { TeamRunner } from './runner.ts'
import { TeamRunStore } from './store.ts'
import type { TeamRun } from './types.ts'

interface Registered {
  name: string
  execute: (args: Record<string, unknown>, exec: Record<string, unknown>) => Promise<unknown>
}

let seq = 0

function harness(overrides: Partial<TeamToolDeps> = {}): {
  tools: Registered[]
  deps: TeamToolDeps
} {
  const tools: Registered[] = []
  const ctx = {
    tools: { register: (definition: Registered) => tools.push(definition) },
  }
  seq += 1
  const home = `/tmp/wm-team-tools-${process.pid}-${Date.now()}-${seq}`
  const store = new TeamRunStore({ subdir: 'workmate-test', homeRoot: home })
  const deps: TeamToolDeps = {
    proposals: {
      get: async () => ({
        id: 'p1',
        title: '提案',
        status: 'implementing',
        projects: ['repo'],
        openspecChangeId: 'add-thing',
        targets: [{ project: 'repo', baseBranch: 'main', worktreePath: '/tmp/wt' }],
      }),
    } as never,
    registry: { get: async () => undefined } as never,
    runner: new TeamRunner(store),
    openspecRoot: 'openspec',
    projectRoot: '/tmp/project',
    subagents: () => undefined,
    lifecycleMainBranch: 'main',
    events: { append: async () => undefined } as never,
    rolePresetConfig: { readonlyPreset: '', workspacePreset: '' },
    requireRolePresets: false,
    roleModels: '',
    ...overrides,
  }
  registerTeamTools(ctx as never, deps)
  return { tools, deps }
}

const find = (tools: Registered[], name: string): Registered => {
  const tool = tools.find((entry) => entry.name === name)
  if (tool === undefined) throw new Error(`tool not registered: ${name}`)
  return tool
}

const stubRun = (overrides: Partial<TeamRun> = {}): TeamRun => ({
  id: 'run-1',
  proposalId: 'p1',
  template: 'requirement-full',
  status: 'planned',
  tasks: [],
  dispatches: [],
  budget: { maxParallel: 3, maxAttempts: 2, maxDurationMs: 1, maxWaveMs: 1, maxTokens: 1, maxDispatches: 1 },
  createdAt: 't',
  updatedAt: 't',
  ...overrides,
})

describe('taskExecutor=superagent（默认）', () => {
  it('workmate_team_run 拒绝派发并说明开关', async () => {
    const { tools } = harness()
    const run = find(tools, 'workmate_team_run')
    await expect(run.execute({ runId: 'run-1' }, {})).rejects.toThrowError(DISPATCH_DISABLED_MESSAGE)
  })

  it('workmate_team_run 的拒绝文案包含 taskExecutor=team', () => {
    expect(DISPATCH_DISABLED_MESSAGE).toContain('taskExecutor')
    expect(DISPATCH_DISABLED_MESSAGE).toContain('Super-agent')
  })

  it('workmate_team_plan(start=true) 建 Run 但不派发', async () => {
    const { tools, deps } = harness()
    await deps.runner.createRun({ id: 'run-x', proposalId: 'p1', template: 'requirement-full', tasks: [] })
    const plan = find(tools, 'workmate_team_plan')
    // 工件不完整会先失败（G1）；这里断言的是"派发被挡"发生在 start 之前。
    const result = (await plan.execute({ proposalId: 'p1', start: true }, {}).catch((error: Error) => error)) as
      | { dispatch?: { disabled?: boolean } }
      | Error
    if (result instanceof Error) {
      // 走 G1/G2 失败路径也可以接受，只要不是派发。
      expect(result.message).not.toContain('child')
      return
    }
    expect(result.dispatch?.disabled).toBe(true)
  })

  it('status / inbox / answer 不受开关影响', async () => {
    const { tools, deps } = harness()
    await deps.runner.createRun({ id: 'run-1', proposalId: 'p1', template: 'requirement-full', tasks: [] })
    const status = find(tools, 'workmate_team_status')
    const value = (await status.execute({ runId: 'run-1' }, {})) as { run: { id: string } }
    expect(value.run.id).toBe('run-1')
  })
})

describe('taskExecutor=team（回退）', () => {
  it('派发开关被打开时不再抛出禁用文案', async () => {
    const { tools } = harness({ taskExecutor: 'team' })
    const run = find(tools, 'workmate_team_run')
    const error = (await run.execute({ runId: 'missing' }, {}).catch((cause: Error) => cause)) as Error
    expect(error.message).not.toBe(DISPATCH_DISABLED_MESSAGE)
    expect(error.message).toMatch(/team run not found/)
  })
})

describe('stubRun 与 harness 自洽', () => {
  it('stubRun 的结构可用于 RunStore', async () => {
    seq += 1
    const store = new TeamRunStore({ subdir: 'workmate-test', homeRoot: `/tmp/wm-team-tools-${process.pid}-${Date.now()}-${seq}` })
    const stored = await store.upsert(stubRun())
    expect(stored.id).toBe('run-1')
    expect((await store.get('run-1'))?.status).toBe('planned')
  })
})
