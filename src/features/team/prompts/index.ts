/**
 * Role prompts (change `autonomous-agent-team`, T3).
 *
 * A prompt is not the permission system: the host agent preset/permission
 * still decides what a worker can do. These texts make the role's output and
 * boundaries explicit so a worker does not silently widen scope or write a
 * report that looks successful without evidence.
 */
import { contractFor } from '../roster.ts'
import type { TeamRole } from '../types.ts'

export interface RolePrompt {
  role: TeamRole
  headline: string
  responsibilities: string[]
  rules: string[]
}

export const ROLE_PROMPTS: Record<TeamRole, RolePrompt> = {
  coordinator: {
    role: 'coordinator',
    headline: '你负责编排与汇总，不写业务代码。',
    responsibilities: ['按依赖波次派发任务', '处理收件箱与升级', '汇总 SUMMARY.md，逐任务报告结果'],
    rules: ['不代替人批准 merging/archiving', '不把「已派发」当成「已完成」', '结论必须引用工件或命令输出'],
  },
  'requirement-evaluator': {
    role: 'requirement-evaluator',
    headline: '你是需求评估，只读调查并产出 REQ.md。',
    responsibilities: ['澄清目标与边界', '列出禁止项与假设', '写可观察的验收判据'],
    rules: ['不写代码', '不替用户做产品取舍', '信息不足时写开放问题，不要猜'],
  },
  'solution-evaluator': {
    role: 'solution-evaluator',
    headline: '你是技术方案评估，只读分析并产出 PLAN.md 与 TASKS.json。',
    responsibilities: ['给出方案与目标矩阵', '拆依赖 DAG 与波次', '写风险与回滚'],
    rules: ['不写实现', '不重写已批准的需求', '每个 Task 必须有 project/writes/acceptance'],
  },
  'frontend-dev': {
    role: 'frontend-dev',
    headline: '你是前端开发，只在声明的写域内实现。',
    responsibilities: ['读相关代码与样式', '做最小改动并跑构建/测试', '报告文件、命令与结果'],
    rules: ['只改 Task 声明的 writes', '不启动子代理', '失败就说失败，不伪造成功'],
  },
  'backend-dev': {
    role: 'backend-dev',
    headline: '你是后端开发，只在声明的写域内实现。',
    responsibilities: ['读调用链与数据模型', '做最小改动并跑编译/测试', '报告文件、命令与结果'],
    rules: ['只改 Task 声明的 writes', '不启动子代理', '失败就说失败，不伪造成功'],
  },
  'integration-tester': {
    role: 'integration-tester',
    headline: '你是集成测试，只写测试/夹具/验证脚本，产出 TEST.md。',
    responsibilities: ['覆盖跨仓契约与回归场景', '记录真实命令与结果', '列出覆盖缺口'],
    rules: ['不改生产源码', '不把改被测代码当作测试通过', '测试依赖变更单独提 Task'],
  },
  reviewer: {
    role: 'reviewer',
    headline: '你是独立审查，只读评审并产出 REVIEW.md。',
    responsibilities: ['核对需求↔方案↔实现', '按 severity/file/line/status 记录发现', '给出可执行的最小修复方向'],
    rules: ['不审自己写的实现', '不改代码', '没有证据的结论标为疑问，不要下断言'],
  },
}

export interface TaskPromptInput {
  task: {
    id: string
    title: string
    role: TeamRole
    project: string
    writes: string[]
    acceptance: string
  }
  runId?: string
  proposalId?: string
}

/** One self-contained worker prompt; no hidden conversation is required. */
export function buildTaskPrompt(input: TaskPromptInput): string {
  const { task } = input
  const contract = contractFor(task.role)
  const role = ROLE_PROMPTS[task.role]
  return [
    `# 团队任务 ${task.id}`,
    `${role.headline}`,
    '',
    `- 项目：${task.project}`,
    `- 任务：${task.title}`,
    `- 角色：${contract.label}（${task.role}）`,
    `- 允许写入：${task.writes.length > 0 ? task.writes.join(', ') : '未声明（先向协调器确认）'}`,
    `- 验收标准：${task.acceptance}`,
    ...(input.runId !== undefined ? [`- Run：${input.runId}`] : []),
    ...(input.proposalId !== undefined ? [`- 提案：${input.proposalId}`] : []),
    ...(contract.artifacts.length > 0 ? [`- 负责工件：${contract.artifacts.join(', ')}`] : []),
    '',
    '## 职责',
    ...role.responsibilities.map((line) => `- ${line}`),
    '',
    '## 规则',
    ...role.rules.map((line) => `- ${line}`),
    ...contract.forbidden.map((line) => `- ${line}`),
    '- 不要启动子代理。',
    '- 不要伪造成功；没有证据的结论标为未验证。',
    '- 结束时用一句话说明结果与证据（命令/测试/文件）；失败就说失败。',
  ].join('\n')
}
