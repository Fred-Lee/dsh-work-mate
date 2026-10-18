/**
 * Authoring-artifact normalization (change `autonomous-agent-team`, T1.5/T1.6).
 *
 * Existing OpenSpec proposals have proposal/design/tasks, not the team's
 * REQ/PLAN/TASKS.json. This prepares missing files from those sources without
 * overwriting anything: derived files are marked `derived: true` and are meant
 * to be reviewed/edited before G2. Evidence artifacts (TEST/TEAM-REVIEW/SUMMARY)
 * are never generated here — they must come from actual work.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseTeamTasks } from './tasks.ts'

export interface PrepareInput {
  projectRoot: string
  openspecRoot: string
  changeId: string
  primaryProject: string
}

export interface PrepareResult {
  written: string[]
  skipped: string[]
  warnings: string[]
}

const read = async (path: string): Promise<string | undefined> =>
  readFile(path, 'utf8').catch(() => undefined)

const section = (content: string | undefined, heading: string, fallback: string): string => {
  if (content === undefined) return fallback
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`${escaped}\\s*\\n+([\\s\\S]*?)(?=\\n## |$)`).exec(content)
  return match?.[1]?.trim() || fallback
}

const deriveTasks = (tasksMd: string | undefined, project: string, warnings: string[]): unknown => {
  const tasks: Array<Record<string, unknown>> = []
  const lines = (tasksMd ?? '').split('\n')
  let index = 0
  for (const line of lines) {
    const match = /^\s*[-*]\s+\[[ xX]\]\s+(.+)$/.exec(line)
    if (match?.[1] === undefined) continue
    index += 1
    const raw = match[1].trim()
    const comment = /<!--([\s\S]*?)-->/.exec(line)?.[1] ?? ''
    const meta = (name: string): string | undefined => {
      const found = new RegExp(`(?:^|\\s)${name}:\\s*(.*?)(?=\\s+[a-zA-Z]+:|$)`).exec(comment)
      return found?.[1]?.trim()
    }
    const role = meta('role') ?? 'backend-dev'
    if (meta('role') === undefined) warnings.push(`t${index} 未声明 role，按 backend-dev 派生`)
    const writes = (meta('writes') ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '')
    const dependsOn = (meta('depends') ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '')
    tasks.push({
      id: meta('id') ?? `t${index}`,
      title: raw.replace(/<!--[\s\S]*?-->/g, '').trim(),
      role,
      project: meta('project') ?? project,
      writes,
      dependsOn,
      acceptance: meta('accepts') ?? meta('acceptance') ?? raw.replace(/<!--[\s\S]*?-->/g, '').trim(),
    })
  }
  return { derived: true, source: 'tasks.md', tasks }
}

export async function prepareTeamArtifacts(input: PrepareInput): Promise<PrepareResult> {
  const dir = join(input.projectRoot, input.openspecRoot, 'changes', input.changeId)
  await mkdir(dir, { recursive: true })
  const written: string[] = []
  const skipped: string[] = []
  const warnings: string[] = []

  const proposal = await read(join(dir, 'proposal.md'))
  const design = await read(join(dir, 'design.md'))
  const tasksMd = await read(join(dir, 'tasks.md'))

  const writeIfMissing = async (name: string, content: string): Promise<void> => {
    if ((await read(join(dir, name))) !== undefined) {
      skipped.push(name)
      return
    }
    await writeFile(join(dir, name), content, 'utf8')
    written.push(name)
  }

  await writeIfMissing(
    'REQ.md',
    [
      `# REQ — ${input.changeId}`,
      '',
      '<!-- derived: true source: proposal.md -->',
      '',
      '## 目标',
      section(proposal, '## Why', '_待评估_'),
      '',
      '## 边界与禁止项',
      '_待评估_',
      '',
      '## 验收判据',
      '_待评估_',
      '',
      '## 假设与开放问题',
      '_待评估_',
    ].join('\n'),
  )

  await writeIfMissing(
    'PLAN.md',
    [
      `# PLAN — ${input.changeId}`,
      '',
      '<!-- derived: true source: design.md -->',
      '',
      '## 方案',
      section(design, '## 方案', design ?? '_待评估_'),
      '',
      '## 目标矩阵',
      `- ${input.primaryProject} @ main`,
      '',
      '## 依赖与波次',
      '_待评估_',
      '',
      '## 风险与回滚',
      section(design, '## 风险', '_待评估_'),
    ].join('\n'),
  )

  const tasksPath = join(dir, 'TASKS.json')
  if ((await read(tasksPath)) !== undefined) {
    skipped.push('TASKS.json')
  } else {
    const derived = deriveTasks(tasksMd, input.primaryProject, warnings)
    const parsed = parseTeamTasks(JSON.stringify(derived))
    await writeFile(tasksPath, `${JSON.stringify({ ...(derived as object), tasks: parsed }, null, 2)}\n`, 'utf8')
    written.push('TASKS.json')
  }

  return { written, skipped, warnings }
}
