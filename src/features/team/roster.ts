/**
 * Role roster and templates (change `autonomous-agent-team`, design D1/D9).
 *
 * Permissions are part of the contract, not a prompt suggestion: evaluators and
 * reviewers are read-only, implementers testers and the coordinator may write
 * inside the workspace. `danger-full-access` is deliberately absent.
 */
import type { TeamArtifact, TeamRole, TeamTemplate } from './types.ts'

export interface RoleContract {
  role: TeamRole
  label: string
  permission: 'read-only' | 'workspace-write'
  /** Artifacts this role owns; empty for implementation roles. */
  artifacts: TeamArtifact[]
  canModifyCode: boolean
  responsibility: string
  forbidden: string[]
}

export const ROLE_CONTRACTS: Record<TeamRole, RoleContract> = {
  coordinator: {
    role: 'coordinator',
    label: '协调器',
    permission: 'workspace-write',
    artifacts: ['SUMMARY.md'],
    canModifyCode: false,
    responsibility: '建 Run、拆 DAG、派发波次、收件箱、结算与汇总',
    forbidden: ['不写业务代码', '不代替人批准 merging/archiving'],
  },
  'requirement-evaluator': {
    role: 'requirement-evaluator',
    label: '需求评估',
    permission: 'read-only',
    artifacts: ['REQ.md'],
    canModifyCode: false,
    responsibility: '澄清目标、边界、禁止项与验收判据',
    forbidden: ['不写实现', '不替用户做产品取舍'],
  },
  'solution-evaluator': {
    role: 'solution-evaluator',
    label: '技术方案评估',
    permission: 'read-only',
    artifacts: ['PLAN.md', 'TASKS.json'],
    canModifyCode: false,
    responsibility: '方案、依赖 DAG、风险与回滚；把方案映射到 target 矩阵',
    forbidden: ['不写实现', '不重写已批准的需求'],
  },
  'frontend-dev': {
    role: 'frontend-dev',
    label: '前端开发',
    permission: 'workspace-write',
    artifacts: [],
    canModifyCode: true,
    responsibility: '按 target 的写域实现前端改动',
    forbidden: ['不改未声明的后端/基础设施', '不自行提权'],
  },
  'backend-dev': {
    role: 'backend-dev',
    label: '后端开发',
    permission: 'workspace-write',
    artifacts: [],
    canModifyCode: true,
    responsibility: '按 target 的写域实现服务端改动',
    forbidden: ['不改未声明的前端/基础设施', '不自行提权'],
  },
  'integration-tester': {
    role: 'integration-tester',
    label: '集成测试',
    permission: 'workspace-write',
    artifacts: ['TEST.md'],
    canModifyCode: false,
    responsibility: '跨仓契约/E2E/回归，产出可复核的测试证据',
    forbidden: ['不改生产源码', '不把改被测代码当作测试通过'],
  },
  reviewer: {
    role: 'reviewer',
    label: '独立审查',
    permission: 'read-only',
    artifacts: ['TEAM-REVIEW.md'],
    canModifyCode: false,
    responsibility: '独立评审方案与实现，给出 severity/file/line/status',
    forbidden: ['不审自己写的实现', '不改代码'],
  },
}

const FULL_ROLES: TeamRole[] = [
  'coordinator',
  'requirement-evaluator',
  'solution-evaluator',
  'frontend-dev',
  'backend-dev',
  'integration-tester',
  'reviewer',
]

export interface TeamTemplateContract {
  template: TeamTemplate
  label: string
  roles: TeamRole[]
  /** G2 human confirmation is required by default. */
  g2Required: boolean
  description: string
}

export const TEAM_TEMPLATE_CONTRACTS: Record<TeamTemplate, TeamTemplateContract> = {
  'requirement-full': {
    template: 'requirement-full',
    label: '需求全流程',
    roles: [...FULL_ROLES],
    g2Required: true,
    description: '需求 → 方案 → 前后端 → 集成测试 → 独立审查',
  },
  'bug-fix': {
    template: 'bug-fix',
    label: 'Bug 修复',
    roles: ['coordinator', 'solution-evaluator', 'frontend-dev', 'backend-dev', 'integration-tester', 'reviewer'],
    g2Required: true,
    description: '方案 → 实现 → 测试 → 审查（不重跑需求评估）',
  },
  research: {
    template: 'research',
    label: '调研',
    roles: ['coordinator', 'requirement-evaluator', 'reviewer'],
    g2Required: false,
    description: '需求澄清 + 只读调研 + 审查',
  },
  delivery: {
    template: 'delivery',
    label: '交付',
    roles: ['coordinator', 'solution-evaluator', 'frontend-dev', 'backend-dev', 'integration-tester', 'reviewer'],
    g2Required: true,
    description: '方案 → 实现 → 测试 → 文档/交付',
  },
}

export function rolesFor(template: TeamTemplate): TeamRole[] {
  return [...TEAM_TEMPLATE_CONTRACTS[template].roles]
}

export function contractFor(role: TeamRole): RoleContract {
  return ROLE_CONTRACTS[role]
}
