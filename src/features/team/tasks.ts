/**
 * `TASKS.json` contract (change `autonomous-agent-team`, design D4/D8).
 *
 * The file is the single source of team work: id, role, project, declared
 * writes, dependencies and an observable acceptance criterion. The coordinator
 * only dispatches what this file says; wave planning respects both dependencies
 * and declared write-scope overlap (a worktree cannot fix two proposals editing
 * the same files in one repository).
 */
import { join } from 'node:path'
import { scopesIntersect } from '../swarm/plan.ts'
import { TEAM_ROLES, isTeamRole, type TeamRole, type TeamTaskSpec } from './types.ts'

export interface TeamTasksValidation {
  ok: boolean
  errors: string[]
  tasks: TeamTaskSpec[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const stringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string')

const stringField = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''

/** Structural validation; returns usable tasks even when `ok` is false (for messages). */
export function validateTeamTasks(input: unknown): TeamTasksValidation {
  const errors: string[] = []
  const raw = isRecord(input) && Array.isArray(input['tasks']) ? input['tasks'] : input
  if (!Array.isArray(raw)) {
    return { ok: false, errors: ['TASKS.json 必须是数组（或 {tasks: []}）'], tasks: [] }
  }
  const tasks: TeamTaskSpec[] = []
  const ids = new Set<string>()
  for (const [index, entry] of raw.entries()) {
    if (!isRecord(entry)) {
      errors.push(`第 ${index + 1} 项不是对象`)
      continue
    }
    const id = entry['id']
    const title = entry['title']
    const role = entry['role']
    const project = entry['project']
    const writes = entry['writes']
    const dependsOn = entry['dependsOn']
    const acceptance = entry['acceptance']
    if (!stringField(id)) errors.push(`第 ${index + 1} 项缺 id`)
    else if (ids.has(id)) errors.push(`重复 id: ${id}`)
    else ids.add(id)
    if (!stringField(title)) errors.push(`${String(id ?? index + 1)} 缺 title`)
    if (!isTeamRole(role)) errors.push(`${String(id ?? index + 1)} 的 role 非法（${TEAM_ROLES.join(', ')}）`)
    if (!stringField(project)) errors.push(`${String(id ?? index + 1)} 缺 project`)
    if (!stringArray(writes)) errors.push(`${String(id ?? index + 1)} 的 writes 必须是字符串数组`)
    if (!stringArray(dependsOn)) errors.push(`${String(id ?? index + 1)} 的 dependsOn 必须是字符串数组`)
    if (!stringField(acceptance)) errors.push(`${String(id ?? index + 1)} 缺 acceptance`)

    if (
      stringField(id) &&
      stringField(title) &&
      isTeamRole(role) &&
      stringField(project) &&
      stringArray(writes) &&
      stringArray(dependsOn) &&
      stringField(acceptance)
    ) {
      tasks.push({
        id,
        title,
        role: role as TeamRole,
        project,
        writes: [...writes],
        dependsOn: [...dependsOn],
        acceptance,
      })
    }
  }

  const known = new Set(tasks.map((task) => task.id))
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!known.has(dependency)) errors.push(`${task.id} 依赖不存在的任务 ${dependency}`)
      if (dependency === task.id) errors.push(`${task.id} 不能依赖自己`)
    }
  }
  const cycle = findCycle(tasks)
  if (cycle !== undefined) errors.push(`依赖成环：${cycle.join(' → ')}`)
  return { ok: errors.length === 0, errors, tasks }
}

/** Parse the on-disk shape; throws with all validation errors when invalid. */
export function parseTeamTasks(raw: string): TeamTaskSpec[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('TASKS.json 不是合法 JSON')
  }
  const result = validateTeamTasks(parsed)
  if (!result.ok) throw new Error(`TASKS.json 校验失败：${result.errors.join('；')}`)
  return result.tasks
}

function findCycle(tasks: readonly TeamTaskSpec[]): string[] | undefined {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const stack: string[] = []

  const visit = (id: string): string[] | undefined => {
    if (visited.has(id)) return undefined
    if (visiting.has(id)) {
      const start = stack.indexOf(id)
      return [...stack.slice(start), id]
    }
    visiting.add(id)
    stack.push(id)
    const task = byId.get(id)
    for (const dependency of task?.dependsOn ?? []) {
      const found = visit(dependency)
      if (found !== undefined) return found
    }
    stack.pop()
    visiting.delete(id)
    visited.add(id)
    return undefined
  }

  for (const task of tasks) {
    const found = visit(task.id)
    if (found !== undefined) return found
  }
  return undefined
}

const writesConflict = (left: TeamTaskSpec, right: TeamTaskSpec): boolean => {
  if (left.project !== right.project) return false
  for (const a of left.writes) {
    for (const b of right.writes) if (scopesIntersect(a, b)) return true
  }
  return false
}

/**
 * Topological waves with a concurrency cap and same-project write-scope
 * separation. Tasks are considered in file order; a conflicting ready task is
 * deferred to the next wave instead of being reordered arbitrarily.
 */
export function planTeamWaves(tasks: readonly TeamTaskSpec[], maxParallel = 3): TeamTaskSpec[][] {
  const validation = validateTeamTasks(tasks)
  if (!validation.ok) throw new Error(`TASKS.json 校验失败：${validation.errors.join('；')}`)
  const limit = Math.max(1, Math.floor(maxParallel))
  const done = new Set<string>()
  const remaining = new Map(tasks.map((task) => [task.id, task]))
  const waves: TeamTaskSpec[][] = []

  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter((task) => task.dependsOn.every((dependency) => done.has(dependency)))
    if (ready.length === 0) throw new Error('TASKS.json 依赖无法满足（存在环或缺失依赖）')
    const wave: TeamTaskSpec[] = []
    for (const task of ready) {
      if (wave.length >= limit) break
      if (wave.some((selected) => writesConflict(selected, task))) continue
      wave.push(task)
    }
    if (wave.length === 0) throw new Error('TASKS.json 无法装入波次（写域冲突或并发上限为 0）')
    for (const task of wave) {
      done.add(task.id)
      remaining.delete(task.id)
    }
    waves.push(wave)
  }
  return waves
}

/** `<projectRoot>/<openspecRoot>/changes/<changeId>/TASKS.json` */
export function teamTasksPath(projectRoot: string, openspecRoot: string, changeId: string): string {
  return join(projectRoot, openspecRoot, 'changes', changeId, 'TASKS.json')
}
