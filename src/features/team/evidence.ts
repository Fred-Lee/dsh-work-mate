/**
 * Team evidence gate (change `autonomous-agent-team`, T4).
 *
 * A team-managed change is identified by `TASKS.json`: only then are TEST.md and
 * TEAM-REVIEW.md required. This keeps legacy proposals that never used a team run
 * from being blocked by evidence they never promised.
 */
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { REQUIRED_SECTIONS } from './artifacts.ts'
import { validateTeamTasks } from './tasks.ts'

export interface TeamEvidenceResult {
  /** `false` when the change has no TASKS.json (not team-managed). */
  managed: boolean
  ok: boolean
  errors: string[]
}

const required = async (path: string, label: string, errors: string[]): Promise<string | undefined> => {
  try {
    return await readFile(path, 'utf8')
  } catch {
    errors.push(`${label} 缺失`)
    return undefined
  }
}

export async function checkTeamEvidence(
  projectRoot: string,
  openspecRoot: string,
  changeId: string,
): Promise<TeamEvidenceResult> {
  const dir = join(projectRoot, openspecRoot, 'changes', changeId)
  try {
    await stat(join(dir, 'TASKS.json'))
  } catch {
    return { managed: false, ok: true, errors: [] }
  }

  const errors: string[] = []
  const tasksRaw = await required(join(dir, 'TASKS.json'), 'TASKS.json', errors)
  if (tasksRaw !== undefined) {
    try {
      const validation = validateTeamTasks(JSON.parse(tasksRaw))
      if (!validation.ok) errors.push(`TASKS.json 校验失败：${validation.errors.join('；')}`)
    } catch {
      errors.push('TASKS.json 不是合法 JSON')
    }
  }

  for (const artifact of ['TEST.md', 'TEAM-REVIEW.md'] as const) {
    const content = await required(join(dir, artifact), artifact, errors)
    if (content === undefined) continue
    for (const section of REQUIRED_SECTIONS[artifact]) {
      if (!content.includes(section)) errors.push(`${artifact} 缺「${section}」`)
    }
  }

  return { managed: true, ok: errors.length === 0, errors }
}
