import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TeamCoordinator, type DispatchHandle, type DispatchRequest, type TeamDispatcher } from './coordinator.ts'
import { TeamRunner, type SettleInput } from './runner.ts'
import { TeamRunStore } from './store.ts'
import type { TeamTaskSpec } from './types.ts'

let home: string
let runner: TeamRunner

const task = (id: string, overrides: Partial<TeamTaskSpec> = {}): TeamTaskSpec => ({
  id,
  title: id,
  role: 'backend-dev',
  project: 'repo',
  writes: [],
  dependsOn: [],
  acceptance: `${id} 可验收`,
  ...overrides,
})

class FakeDispatcher implements TeamDispatcher {
  readonly starts: DispatchRequest[] = []
  private readonly outcomes = new Map<string, SettleInput[]>()

  queue(taskId: string, ...outcomes: SettleInput[]): void {
    this.outcomes.set(taskId, outcomes)
  }

  async start(request: DispatchRequest): Promise<DispatchHandle> {
    this.starts.push(request)
    const queue = this.outcomes.get(request.task.id) ?? []
    const outcome = queue.shift() ?? { status: 'done' as const, outcome: 'ok' }
    return { result: Promise.resolve(outcome) }
  }
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wm-team-coordinator-'))
  runner = new TeamRunner(new TeamRunStore({ homeRoot: home, subdir: 'workmate' }))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('TeamCoordinator', () => {
  it('settles a dependent three-task run in two waves', async () => {
    await runner.createRun({
      id: 'r1',
      proposalId: 'p1',
      template: 'requirement-full',
      tasks: [task('t1'), task('t2'), task('t3', { dependsOn: ['t1', 't2'] })],
    })
    const dispatcher = new FakeDispatcher()
    const result = await new TeamCoordinator(runner, dispatcher).run('r1')

    expect(dispatcher.starts.map((request) => request.task.id)).toEqual(['t1', 't2', 't3'])
    expect(result.waves).toBe(2)
    expect(result.run.status).toBe('succeeded')
    expect(result.run.tasks.every((entry) => entry.status === 'done')).toBe(true)
  })

  it('retries a failed task and then succeeds', async () => {
    await runner.createRun({
      id: 'r1',
      proposalId: 'p1',
      template: 'bug-fix',
      tasks: [task('t1')],
      budget: { maxAttempts: 2 },
    })
    const dispatcher = new FakeDispatcher()
    dispatcher.queue('t1', { status: 'failed' }, { status: 'done', outcome: 'ok' })

    const result = await new TeamCoordinator(runner, dispatcher).run('r1')

    expect(dispatcher.starts).toHaveLength(2)
    expect(result.run.status).toBe('succeeded')
    expect(result.run.tasks[0]?.attempts).toBe(2)
  })

  it('stops with blocked when a worker blocks', async () => {
    await runner.createRun({
      id: 'r1',
      proposalId: 'p1',
      template: 'bug-fix',
      tasks: [task('t1')],
    })
    const dispatcher = new FakeDispatcher()
    dispatcher.queue('t1', { status: 'blocked', outcome: '需要人回答' })

    const result = await new TeamCoordinator(runner, dispatcher).run('r1')
    expect(result.run.status).toBe('blocked')
  })

  it('aborts when the run duration budget is exceeded', async () => {
    const start = new Date('2026-10-19T00:00:00.000Z')
    const createRunner = new TeamRunner(new TeamRunStore({ homeRoot: home, subdir: 'workmate' }), () => start)
    await createRunner.createRun({
      id: 'r1',
      proposalId: 'p1',
      template: 'bug-fix',
      tasks: [task('t1')],
      budget: { maxDurationMs: 1_000 },
    })
    const later = new Date(start.getTime() + 60_000)
    const coordinator = new TeamCoordinator(createRunner, new FakeDispatcher(), () => later)

    const result = await coordinator.run('r1')
    expect(result.run.status).toBe('aborted')
    expect(result.stopped).toContain('时长预算')
  })
  it('settles a failed dispatcher start instead of crashing the run', async () => {
    await runner.createRun({
      id: 'r1',
      proposalId: 'p1',
      template: 'bug-fix',
      tasks: [task('t1')],
      budget: { maxAttempts: 1 },
    })
    const dispatcher: TeamDispatcher = {
      async start() {
        throw new Error('host rejected the child')
      },
    }

    const result = await new TeamCoordinator(runner, dispatcher).run('r1')
    expect(result.run.status).toBe('partial')
    expect(result.run.tasks[0]?.status).toBe('failed')
  })

  it('emits dispatch/settled/run events to the sink', async () => {
    await runner.createRun({
      id: 'r1',
      proposalId: 'p1',
      template: 'bug-fix',
      tasks: [task('t1')],
    })
    const calls: string[] = []
    const sink = {
      dispatch: async () => {
        calls.push('dispatch')
      },
      settled: async () => {
        calls.push('settled')
      },
      run: async () => {
        calls.push('run')
      },
    }

    await new TeamCoordinator(runner, new FakeDispatcher(), () => new Date(), sink).run('r1')
    expect(calls).toEqual(['dispatch', 'settled', 'run'])
  })

  it('rejects a done claim without positive proof', async () => {
    await runner.createRun({
      id: 'r1',
      proposalId: 'p1',
      template: 'bug-fix',
      tasks: [task('t1')],
      budget: { maxAttempts: 1 },
    })
    const dispatcher = new FakeDispatcher()
    dispatcher.queue('t1', { status: 'done' })

    const result = await new TeamCoordinator(runner, dispatcher).run('r1')
    expect(result.run.status).toBe('partial')
    expect(result.run.tasks[0]?.status).toBe('failed')
    expect(result.run.dispatches?.[0]?.outcome).toContain('缺少完成证据')
  })

  it('pauses on a worker question and resumes after an answer', async () => {
    await runner.createRun({
      id: 'r1',
      proposalId: 'p1',
      template: 'bug-fix',
      tasks: [task('t1')],
      budget: { maxAttempts: 1 },
    })
    const dispatcher = new FakeDispatcher()
    dispatcher.queue('t1', { status: 'blocked', question: '用哪个分支？' })

    const coordinator = new TeamCoordinator(runner, dispatcher, () => new Date())
    const result = await coordinator.run('r1')

    expect(result.stopped).toContain('等待回答')
    expect(result.questionId).toBeDefined()
    expect(result.run.status).toBe('blocked')
    expect(result.run.inbox?.[0]?.body).toBe('用哪个分支？')

    await runner.answerMessage('r1', result.questionId as string, 'feature/p1')
    expect((await runner.nextWave('r1')).map((entry) => entry.id)).toEqual(['t1'])
  })

  it('stops after maxWaves and leaves the run resumable', async () => {
    await runner.createRun({
      id: 'r1',
      proposalId: 'p1',
      template: 'requirement-full',
      tasks: [task('t1'), task('t2', { dependsOn: ['t1'] })],
    })
    const dispatcher = new FakeDispatcher()
    const result = await new TeamCoordinator(runner, dispatcher).run('r1', { maxWaves: 1 })

    expect(result.waves).toBe(1)
    expect(result.stopped).toContain('波次上限')
    expect(result.run.status).toBe('running')
    expect(dispatcher.starts.map((request) => request.task.id)).toEqual(['t1'])
    expect((await runner.nextWave('r1')).map((entry) => entry.id)).toEqual(['t2'])
  })

  it('aborts when measured tokens exceed the budget', async () => {
    await runner.createRun({
      id: 'r1',
      proposalId: 'p1',
      template: 'bug-fix',
      tasks: [task('t1'), task('t2', { dependsOn: ['t1'] })],
      budget: { maxTokens: 50 },
    })
    const dispatcher = new FakeDispatcher()
    dispatcher.queue('t1', { status: 'done', outcome: 'ok', tokensUsed: 60 })

    const result = await new TeamCoordinator(runner, dispatcher).run('r1')
    expect(result.stopped).toContain('token 预算')
    expect(result.run.status).toBe('aborted')
    expect(result.run.tokensUsed).toBe(60)
  })

  it('aborts a wave that exceeds maxWaveMs instead of hanging', async () => {
    await runner.createRun({
      id: 'r1',
      proposalId: 'p1',
      template: 'bug-fix',
      tasks: [task('t1')],
      budget: { maxWaveMs: 30, maxDurationMs: 60_000 },
    })
    const hanging: TeamDispatcher = {
      async start() {
        return { result: new Promise<SettleInput>(() => undefined) }
      },
    }
    const result = await new TeamCoordinator(runner, hanging).run('r1')
    expect(result.stopped).toContain('单波超时')
    expect(result.run.status).toBe('aborted')
  }, 5_000)

  it('rejects a reviewer that reuses an implementer session', async () => {
    await runner.createRun({
      id: 'r1',
      proposalId: 'p1',
      template: 'requirement-full',
      tasks: [
        task('impl', { role: 'backend-dev', project: 'demo' }),
        task('review', { role: 'reviewer', project: 'demo', dependsOn: ['impl'] }),
      ],
      budget: { maxAttempts: 1 },
    })
    const sameSession: TeamDispatcher = {
      async start() {
        return {
          sessionId: 'session-1',
          result: Promise.resolve({ status: 'done' as const, outcome: 'ok', reportPath: 'TEAM-REVIEW.md' }),
        }
      },
    }
    const result = await new TeamCoordinator(runner, sameSession).run('r1')
    expect(result.run.status).toBe('partial')
    expect(result.run.tasks.find((entry) => entry.id === 'review')?.status).toBe('failed')
    expect(result.run.dispatches?.find((dispatch) => dispatch.taskId === 'review')?.outcome).toContain(
      '不能复用实现者会话',
    )
  })

  it('pauses instead of spinning when the Dispatch limit blocks a task', async () => {
    await runner.createRun({
      id: 'r1',
      proposalId: 'p1',
      template: 'bug-fix',
      tasks: [task('t1'), task('t2')],
      budget: { maxDispatches: 1 },
    })
    const result = await new TeamCoordinator(runner, new FakeDispatcher()).run('r1')
    expect(result.stopped).toContain('Dispatch 限额')
    expect(result.run.status).not.toBe('aborted')
  }, 5_000)

  it('detects reviewer session reuse after a resumed run reloads dispatches', async () => {
    await runner.createRun({
      id: 'r1',
      proposalId: 'p1',
      template: 'requirement-full',
      tasks: [
        task('impl', { role: 'backend-dev', project: 'demo' }),
        task('review', { role: 'reviewer', project: 'demo', dependsOn: ['impl'] }),
      ],
      budget: { maxAttempts: 1 },
    })
    await runner.dispatch('r1', 'impl', 'd1')
    await runner.settle('r1', 'd1', { status: 'done', outcome: 'ok', sessionId: 'session-1' })
    const sameSession: TeamDispatcher = {
      async start() {
        return {
          sessionId: 'session-1',
          result: Promise.resolve({ status: 'done' as const, outcome: 'ok', reportPath: 'TEAM-REVIEW.md' }),
        }
      },
    }
    const result = await new TeamCoordinator(runner, sameSession).run('r1')
    expect(result.run.tasks.find((entry) => entry.id === 'review')?.status).toBe('failed')
    expect(result.run.dispatches?.find((dispatch) => dispatch.taskId === 'review')?.outcome).toContain(
      '不能复用实现者会话',
    )
  })

})
