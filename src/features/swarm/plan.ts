/**
 * Swarm planning (change `add-swarm-parallel`, design D1/D2).
 *
 * Tasks come from the proposal's own `tasks.md` — one line per task, with an
 * optional `<!-- writes: a/**, b/** -->` annotation declaring the file scope it
 * may touch. Two tasks whose scopes intersect never share a batch, because
 * physical isolation (a worktree each) does not prevent a logical conflict.
 *
 * Pure functions only: the git side lives in `manager.ts`.
 */
export interface SwarmTaskInput {
  /** Stable id derived from the task line, e.g. `t2`. */
  id: string
  title: string
  /** Declared write scopes; empty means "not declared" (design D2). */
  writes: string[]
}

export interface SwarmBatch {
  index: number
  tasks: string[]
}

export interface SwarmConflict {
  a: string
  b: string
  /** The overlapping scope (one side's prefix that covers the other). */
  scope: string
}

export interface SwarmPlan {
  batches: SwarmBatch[]
  conflicts: SwarmConflict[]
  /** Tasks without a `writes` declaration — they never block, but they also cannot be trusted. */
  undeclared: string[]
}

const TASK_LINE = /^- \[( |x|X)\]\s+(.+)$/
const WRITES_ANNOTATION = /<!--\s*writes:\s*([^>]*?)\s*-->/

/** Parse `tasks.md` into task inputs (id = `t<ordinal>` in file order). */
export function parseSwarmTasks(content: string): SwarmTaskInput[] {
  const tasks: SwarmTaskInput[] = []
  let ordinal = 0
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    const match = TASK_LINE.exec(line)
    if (match === null) continue
    ordinal += 1
    const body = match[2] ?? ''
    const annotation = WRITES_ANNOTATION.exec(body)
    const writes =
      annotation === null
        ? []
        : (annotation[1] ?? '')
            .split(',')
            .map((scope) => scope.trim())
            .filter((scope) => scope !== '')
    tasks.push({
      id: `t${ordinal}`,
      title: body.replace(WRITES_ANNOTATION, '').trim(),
      writes,
    })
  }
  return tasks
}

/** Do two declared scopes overlap? Trailing `/**` and `/*` mean "this subtree". */
export function scopesIntersect(left: string, right: string): boolean {
  const normalize = (scope: string): string => scope.replace(/\/\*\*?$/, '').replace(/\/+$/, '')
  const a = normalize(left)
  const b = normalize(right)
  if (a === '' || b === '') return false
  if (a === b) return true
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

const tasksConflict = (left: SwarmTaskInput, right: SwarmTaskInput): string | undefined => {
  for (const a of left.writes) {
    for (const b of right.writes) {
      if (scopesIntersect(a, b)) return a.length <= b.length ? a : b
    }
  }
  return undefined
}

/**
 * Greedy first-fit batching: place each task in the first batch that has room and
 * holds no conflicting task (design D2). Greedy is enough at these sizes.
 */
export function planSwarm(tasks: readonly SwarmTaskInput[], options: { maxParallel?: number } = {}): SwarmPlan {
  const maxParallel = Math.max(1, Math.floor(options.maxParallel ?? 3))
  const batches: SwarmTaskInput[][] = []
  const conflicts: SwarmConflict[] = []

  for (let index = 0; index < tasks.length; index += 1) {
    for (let other = index + 1; other < tasks.length; other += 1) {
      const left = tasks[index] as SwarmTaskInput
      const right = tasks[other] as SwarmTaskInput
      const scope = tasksConflict(left, right)
      if (scope !== undefined) conflicts.push({ a: left.id, b: right.id, scope })
    }
  }

  for (const task of tasks) {
    let placed = false
    for (const batch of batches) {
      if (batch.length >= maxParallel) continue
      if (batch.some((member) => tasksConflict(member, task) !== undefined)) continue
      batch.push(task)
      placed = true
      break
    }
    if (!placed) batches.push([task])
  }

  return {
    batches: batches.map((batch, index) => ({ index, tasks: batch.map((task) => task.id) })),
    conflicts,
    undeclared: tasks.filter((task) => task.writes.length === 0).map((task) => task.id),
  }
}
