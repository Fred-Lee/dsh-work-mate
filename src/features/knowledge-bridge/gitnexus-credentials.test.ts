import { describe, expect, it } from 'vitest'
import { describeGitnexusCredentials, withGitnexusApiKey } from './gitnexus-credentials.ts'

describe('gateway key plumbing (inject-api-key-env)', () => {
  it('maps the configured variable onto GITNEXUS_API_KEY for the child process', () => {
    const child = withGitnexusApiKey({ ESP_XKW_KEY: 'sk-secret' }, 'ESP_XKW_KEY')

    expect(child['GITNEXUS_API_KEY']).toBe('sk-secret')
    expect(child['ESP_XKW_KEY']).toBe('sk-secret')
  })

  it('never overwrites an explicitly set GITNEXUS_API_KEY', () => {
    const child = withGitnexusApiKey({ ESP_XKW_KEY: 'sk-secret', GITNEXUS_API_KEY: 'sk-explicit' }, 'ESP_XKW_KEY')

    expect(child['GITNEXUS_API_KEY']).toBe('sk-explicit')
  })

  it('does nothing without a configured name or value', () => {
    expect(withGitnexusApiKey({ ESP_XKW_KEY: 'sk-secret' }, '').GITNEXUS_API_KEY).toBeUndefined()
    expect(withGitnexusApiKey({}, 'ESP_XKW_KEY').GITNEXUS_API_KEY).toBeUndefined()
  })

  it('reports the source name only — never the value', () => {
    const fromGitnexus = describeGitnexusCredentials({ env: { GITNEXUS_API_KEY: 'sk-secret' } })
    expect(fromGitnexus).toEqual({ source: 'GITNEXUS_API_KEY', mapped: false })
    expect(JSON.stringify(fromGitnexus)).not.toContain('sk-secret')

    const mapped = describeGitnexusCredentials({ env: { ESP_XKW_KEY: 'sk-secret' }, fromEnvName: 'ESP_XKW_KEY' })
    expect(mapped).toMatchObject({ source: 'config-env', mapped: true })
    expect(JSON.stringify(mapped)).not.toContain('sk-secret')

    // An explicit GITNEXUS_API_KEY wins over the mapped variable, matching exec behaviour.
    const both = describeGitnexusCredentials({
      env: { GITNEXUS_API_KEY: 'sk-a', OPENAI_API_KEY: 'sk-b', ESP_XKW_KEY: 'sk-c' },
      fromEnvName: 'ESP_XKW_KEY',
    })
    expect(both.source).toBe('GITNEXUS_API_KEY')
  })

  it('falls back to config.json presence and otherwise says none with a hint', () => {
    const loaded = describeGitnexusCredentials({
      env: {},
      configPath: new URL('./__fixtures__/gitnexus-config.json', import.meta.url).pathname,
    })
    expect(loaded.source).toBe('config.json')

    const missing = describeGitnexusCredentials({ env: {}, configPath: '/nonexistent/config.json' })
    expect(missing.source).toBe('none')
    expect(missing.note).toContain('ESP_XKW_KEY')
  })

  it('treats OPENAI_API_KEY as a source when nothing else is set', () => {
    expect(describeGitnexusCredentials({ env: { OPENAI_API_KEY: 'sk-x' } }).source).toBe('OPENAI_API_KEY')
  })
})
