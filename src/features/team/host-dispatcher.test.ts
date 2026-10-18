import { describe, expect, it } from 'vitest'
import { buildTaskPrompt, HostSubagentDispatcher, type SubagentStartSpecLike, type SubagentServiceLike } from './host-dispatcher.ts'
import type { DispatchRequest } from './coordinator.ts'
import type { TeamRun, TeamTaskRecord } from './types.ts'

const task: TeamTaskRecord = {
  id: 't1',
  title: '实现订单详情',
  role: 'backend-dev',
  project: 'repo',
  writes: ['src/main/order/**'],
  dependsOn: [],
  acceptance: '接口返回 200 且单测通过',
  status: 'dispatched',
  attempts: 1,
}

const run = {} as TeamRun
const request: DispatchRequest = { run, task, dispatchId: 'd1' }

class FakeSubagents implements SubagentServiceLike {
  readonly specs: SubagentStartSpecLike[] = []
  disposed = 0
  constructor(private readonly result: { stopReason?: string; diagnostic?: string; output?: unknown[] }) {}
  async startActivation(spec: SubagentStartSpecLike) {
    this.specs.push(spec)
    return {
      childId: 'child-1',
      result: Promise.resolve(this.result),
      dispose: async () => {
        this.disposed += 1
      },
    }
  }
}

describe('HostSubagentDispatcher', () => {
  it('runs one child in the target worktree and maps completion to done', async () => {
    const subagents = new FakeSubagents({ stopReason: 'completed' })
    const dispatcher = new HostSubagentDispatcher(subagents, {
      parent: { id: 'parent' },
      cwdForTask: () => '/repo/.workmates/p1',
    })

    const { result } = await dispatcher.start(request)

    expect(subagents.specs[0]).toMatchObject({
      provider: 'spawn',
      delivery: 'caller',
      request: { cwd: '/repo/.workmates/p1' },
    })
    expect(subagents.specs[0]?.request.prompt[0]?.text).toContain('后端开发')
    expect(subagents.specs[0]?.request.prompt[0]?.text).toContain('接口返回 200 且单测通过')
    await expect(result).resolves.toMatchObject({ status: 'done' })
    expect(subagents.disposed).toBe(1)
  })

  it('maps a non-completed stop to failed with the diagnostic', async () => {
    const subagents = new FakeSubagents({ stopReason: 'error', diagnostic: 'child crashed' })
    const dispatcher = new HostSubagentDispatcher(subagents, {
      parent: {},
      cwdForTask: () => '/wt',
    })

    const { result } = await dispatcher.start(request)
    await expect(result).resolves.toMatchObject({ status: 'failed', outcome: 'child crashed' })
  })

  it('rejects before starting when the target has no worktree', async () => {
    const subagents = new FakeSubagents({ stopReason: 'completed' })
    const dispatcher = new HostSubagentDispatcher(subagents, {
      parent: {},
      cwdForTask: () => {
        throw new Error('target 没有 worktree')
      },
    })

    await expect(dispatcher.start(request)).rejects.toThrow('没有 worktree')
    expect(subagents.specs).toHaveLength(0)
  })

  it('builds a role-aware prompt that forbids scope invention', () => {
    const prompt = buildTaskPrompt(request)
    expect(prompt).toContain('允许写入：src/main/order/**')
    expect(prompt).toContain('不要启动子代理')
    expect(prompt).toContain('不要伪造成功')
  })
  it('passes a role preset when configured', async () => {
    const subagents = new FakeSubagents({ stopReason: 'completed' })
    const dispatcher = new HostSubagentDispatcher(subagents, {
      parent: {},
      cwdForTask: () => '/wt',
      agentPresetForRole: (role) => (role === 'backend-dev' ? 'preset-readonly' : undefined),
    })
    await dispatcher.start(request)
    expect(subagents.specs[0]?.request.agentPreset).toBe('preset-readonly')
  })

  it('turns a QUESTION marker into a paused outcome, not done', async () => {
    const subagents = new FakeSubagents({
      stopReason: 'completed',
      output: [{ type: 'text', text: 'QUESTION: 用哪个分支？' }],
    })
    const dispatcher = new HostSubagentDispatcher(subagents, { parent: {}, cwdForTask: () => '/wt' })

    const { result } = await dispatcher.start(request)
    await expect(result).resolves.toMatchObject({ status: 'blocked', question: '用哪个分支？' })
  })

  it('passes role-level model options', async () => {
    const subagents = new FakeSubagents({ stopReason: 'completed' })
    const dispatcher = new HostSubagentDispatcher(subagents, {
      parent: {},
      cwdForTask: () => '/wt',
      agentOptionsForRole: (role) => (role === 'backend-dev' ? { model: 'deepseek-v4.1-flash' } : undefined),
    })
    await dispatcher.start(request)
    expect(subagents.specs[0]?.request.agentOptions).toEqual({ model: 'deepseek-v4.1-flash' })
  })

})
