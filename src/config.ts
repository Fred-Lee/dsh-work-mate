/**
 * Plugin configuration (design D2/D4): a plain TypeScript interface, the shape
 * verified against the real host by the Helmsman line — the host passes the
 * profile's `config` object straight into `apply`, no Schemastery schema needed
 * at the plugin boundary.
 */

export interface Config {
  /**
   * Directory name (under the DSH home) holding WorkMate state.
   * @default 'workmate'
   */
  workmateHome?: string
  /** Upper bound for swarm parallel agents at archive time. @default 3 */
  maxConcurrent?: number
  /** Master switch for the GitNexus bridge (M3). @default true */
  gitnexusEnabled?: boolean
  /** WeKnora REST base URL; empty disables knowledge search (M3). @default '' */
  weknoraBaseUrl?: string
  /** OpenSpec root relative to the target project. @default 'openspec' */
  openspecRoot?: string
}

export type ResolvedConfig = Required<Config>

export const CONFIG_DEFAULTS: ResolvedConfig = {
  workmateHome: 'workmate',
  maxConcurrent: 3,
  gitnexusEnabled: true,
  weknoraBaseUrl: '',
  openspecRoot: 'openspec',
}

/**
 * Merge user config over the defaults. Keys explicitly set to `undefined`
 * must NOT shadow a default (they mean "unset"), hence the filtering.
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const resolved: ResolvedConfig = { ...CONFIG_DEFAULTS }
  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined) {
      ;(resolved as Record<string, unknown>)[key] = value
    }
  }
  return resolved
}
