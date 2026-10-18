import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  constructor(private readonly result: { stopReason?: string; diagnostic?: string; output?: unknown[]; usage?: { totalTokens?: number } }) {}
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

  it('passes measured token usage through, and omits it when absent', async () => {
    const measured = new FakeSubagents({ stopReason: 'completed', usage: { totalTokens: 321 } })
    const dispatcher = new HostSubagentDispatcher(measured, { parent: {}, cwdForTask: () => '/wt' })
    await expect((await dispatcher.start(request)).result).resolves.toMatchObject({ tokensUsed: 321 })

    const unmeasured = new FakeSubagents({ stopReason: 'completed' })
    const plain = new HostSubagentDispatcher(unmeasured, { parent: {}, cwdForTask: () => '/wt' })
    const outcome = await (await plain.start(request)).result
    expect(outcome.tokensUsed).toBeUndefined()
  })

  it('reports FILES markers for write-scope checks', async () => {
    const subagents = new FakeSubagents({
      stopReason: 'completed',
      output: [{ type: 'text', text: 'done\nFILES: src/main/a.ts, tests/a.test.ts' }],
    })
    const dispatcher = new HostSubagentDispatcher(subagents, { parent: {}, cwdForTask: () => '/wt' })
    await expect((await dispatcher.start(request)).result).resolves.toMatchObject({
      filesModified: ['src/main/a.ts', 'tests/a.test.ts'],
    })
  })

  it('reports REPORT paths for artifact-owning roles', async () => {
    const subagents = new FakeSubagents({
      stopReason: 'completed',
      output: [{ type: 'text', text: 'done\nREPORT: TEST.md' }],
    })
    const dispatcher = new HostSubagentDispatcher(subagents, { parent: {}, cwdForTask: () => '/wt' })
    await expect((await dispatcher.start(request)).result).resolves.toMatchObject({ reportPath: 'TEST.md' })
  })

  it('measures changed files via git and rejects a missing REPORT path', async () => {
    const measured = new FakeSubagents({ stopReason: 'completed' })
    const dispatcher = new HostSubagentDispatcher(measured, {
      parent: {},
      cwdForTask: () => '/wt',
      changedFilesForTask: async () => ['src/main/a.ts'],
      verifyReportPath: true,
    })
    await expect((await dispatcher.start(request)).result).resolves.toMatchObject({
      filesModified: ['src/main/a.ts'],
    })

    const withReport = new FakeSubagents({
      stopReason: 'completed',
      output: [{ type: 'text', text: 'REPORT: TEST.md' }],
    })
    const missing = new HostSubagentDispatcher(withReport, {
      parent: {},
      cwdForTask: () => '/wt',
      verifyReportPath: true,
    })
    await expect((await missing.start(request)).result).resolves.toMatchObject({
      status: 'failed',
      outcome: expect.stringContaining('REPORT 路径不存在'),
    })
  })

  it('rejects a done claim with uncommitted changes when requireCommit is on', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wm-commit-'))
    const git = (args: string[]): Promise<string> =>
      new Promise((resolvePromise, reject) => {
        execFile('git', args, { cwd: root }, (error, stdout) =>
          error ? reject(error) : resolvePromise(stdout.trim()),
        )
      })
    try {
      await git(['init', '-b', 'main'])
      await git(['config', 'user.email', 't@t'])
      await git(['config', 'user.name', 't'])
      await writeFile(join(root, 'base.txt'), 'base\n', 'utf8')
      await git(['add', '-A'])
      await git(['commit', '-m', 'init'])
      const base = await git(['rev-parse', 'HEAD'])

      await writeFile(join(root, 'a.ts'), 'dirty\n', 'utf8')
      const subagents = new FakeSubagents({ stopReason: 'completed' })
      const dispatcher = new HostSubagentDispatcher(subagents, {
        parent: {},
        cwdForTask: () => root,
        changedFilesForTask: async () => ['a.ts'],
        requireCommit: true,
        baseForTask: () => base,
      })
      await expect((await dispatcher.start(request)).result).resolves.toMatchObject({
        status: 'failed',
        outcome: expect.stringContaining('未提交'),
      })

      await git(['add', '-A'])
      await git(['commit', '-m', 'work'])
      await expect((await dispatcher.start(request)).result).resolves.toMatchObject({ status: 'done' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

})
