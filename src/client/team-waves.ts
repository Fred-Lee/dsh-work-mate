/** Client-side wave projection for the team console (change `autonomous-agent-team`, T5-5.2). */
import type { TeamTaskRecord } from '../features/team/types.ts'

/**
 * Dependency levels from `dependsOn`; unknown ids are ignored, a cycle is
 * broken at level 0 instead of hanging the UI. The team runner is still the
 * authority for dispatch order — this is a read-only projection.
 */
export function taskWaves(tasks: readonly TeamTaskRecord[]): TeamTaskRecord[][] {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const level = new Map<string, number>()
  const visiting = new Set<string>()

  const levelOf = (id: string): number => {
    const known = level.get(id)
    if (known !== undefined) return known
    if (visiting.has(id)) return 0
    visiting.add(id)
    const task = byId.get(id)
    const dependencies = (task?.dependsOn ?? []).filter((dependency) => byId.has(dependency))
    const value = dependencies.length === 0 ? 0 : Math.max(...dependencies.map((dependency) => levelOf(dependency))) + 1
    visiting.delete(id)
    level.set(id, value)
    return value
  }

  for (const task of tasks) levelOf(task.id)
  const depth = tasks.reduce((max, task) => Math.max(max, level.get(task.id) ?? 0), 0)
  return Array.from({ length: depth + 1 }, (_, index) => tasks.filter((task) => level.get(task.id) === index))
}

/** Number of dependency layers; the critical-path length in waves. */
export function waveDepth(tasks: readonly TeamTaskRecord[]): number {
  return taskWaves(tasks).length
}
