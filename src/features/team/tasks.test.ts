import { describe, expect, it } from 'vitest'
import { parseTeamTasks, planTeamWaves, teamTasksPath, validateTeamTasks } from './tasks.ts'
import type { TeamTaskSpec } from './types.ts'

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

describe('TASKS.json validation', () => {
  it('parses a valid file', () => {
    const raw = JSON.stringify({ tasks: [task('t1'), task('t2', { dependsOn: ['t1'] })] })
    expect(parseTeamTasks(raw).map((entry) => entry.id)).toEqual(['t1', 't2'])
  })

  it('reports duplicate ids, unknown dependencies and cycles', () => {
    const duplicate = validateTeamTasks([task('t1'), task('t1')])
    expect(duplicate.ok).toBe(false)
    expect(duplicate.errors.join()).toContain('重复 id')

    const unknown = validateTeamTasks([task('t1', { dependsOn: ['ghost'] })])
    expect(unknown.errors.join()).toContain('依赖不存在')

    const cycle = validateTeamTasks([
      task('a', { dependsOn: ['b'] }),
      task('b', { dependsOn: ['a'] }),
    ])
    expect(cycle.errors.join()).toContain('依赖成环')
  })

  it('rejects an invalid role and missing acceptance', () => {
    const invalid = validateTeamTasks([
      { id: 't1', title: 't', role: 'wizard', project: 'repo', writes: [], dependsOn: [], acceptance: '' },
    ])
    expect(invalid.ok).toBe(false)
    expect(invalid.errors.join()).toContain('role 非法')
    expect(invalid.errors.join()).toContain('acceptance')
  })
})

describe('wave planning', () => {
  it('places independent tasks in the first wave and dependants later', () => {
    const waves = planTeamWaves([
      task('t1'),
      task('t2', { project: 'other' }),
      task('t3', { dependsOn: ['t1', 't2'] }),
    ])
    expect(waves.map((wave) => wave.map((entry) => entry.id))).toEqual([['t1', 't2'], ['t3']])
  })

  it('honours the concurrency cap', () => {
    const waves = planTeamWaves([task('t1'), task('t2', { project: 'a' }), task('t3', { project: 'b' })], 2)
    expect(waves.map((wave) => wave.length)).toEqual([2, 1])
  })

  it('separates same-project overlapping writes into different waves', () => {
    const waves = planTeamWaves([
      task('t1', { writes: ['src/main/order/**'] }),
      task('t2', { writes: ['src/main/order/detail/**'] }),
      task('t3', { project: 'other', writes: ['src/main/order/**'] }),
    ])
    expect(waves.map((wave) => wave.map((entry) => entry.id))).toEqual([['t1', 't3'], ['t2']])
  })

  it('rejects a file that cannot make progress', () => {
    expect(() => planTeamWaves([task('a', { dependsOn: ['b'] }), task('b', { dependsOn: ['a'] })])).toThrow(
      /校验失败|依赖/,
    )
  })
})

describe('teamTasksPath', () => {
  it('points at the proposal change directory', () => {
    expect(teamTasksPath('/repo', 'openspec', 'p1')).toBe('/repo/openspec/changes/p1/TASKS.json')
  })
})
