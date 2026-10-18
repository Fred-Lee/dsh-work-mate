/**
 * Role-level model overrides (change `autonomous-agent-team`, T3-3.7).
 *
 * Default is "inherit the parent session model"; a config JSON map may pin a
 * provider/model for specific roles. Parsing is strict so a typo fails the run
 * instead of silently dispatching to the wrong model.
 */
import { isTeamRole, type TeamRole } from './types.ts'

export interface RoleModelOption {
  provider?: string
  model?: string
  reasoningEffort?: string
}

export interface RoleModelsResult {
  models: Partial<Record<TeamRole, RoleModelOption>>
  errors: string[]
}

export function parseRoleModels(raw: string | undefined): RoleModelsResult {
  if (raw === undefined || raw.trim() === '') return { models: {}, errors: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { models: {}, errors: ['teamRoleModels 不是合法 JSON'] }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { models: {}, errors: ['teamRoleModels 必须是对象：{ "reviewer": { "model": "..." } }'] }
  }
  const models: Partial<Record<TeamRole, RoleModelOption>> = {}
  const errors: string[] = []
  for (const [role, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isTeamRole(role)) {
      errors.push(`未知角色：${role}`)
      continue
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${role} 的模型配置必须是对象`)
      continue
    }
    const record = value as Record<string, unknown>
    const option: RoleModelOption = {}
    for (const key of ['provider', 'model', 'reasoningEffort'] as const) {
      const entry = record[key]
      if (entry === undefined) continue
      if (typeof entry !== 'string' || entry.trim() === '') errors.push(`${role}.${key} 必须是非空字符串`)
      else option[key] = entry.trim()
    }
    if (option.provider === undefined && option.model === undefined && option.reasoningEffort === undefined) {
      errors.push(`${role} 没有 provider/model/reasoningEffort`)
      continue
    }
    models[role] = option
  }
  return { models, errors }
}
