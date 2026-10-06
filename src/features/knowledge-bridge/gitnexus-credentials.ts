/**
 * Gateway credential plumbing (change `inject-api-key-env`).
 *
 * The gateway key lives in the macOS Keychain and reaches GitNexus through an
 * environment variable (`ESP_XKW_KEY` exported by the shell). GitNexus itself only
 * reads `GITNEXUS_API_KEY` / `OPENAI_API_KEY`, so WorkMate maps the configured
 * variable for the child process it spawns.
 *
 * Two rules this module exists to enforce:
 *   1. never write the key into a config file — mapping is per-child-process only;
 *   2. never echo it — `describeGitnexusCredentials` answers with a SOURCE NAME only.
 */
import { readFileSync } from 'node:fs'

export type CredentialSource = 'GITNEXUS_API_KEY' | 'OPENAI_API_KEY' | 'config-env' | 'config.json' | 'none'

export interface CredentialDescription {
  source: CredentialSource
  /** True when the value came from `Config.gitnexusApiKeyFromEnv` rather than GITNEXUS_API_KEY. */
  mapped: boolean
  note?: string
}

/**
 * Child environment for `gitnexus`: map the configured variable name onto
 * `GITNEXUS_API_KEY` when (and only when) it is not already set. An explicit value
 * always wins — this never overwrites what the user set on purpose.
 */
export function withGitnexusApiKey(
  env: NodeJS.ProcessEnv,
  fromEnvName?: string,
): NodeJS.ProcessEnv {
  if (fromEnvName === undefined || fromEnvName === '') return env
  if (env['GITNEXUS_API_KEY'] !== undefined && env['GITNEXUS_API_KEY'] !== '') return env
  const mapped = env[fromEnvName]
  if (mapped === undefined || mapped === '') return env
  return { ...env, GITNEXUS_API_KEY: mapped }
}

/**
 * Report where a key would come from, without reading out the value.
 * `configPath` is GitNexus's own `~/.gitnexus/config.json`; only the presence of the
 * field is checked.
 */
export function describeGitnexusCredentials(options: {
  env: NodeJS.ProcessEnv
  configPath?: string
  fromEnvName?: string
}): CredentialDescription {
  const { env, configPath, fromEnvName } = options
  const present = (name: string): boolean => env[name] !== undefined && env[name] !== ''

  if (present('GITNEXUS_API_KEY')) return { source: 'GITNEXUS_API_KEY', mapped: false }
  if (fromEnvName !== undefined && fromEnvName !== '' && present(fromEnvName)) {
    return { source: 'config-env', mapped: true }
  }
  if (present('OPENAI_API_KEY')) return { source: 'OPENAI_API_KEY', mapped: false }
  if (configPath !== undefined) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as { apiKey?: unknown }
      if (typeof parsed.apiKey === 'string' && parsed.apiKey !== '') {
        return { source: 'config.json', mapped: false }
      }
    } catch {
      /* missing or unreadable config is simply "no credential there" */
    }
  }
  return {
    source: 'none',
    mapped: false,
    note:
      '未发现 GitNexus 凭据：把 key 放进钥匙串并 export 环境变量（例如 ESP_XKW_KEY），' +
      '或临时用 `gitnexus wiki --provider <p> --api-key <k>` 写入 ~/.gitnexus/config.json',
  }
}
