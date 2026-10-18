/**
 * The six team artifacts and their required sections (change
 * `autonomous-agent-team`, design D8). Templates are plain markdown so a human
 * can read the same files the panel renders.
 */
import { TEAM_ARTIFACTS, type TeamArtifact } from './types.ts'

export const REQUIRED_SECTIONS: Record<TeamArtifact, readonly string[]> = {
  'REQ.md': ['## 目标', '## 边界与禁止项', '## 验收判据', '## 假设与开放问题'],
  'PLAN.md': ['## 方案', '## 目标矩阵', '## 依赖与波次', '## 风险与回滚'],
  'TASKS.json': [],
  'TEST.md': ['## 场景', '## 执行命令', '## 结果与证据', '## 覆盖缺口'],
  'TEAM-REVIEW.md': ['## 确认项', '## 疑问项', '## 建议补充项', '## CRITICAL 问题'],
  'SUMMARY.md': ['## Run', '## 逐任务结果', '## 未解阻塞', '## 终态'],
}

export function isTeamArtifact(value: unknown): value is TeamArtifact {
  return typeof value === 'string' && (TEAM_ARTIFACTS as readonly string[]).includes(value)
}

/** A human-readable skeleton; never claims a result before anyone worked. */
export function renderTeamArtifact(artifact: TeamArtifact, title: string, runId: string): string {
  if (artifact === 'TASKS.json') {
    return JSON.stringify(
      {
        tasks: [
          {
            id: 't1',
            title: '示例任务',
            role: 'backend-dev',
            project: 'demo',
            writes: ['src/main/**'],
            dependsOn: [],
            acceptance: '可观察的验收标准',
          },
        ],
      },
      null,
      2,
    )
  }
  const sections = REQUIRED_SECTIONS[artifact]
  return [`# ${artifact.replace(/\.md$/, '')} — ${title}`, '', `> Run: ${runId}`, '', ...sections.flatMap((section) => [section, '', '<!-- 待填写 -->', ''])].join('\n')
}
