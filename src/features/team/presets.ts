/**
 * Role permission presets (change `autonomous-agent-team`, T3-3.6).
 *
 * The prompt is not a permission boundary; the host agent preset is. Read-only
 * roles must map to a read-only preset, implementation/test/coordinator roles to
 * a workspace-write preset. `requireRolePresets` refuses a dispatch when the
 * matching preset is missing instead of inheriting the parent's scope silently.
 */
import { contractFor } from './roster.ts'
import type { TeamRole, TeamTaskSpec } from './types.ts'

export interface RolePresetConfig {
  readonlyPreset?: string
  workspacePreset?: string
  /** Optional per-role override, higher priority than the permission bucket. */
  rolePresets?: Partial<Record<TeamRole, string>>
}

export function presetForRole(role: TeamRole, config: RolePresetConfig): string | undefined {
  const override = config.rolePresets?.[role]
  if (override !== undefined && override.trim() !== '') return override.trim()
  const contract = contractFor(role)
  const preset = contract.permission === 'read-only' ? config.readonlyPreset : config.workspacePreset
  return preset !== undefined && preset.trim() !== '' ? preset.trim() : undefined
}

export function missingRolePresets(
  roles: readonly TeamRole[],
  config: RolePresetConfig,
  required: boolean,
): string[] {
  if (!required) return []
  return [...new Set(roles)]
    .filter((role) => presetForRole(role, config) === undefined)
    .map((role) => `${role}（${contractFor(role).permission}）缺 agentPreset`)
}

export interface PresetCheckInput {
  tasks: readonly Pick<TeamTaskSpec, 'role'>[]
  config: RolePresetConfig
  required: boolean
}

export function assertRolePresets(input: PresetCheckInput): string[] {
  return missingRolePresets(
    input.tasks.map((task) => task.role),
    input.config,
    input.required,
  )
}
