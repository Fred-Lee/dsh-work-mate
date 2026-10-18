/**
 * Run summary (change `autonomous-agent-team`, T4-4.3). `SUMMARY.md` is the
 * human-readable settlement of one Run: terminal status, per-task outcome and
 * evidence, and unresolved blockers. It never upgrades a failed task to green.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { TeamRun, TeamTaskRecord } from './types.ts'

const escapeCell = (value: string): string => value.replace(/\|/g, '\\|').replace(/\n/g, ' ')

const evidenceFor = (run: TeamRun, task: TeamTaskRecord): string => {
  const dispatch = [...(run.dispatches ?? [])].reverse().find((entry) => entry.taskId === task.id)
  if (dispatch === undefined) return '—'
  const parts = [dispatch.reportPath, dispatch.outcome, dispatch.filesModified?.join(', ')].filter(
    (part): part is string => part !== undefined && part.trim() !== '',
  )
  return parts.length > 0 ? parts.join('；') : `dispatch ${dispatch.status}`
}

export function buildTeamSummary(run: TeamRun): string {
  const blockers = run.tasks.filter((task) => task.status === 'blocked' || task.status === 'failed')
  return [
    `# SUMMARY — ${run.proposalId}`,
    '',
    '## Run',
    `- Run：${run.id}`,
    `- 模板：${run.template}`,
    `- 状态：${run.status}`,
    `- 预算：parallel=${run.budget.maxParallel} attempts=${run.budget.maxAttempts} dispatches=${run.budget.maxDispatches}`,
    '',
    '## 逐任务结果',
    '| Task | 角色 | 状态 | 尝试 | 证据 |',
    '| --- | --- | --- | --- | --- |',
    ...run.tasks.map(
      (task) =>
        `| ${escapeCell(task.id)} | ${task.role} | ${task.status} | ${task.attempts} | ${escapeCell(evidenceFor(run, task))} |`,
    ),
    '',
    '## 未解阻塞',
    ...(blockers.length > 0
      ? blockers.map((task) => `- ${task.id}（${task.status}）：${evidenceFor(run, task)}`)
      : ['- 无']),
    '',
    '## 终态',
    `- ${run.status}`,
  ].join('\n')
}

export interface WriteSummaryInput {
  projectRoot: string
  openspecRoot: string
  changeId: string
  run: TeamRun
}

/** Write `<root>/<openspecRoot>/changes/<id>/SUMMARY.md`; returns its path. */
export async function writeTeamSummary(input: WriteSummaryInput): Promise<string> {
  const path = join(input.projectRoot, input.openspecRoot, 'changes', input.changeId, 'SUMMARY.md')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${buildTeamSummary(input.run)}\n`, 'utf8')
  return path
}
