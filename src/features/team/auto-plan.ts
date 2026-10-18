/**
 * G2 → Run creation (change `autonomous-agent-team`, T2-2.0). Plan approval is
 * the human gate; once crossed, a complete TASKS.json can create a planned Run
 * without another click. Dispatch still requires a host agent, so this function
 * never starts workers.
 */
import { readFile } from 'node:fs/promises'
import { checkTeamCompleteness } from './completeness.ts'
import type { TeamRunner } from './runner.ts'
import type { TeamRunStore } from './store.ts'
import { parseTeamTasks, teamTasksPath } from './tasks.ts'
import type { TeamRun, TeamRole, TeamTemplate } from './types.ts'

export interface AutoPlanInput {
  proposalId: string
  changeId: string
  projectRoot: string
  openspecRoot: string
  store: TeamRunStore
  runner: TeamRunner
  /** Override inference; otherwise inferred from task roles. */
  template?: TeamTemplate
}

export interface AutoPlanResult {
  created: boolean
  run?: TeamRun
  skipped?: string
}

/** Infer the smallest template that covers every task role. */
export function inferTemplate(roles: readonly TeamRole[]): TeamTemplate {
  const set = new Set(roles)
  if (set.has('requirement-evaluator')) return 'requirement-full'
  if (set.has('solution-evaluator')) return 'bug-fix'
  return 'delivery'
}

export async function autoPlanTeamRun(input: AutoPlanInput): Promise<AutoPlanResult> {
  const active = (await input.store.list()).find(
    (run) => run.proposalId === input.proposalId && (run.status === 'planned' || run.status === 'running'),
  )
  if (active !== undefined) return { created: false, run: active, skipped: 'already has an active run' }

  let raw: string
  try {
    raw = await readFile(teamTasksPath(input.projectRoot, input.openspecRoot, input.changeId), 'utf8')
  } catch {
    return { created: false, skipped: 'TASKS.json missing' }
  }
  const tasks = parseTeamTasks(raw)
  const template = input.template ?? inferTemplate(tasks.map((task) => task.role))
  const completeness = await checkTeamCompleteness(input.projectRoot, input.openspecRoot, input.changeId, template)
  if (!completeness.ok) {
    return { created: false, skipped: `team artifacts incomplete: ${completeness.errors.join('; ')}` }
  }

  const run = await input.runner.createRun({ proposalId: input.proposalId, template, tasks })
  return { created: true, run }
}
