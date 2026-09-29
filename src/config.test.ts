import { describe, expect, it } from 'vitest'
import { CONFIG_DEFAULTS, resolveConfig } from './config.ts'

describe('resolveConfig', () => {
  it('fills every knob with its documented default', () => {
    expect(resolveConfig()).toEqual({
      workmateHome: 'workmate',
      maxConcurrent: 3,
      gitnexusEnabled: true,
      weknoraBaseUrl: '',
      openspecRoot: 'openspec',
      projectRoot: '',
      qualitySyncEnabled: true,
    })
  })

  it('exposes the defaults object with the same values', () => {
    expect(CONFIG_DEFAULTS).toEqual(resolveConfig())
  })

  it('keeps explicit overrides', () => {
    expect(resolveConfig({ maxConcurrent: 5, workmateHome: 'wm-test' })).toMatchObject({
      maxConcurrent: 5,
      workmateHome: 'wm-test',
    })
  })

  it('does not let an explicit undefined shadow a default', () => {
    expect(resolveConfig({ maxConcurrent: undefined, weknoraBaseUrl: undefined })).toEqual(
      resolveConfig(),
    )
  })
})
