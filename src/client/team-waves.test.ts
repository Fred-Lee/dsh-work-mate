import { describe, expect, it } from 'vitest'
import { taskWaves, waveDepth } from './team-waves.ts'
import type { TeamTaskRecord } from '../features/team/types.ts'

const task = (id: string, dependsOn: string[] = []): TeamTaskRecord => ({
  id,
  title: id,
  role: 'backend-dev',
  project: 'repo',
  writes: [],
  dependsOn,
  acceptance: 'ok',
  status: 'planned',
  attempts: 0,
})

describe('team wave projection', () => {
  it('groups independent tasks and their dependants by level', () => {
    const tasks = [task('t1'), task('t2'), task('t3', ['t1', 't2']), task('t4', ['t3'])]
    expect(taskWaves(tasks).map((wave) => wave.map((entry) => entry.id))).toEqual([['t1', 't2'], ['t3'], ['t4']])
    expect(waveDepth(tasks)).toBe(3)
  })

  it('ignores unknown dependencies and breaks cycles deterministically', () => {
    expect(taskWaves([task('t1', ['ghost'])]).map((wave) => wave.map((entry) => entry.id))).toEqual([['t1']])
    const cyclic = taskWaves([task('a', ['b']), task('b', ['a'])])
    expect(cyclic.flat().map((entry) => entry.id).sort()).toEqual(['a', 'b'])
  })
})
