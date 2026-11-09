import { describe, expect, it } from 'vitest'
import { CONFIG_DEFAULTS, Config, resolveConfig } from './config.ts'

describe('resolveConfig', () => {
  it('fills every knob with its documented default', () => {
    expect(resolveConfig()).toEqual({
      workmateHome: 'workmate',
      gitnexusEnabled: true,
      weknoraBaseUrl: '',
      writeConflictGate: 'block',
      openspecTargets: 'primary',
      openspecRoot: 'openspec',
      projectRoot: '',
      qualitySyncEnabled: true,
      claudeAssetsEnabled: true,
      basePort: 3000,
      portStep: 10,
      approvalsRequired: ['merging'],
      allowAgentApproval: false,
      reviewBlockingSeverities: ['CRIT'],
      planDriftGate: false,
      allowAgentForceArchive: false,
      reviewerIndependence: 'warn',
      reviewEvidenceGate: 'warn',
      teamEvidenceGate: 'block',
      taskFile: '',
      executorRepos: [],
      executorRepo: '',
      superagentEndpoint: 'http://127.0.0.1:3080',
      superagentEndpoints: [],
      superagentTimeoutMs: 5000,
      superagentPollSeconds: 5,
      lifecycleMainBranch: 'main',
      decisionEnabled: false,
      decisionProvider: 'agent',
      decisionLlmProvider: '',
      decisionModel: '',
      decisionSamples: 1,
      decisionTimeoutMs: 4000,
      decisionMaxTokens: 1024,
      decisionActThreshold: 0.8,
      decisionReviewThreshold: 0.6,
      highRiskExtraGates: ['implementing'],
      taskJudgementGate: false,
      reviewGradeMax: 5,
      decisionSystemoneUrl: 'http://127.0.0.1:11434',
      decisionSystemoneModel: '',
      decisionSystemoneKeepAlive: '60s',
      decisionSystemoneTimeoutMs: 60000,
      decisionCacheEnabled: true,
      decisionCacheMax: 500,
      gitnexusWikiLang: '',
      gitnexusWikiTimeoutMs: 900000,
      gitnexusSseProxyEnabled: false,
      gitnexusSseProxyPort: 8787,
      gitnexusSseProxyUpstream: '',
      gitnexusApiKeyFromEnv: '',
      gitnexusApiKeyKeychainService: '',
      wikiVaultPath: '',
      wikiVaultSubdir: 'WorkMate',
      wikiVaultGitCommit: false,
      wikiVaultEmbeddingModel: '',
      wikiVaultOllamaUrl: 'http://127.0.0.1:11434',
      wikiVaultEmbeddingCache: '',
      wikiVaultClassifyMax: 20,
      wikiVaultRerank: false,
      wikiVaultAutoExport: true,
      weknoraEnabled: true,
      weknoraKbId: '',
      weknoraWikiRequired: false,
    })
  })

  it('exposes the defaults object with the same values', () => {
    expect(CONFIG_DEFAULTS).toEqual(resolveConfig())
  })

  it('keeps explicit overrides', () => {
    expect(resolveConfig({ workmateHome: 'wm-test', basePort: 3010 })).toMatchObject({
      workmateHome: 'wm-test',
    })
  })

  // 多仓库执行器（change `support-multi-repo-executors`）：
  // 新字段必须是"显式配置即生效"，旧单值字段继续可用（兼容特例）。
  it('accepts multi-repo and multi-endpoint overrides', () => {
    expect(
      resolveConfig({
        executorRepos: ['/repo/a', '/repo/b'],
        superagentEndpoints: ['http://127.0.0.1:3080', 'http://127.0.0.1:3081'],
      }),
    ).toMatchObject({
      executorRepos: ['/repo/a', '/repo/b'],
      superagentEndpoints: ['http://127.0.0.1:3080', 'http://127.0.0.1:3081'],
      // 未覆盖的兼容单值字段仍取默认值。
      executorRepo: '',
      superagentEndpoint: 'http://127.0.0.1:3080',
    })
  })

  it('does not let an explicit undefined shadow a default', () => {
    expect(resolveConfig({ basePort: undefined, weknoraBaseUrl: undefined })).toEqual(
      resolveConfig(),
    )
  })
})

/**
 * The host collects a plugin's config schema by identity-checking the runtime
 * `Config` export — see packages/boot/app-boot/src/config-schema/native.ts.
 * These three conditions are copied verbatim from that predicate, so a change in
 * shape (or dropping the runtime export) fails here instead of silently
 * downgrading the plugin to "no validation, no config UI".
 */
describe('host config-schema contract', () => {
  function isNativeConfigSchema(value: unknown): boolean {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false
    const meta: unknown = Reflect.get(value, 'meta')
    return (
      Reflect.get(value, Symbol.for('schemastery')) === true &&
      typeof Reflect.get(value, 'type') === 'string' &&
      meta !== null &&
      typeof meta === 'object'
    )
  }

  it('exports a runtime value the host recognises as a native schema', () => {
    expect(isNativeConfigSchema(Config)).toBe(true)
  })

  it('applies the same values as CONFIG_DEFAULTS through the schema alone', () => {
    const parsed = (Config as unknown as (value: unknown) => Record<string, unknown>)({})
    for (const [key, value] of Object.entries(CONFIG_DEFAULTS)) {
      expect(parsed[key]).toEqual(value)
    }
  })

  it('declares every documented knob as a schema field', () => {
    const dict = (Config as unknown as { dict?: Record<string, unknown> }).dict ?? {}
    expect(Object.keys(dict).sort()).toEqual(Object.keys(CONFIG_DEFAULTS).sort())
  })

  it('actually validates (the point of exporting a runtime schema)', () => {
    const validate = Config as unknown as (value: unknown) => Record<string, unknown>
    expect(() => validate({ basePort: 'not-a-number' })).toThrow(/expected number/)
    expect(() => validate({ weknoraBaseUrl: 42 })).toThrow(/expected string/)
  })
})
