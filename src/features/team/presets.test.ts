import { describe, expect, it } from 'vitest'
import { assertRolePresets, missingRolePresets, presetForRole } from './presets.ts'

describe('role presets', () => {
  it('maps read-only and workspace-write roles to their buckets', () => {
    const config = { readonlyPreset: 'team-readonly', workspacePreset: 'team-write' }
    expect(presetForRole('reviewer', config)).toBe('team-readonly')
    expect(presetForRole('requirement-evaluator', config)).toBe('team-readonly')
    expect(presetForRole('backend-dev', config)).toBe('team-write')
    expect(presetForRole('integration-tester', config)).toBe('team-write')
  })

  it('lets a per-role override win', () => {
    expect(
      presetForRole('reviewer', { readonlyPreset: 'team-readonly', rolePresets: { reviewer: 'strict-review' } }),
    ).toBe('strict-review')
  })

  it('reports missing presets only when required', () => {
    expect(missingRolePresets(['reviewer', 'backend-dev'], {}, true)).toEqual([
      'reviewer（read-only）缺 agentPreset',
      'backend-dev（workspace-write）缺 agentPreset',
    ])
    expect(missingRolePresets(['reviewer'], {}, false)).toEqual([])
    expect(
      assertRolePresets({
        tasks: [{ role: 'reviewer' }, { role: 'backend-dev' }],
        config: { readonlyPreset: 'r', workspacePreset: 'w' },
        required: true,
      }),
    ).toEqual([])
  })
})
