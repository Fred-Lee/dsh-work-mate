/**
 * 任务制变更的证据门（change `remove-team-executor`，从 `team/evidence.ts` 迁出）。
 *
 * 判据变了：以前是"有没有团队 Run"，现在是**变更目录里有没有 `TASKS.json`**。
 * 这与 change `adopt-superagent-openspec-source` 的分工一致——`TASKS.json` 是任务的
 * 单一事实源，谁执行它都可能（Super-agent 的 worker、人或 swarms），但**有任务就必须
 * 有测试与审查证据**。没有 `TASKS.json` 的老提案不会被这条门挡住。
 *
 * `role` 字段保留但不再参与派发；这里只用它判断"这份变更是否承诺过测试/审查"。
 */
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

export interface TaskEvidenceResult {
  /** `false` when the change has no `TASKS.json` (not task-managed). */
  managed: boolean
  ok: boolean
  errors: string[]
  /** `<!-- reviewer: <id> -->` from `TEAM-REVIEW.md`, when present. */
  reviewer?: string
}

/** 每份工件必须出现的段头；模板本身可读，人也能照着填。 */
export const REQUIRED_SECTIONS: Record<string, readonly string[]> = {
  'TEST.md': ['## 场景', '## 执行命令', '## 结果与证据', '## 覆盖缺口'],
  'TEAM-REVIEW.md': ['## 确认项', '## 疑问项', '## 建议补充项', '## CRITICAL 问题'],
}

const PLACEHOLDER = '<!-- 待填写 -->'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''
const stringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string')

/**
 * `TASKS.json` 的结构校验：id / title / project / writes / dependsOn / acceptance。
 * `role` 从必填降为可选（它现在只是展示标签）。
 */
export function validateTaskSpecs(input: unknown): { ok: boolean; errors: string[]; roles: string[] } {
  const errors: string[] = []
  const raw = isRecord(input) && Array.isArray(input['tasks']) ? input['tasks'] : input
  if (!Array.isArray(raw)) return { ok: false, errors: ['TASKS.json 必须是数组（或 {tasks: []}）'], roles: [] }
  const roles: string[] = []
  const ids = new Set<string>()
  for (const [index, entry] of raw.entries()) {
    const label = `第 ${index + 1} 项`
    if (!isRecord(entry)) {
      errors.push(`${label}不是对象`)
      continue
    }
    const id = entry['id']
    if (!nonEmpty(id)) errors.push(`${label}缺 id`)
    else if (ids.has(id)) errors.push(`重复 id: ${id}`)
    else ids.add(id)
    if (!nonEmpty(entry['title'])) errors.push(`${String(id ?? label)} 缺 title`)
    if (!nonEmpty(entry['project'])) errors.push(`${String(id ?? label)} 缺 project`)
    if (!stringArray(entry['writes'])) errors.push(`${String(id ?? label)} 的 writes 必须是字符串数组`)
    if (!stringArray(entry['dependsOn'])) errors.push(`${String(id ?? label)} 的 dependsOn 必须是字符串数组`)
    if (!nonEmpty(entry['acceptance'])) errors.push(`${String(id ?? label)} 缺 acceptance`)
    if (nonEmpty(entry['role'])) roles.push(entry['role'])
  }
  return { ok: errors.length === 0, errors, roles }
}

const readOrReport = async (path: string, label: string, errors: string[]): Promise<string | undefined> => {
  try {
    return await readFile(path, 'utf8')
  } catch {
    errors.push(`${label} 缺失`)
    return undefined
  }
}

/**
 * 检查一份变更的任务证据。
 *
 * 只要求"模板会产出的东西"：`TASKS.json` 里出现 `integration-tester` 才要 `TEST.md`，
 * 出现 `reviewer` 才要 `TEAM-REVIEW.md`。没有角色字段的变更（新写法）两份都要——
 * 因为无法从文件判断它"没打算测试"。
 */
export async function checkTaskEvidence(
  projectRoot: string,
  openspecRoot: string,
  changeId: string,
): Promise<TaskEvidenceResult> {
  const dir = join(projectRoot, openspecRoot, 'changes', changeId)
  try {
    await stat(join(dir, 'TASKS.json'))
  } catch {
    return { managed: false, ok: true, errors: [] }
  }

  const errors: string[] = []
  let reviewer: string | undefined
  let roles: string[] = []
  const tasksRaw = await readOrReport(join(dir, 'TASKS.json'), 'TASKS.json', errors)
  if (tasksRaw !== undefined) {
    try {
      const validation = validateTaskSpecs(JSON.parse(tasksRaw))
      if (!validation.ok) errors.push(`TASKS.json 校验失败：${validation.errors.join('；')}`)
      roles = validation.roles
    } catch {
      errors.push('TASKS.json 不是合法 JSON')
    }
  }

  const artifacts: Array<'TEST.md' | 'TEAM-REVIEW.md'> = []
  if (roles.length === 0 || roles.some((role) => role === 'integration-tester' || role === 'tester')) {
    artifacts.push('TEST.md')
  }
  if (roles.length === 0 || roles.some((role) => role === 'reviewer')) artifacts.push('TEAM-REVIEW.md')

  for (const artifact of artifacts) {
    const content = await readOrReport(join(dir, artifact), artifact, errors)
    if (content === undefined) continue
    for (const section of REQUIRED_SECTIONS[artifact] ?? []) {
      if (!content.includes(section)) errors.push(`${artifact} 缺「${section}」`)
    }
    if (content.includes(PLACEHOLDER)) errors.push(`${artifact} 仍是模板（${PLACEHOLDER}），没有真实证据`)
    if (artifact === 'TEAM-REVIEW.md') {
      const marker = /<!--\s*reviewer:\s*(\S+)/.exec(content)
      if (marker?.[1] === undefined) errors.push('TEAM-REVIEW.md 缺 reviewer 身份标记（<!-- reviewer: <id> -->）')
      else reviewer = marker[1]
    }
  }

  return { managed: true, ok: errors.length === 0, errors, ...(reviewer !== undefined ? { reviewer } : {}) }
}
