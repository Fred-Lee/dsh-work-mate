import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TeamRunner } from './runner.ts'
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

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'wm-team-runner-'))
  runner = new TeamRunner(new TeamRunStore({ homeRoot: home, subdir: 'workmate' }))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('TeamRunner', () => {
  it('creates a run and enforces template roles', async () => {
    const run = await runner.createRun({ id: 'r1', proposalId: 'p1', template: 'bug-fix', tasks: [task('t1')] })
    expect(run.status).toBe('planned')
    expect(run.tasks[0]).toMatchObject({ id: 't1', status: 'planned', attempts: 0 })

    await expect(
      runner.createRun({
        id: 'r2',
        proposalId: 'p2',
        template: 'bug-fix',
        tasks: [task('t1', { role: 'requirement-evaluator' })],
      }),
    ).rejects.toThrow(/不包含角色/)
  })

  it('dispatches a wave, then the dependent wave after settling', async () => {
    await runner.createRun({
      id: 'r1',
      proposalId: 'p1',
      template: 'requirement-full',
      tasks: [
        task('t1', { project: 'a' }),
        task('t2', { project: 'b' }),
        task('t3', { dependsOn: ['t1', 't2'] }),
      ],
    })
    await runner.start('r1')

    expect((await runner.nextWave('r1')).map((entry) => entry.id)).toEqual(['t1', 't2'])
    await runner.dispatch('r1', 't1', 'd1')
    await runner.dispatch('r1', 't2', 'd2')
    expect(await runner.nextWave('r1')).toEqual([])

    await runner.settle('r1', 'd1', { status: 'done' })
    await runner.settle('r1', 'd2', { status: 'done' })
    expect((await runner.nextWave('r1')).map((entry) => entry.id)).toEqual(['t3'])

    await runner.dispatch('r1', 't3', 'd3')
    await runner.settle('r1', 'd3', { status: 'done' })
    expect((await runner.get('r1')).status).toBe('succeeded')
  })

  it('keeps same-project overlapping writes out of one wave', async () => {
    await runner.createRun({
      id: 'r1',
      proposalId: 'p1',
      template: 'bug-fix',
      tasks: [
        task('t1', { writes: ['src/main/order/**'] }),
        task('t2', { writes: ['src/main/order/detail/**'] }),
        task('t3', { project: 'other', writes: ['src/main/order/**'] }),
      ],
    })
    expect((await runner.nextWave('r1')).map((entry) => entry.id)).toEqual(['t1', 't3'])
  })

  it('requeues a failed attempt until the retry cap, then marks partial', async () => {
    await runner.createRun({
      id: 'r1',
      proposalId: 'p1',
      template: 'bug-fix',
      tasks: [task('t1')],
      budget: { maxAttempts: 2 },
    })
    await runner.dispatch('r1', 't1', 'd1')
    await runner.settle('r1', 'd1', { status: 'failed' })
    expect((await runner.get('r1')).tasks[0]?.status).toBe('planned')

    await runner.dispatch('r1', 't1', 'd2')
    await runner.settle('r1', 'd2', { status: 'failed' })
    const run = await runner.get('r1')
    expect(run.tasks[0]?.status).toBe('failed')
    expect(run.status).toBe('partial')
  })

  it('enforces the dispatch budget', async () => {
    await runner.createRun({
      id: 'r1',
      proposalId: 'p1',
      template: 'bug-fix',
      tasks: [task('t1')],
      budget: { maxDispatches: 1 },
    })
    await runner.dispatch('r1', 't1', 'd1')
    await runner.settle('r1', 'd1', { status: 'failed' })
    await expect(runner.dispatch('r1', 't1', 'd2')).rejects.toThrow(/Dispatch 上限/)
  })
})
