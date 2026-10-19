/**
 * Team artifact completeness (change `autonomous-agent-team`, T4-4.1).
 *
 * Before a Run exists, the template decides which authoring artifacts must be
 * present: a requirement-full/bug-fix run needs PLAN.md, requirement-full also
 * needs REQ.md; TASKS.json is always required. Post-run evidence (TEST/REVIEW)
 * is checked by the archive gate, not here.
 */
import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { REQUIRED_SECTIONS } from './artifacts.ts'
import { TEAM_TEMPLATE_CONTRACTS } from './roster.ts'
import type { TeamArtifact, TeamTemplate } from './types.ts'

export interface TeamCompletenessResult {
  ok: boolean
  errors: string[]
  required: TeamArtifact[]
}

export function requiredArtifacts(template: TeamTemplate): TeamArtifact[] {
  const roles = TEAM_TEMPLATE_CONTRACTS[template].roles
  const required: TeamArtifact[] = []
  if (roles.includes('requirement-evaluator')) required.push('REQ.md')
  if (roles.includes('solution-evaluator')) required.push('PLAN.md')
  required.push('TASKS.json')
  return required
}

export async function checkTeamCompleteness(
  projectRoot: string,
  openspecRoot: string,
  changeId: string,
  template: TeamTemplate,
): Promise<TeamCompletenessResult> {
  const dir = join(projectRoot, openspecRoot, 'changes', changeId)
  const required = requiredArtifacts(template)
  const errors: string[] = []

  for (const artifact of required) {
    let content: string
    try {
      content = await readFile(join(dir, artifact), 'utf8')
    } catch {
      errors.push(`${artifact} 缺失`)
      continue
    }
    for (const section of REQUIRED_SECTIONS[artifact]) {
      if (!content.includes(section)) errors.push(`${artifact} 缺「${section}」`)
    }
  }

  return { ok: errors.length === 0, errors, required }
}

/** Run `openspec validate --strict` for the change; undefined means CLI unavailable. */
export function validateOpenSpecChange(
  projectRoot: string,
  changeId: string,
): Promise<{ ok: boolean; detail?: string } | undefined> {
  return new Promise((resolvePromise) => {
    execFile('openspec', ['validate', changeId, '--strict'], { cwd: projectRoot, timeout: 30_000 }, (error, stdout, stderr) => {
      if (error === null) return resolvePromise({ ok: true })
      const message = `${stdout}\n${stderr}`.trim()
      if (/ENOENT/.test(message)) return resolvePromise(undefined)
      resolvePromise({ ok: false, detail: message.slice(0, 500) })
    })
  })
}
