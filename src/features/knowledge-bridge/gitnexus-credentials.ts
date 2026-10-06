/**
 * Gateway credential plumbing (changes `inject-api-key-env`, `fail-fast-wiki-credentials`).
 *
 * The key must survive "the harness was started from a shell that never saw the
 * export". Observed reality: the harness process had neither `ESP_XKW_KEY` nor
 * `GITNEXUS_API_KEY`, so every spawned `gitnexus wiki` died with "No LLM API key
 * found" — while the previous run's wiki was still on disk and looked like success.
 *
 * Resolution order (first hit wins):
 *   1. `GITNEXUS_API_KEY` in the environment (GitNexus's own name)
 *   2. the configured variable (`Config.gitnexusApiKeyFromEnv`, e.g. `ESP_XKW_KEY`)
 *   3. the macOS Keychain item (`Config.gitnexusApiKeyKeychainService`) — no shell involved
 *   4. `~/.gitnexus/config.json` `apiKey`
 *
 * Two rules: the key is only ever injected into a child process (never written to a
 * config file), and it is never echoed — `describeGitnexusCredentials` reports a
 * SOURCE NAME only.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

export type CredentialSource =
  | 'GITNEXUS_API_KEY'
  | 'OPENAI_API_KEY'
  | 'config-env'
  | 'keychain'
  | 'config.json'
  | 'none'

export interface CredentialDescription {
  source: CredentialSource
  /** True when the resolved value has to be injected as GITNEXUS_API_KEY. */
  mapped: boolean
  note?: string
}

export interface CredentialOptions {
  env: NodeJS.ProcessEnv
  /** `Config.gitnexusApiKeyFromEnv`. */
  fromEnvName?: string
  /** `Config.gitnexusApiKeyKeychainService` (macOS `security` service name). */
  keychainService?: string
  /** GitNexus's own config file, checked last. */
  configPath?: string
  /** Injection seams for tests. */
  readKeychain?: (service: string) => string | undefined
  readConfig?: (path: string) => string | undefined
}

const present = (value: string | undefined): value is string => typeof value === 'string' && value !== ''

/** macOS Keychain lookup; undefined on any failure (missing item, no tool, locked). */
export function readKeychainSecret(service: string): string | undefined {
  try {
    const output = execFileSync(
      'security',
      ['find-generic-password', '-s', service, '-a', process.env['USER'] ?? '', '-w'],
      { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    const key = output.trim()
    return key === '' ? undefined : key
  } catch {
    return undefined
  }
}

function readConfigKey(path: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { apiKey?: unknown }
    return typeof parsed.apiKey === 'string' && parsed.apiKey !== '' ? parsed.apiKey : undefined
  } catch {
    return undefined
  }
}

/** Resolve the key value plus its source. The source never contains the value. */
export function resolveGitnexusApiKey(options: CredentialOptions): { key?: string; source: CredentialSource } {
  const { env, fromEnvName, keychainService, configPath } = options

  if (present(env['GITNEXUS_API_KEY'])) return { key: env['GITNEXUS_API_KEY'], source: 'GITNEXUS_API_KEY' }
  if (present(fromEnvName) && present(env[fromEnvName])) return { key: env[fromEnvName], source: 'config-env' }
  if (present(keychainService)) {
    const key = (options.readKeychain ?? readKeychainSecret)(keychainService)
    if (present(key)) return { key, source: 'keychain' }
  }
  if (present(env['OPENAI_API_KEY'])) return { key: env['OPENAI_API_KEY'], source: 'OPENAI_API_KEY' }
  if (present(configPath)) {
    const key = (options.readConfig ?? readConfigKey)(configPath)
    if (present(key)) return { key, source: 'config.json' }
  }
  return { source: 'none' }
}

/** Source-only view, safe to log or return to a model. */
export function describeGitnexusCredentials(options: CredentialOptions): CredentialDescription {
  const resolved = resolveGitnexusApiKey(options)
  if (resolved.source === 'none') {
    return {
      source: 'none',
      mapped: false,
      note:
        '未发现 GitNexus 凭据：把 key 放进钥匙串（security add-generic-password -s <服务名>）并设置 ' +
        'Config.gitnexusApiKeyKeychainService，或 export 环境变量（ESP_XKW_KEY / GITNEXUS_API_KEY），' +
        '或临时写进 ~/.gitnexus/config.json',
    }
  }
  return { source: resolved.source, mapped: resolved.source !== 'GITNEXUS_API_KEY' }
}

/** Child environment for a spawned `gitnexus`: inject the key under GitNexus's own name. */
export function withResolvedApiKey(
  env: NodeJS.ProcessEnv,
  options: Omit<CredentialOptions, 'env'>,
): NodeJS.ProcessEnv {
  if (present(env['GITNEXUS_API_KEY'])) return env
  const { key } = resolveGitnexusApiKey({ ...options, env })
  return present(key) ? { ...env, GITNEXUS_API_KEY: key } : env
}

/** Env-only variant (changes before Keychain support); kept for its focused tests. */
export function withGitnexusApiKey(env: NodeJS.ProcessEnv, fromEnvName?: string): NodeJS.ProcessEnv {
  return withResolvedApiKey(env, { ...(fromEnvName !== undefined ? { fromEnvName } : {}) })
}
