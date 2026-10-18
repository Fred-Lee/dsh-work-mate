import { describe, expect, it } from 'vitest'
import { parseRoleModels } from './models.ts'

describe('role model overrides', () => {
  it('parses a per-role map', () => {
    const result = parseRoleModels(
      JSON.stringify({
        reviewer: { provider: 'esp-xkw', model: 'deepseek-v4.1-flash' },
        'backend-dev': { reasoningEffort: 'high' },
      }),
    )
    expect(result.errors).toEqual([])
    expect(result.models.reviewer).toEqual({ provider: 'esp-xkw', model: 'deepseek-v4.1-flash' })
    expect(result.models['backend-dev']).toEqual({ reasoningEffort: 'high' })
  })

  it('treats empty config as inherit', () => {
    expect(parseRoleModels('')).toEqual({ models: {}, errors: [] })
    expect(parseRoleModels(undefined)).toEqual({ models: {}, errors: [] })
  })

  it('reports invalid JSON, unknown roles and empty options', () => {
    expect(parseRoleModels('{oops').errors[0]).toContain('JSON')
    expect(parseRoleModels('{"wizard":{"model":"x"}}').errors[0]).toContain('未知角色')
    expect(parseRoleModels('{"reviewer":{}}').errors[0]).toContain('没有 provider/model')
  })
})
