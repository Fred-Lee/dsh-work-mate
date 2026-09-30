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
  /**
   * Default project root for openspec-directory generation and Git scanning.
   * Empty disables project-side actions unless the caller passes projectRoot
   * explicitly. @default ''
   */
  projectRoot?: string
  /**
   * Sync quality assets (openspec constraints/schema, claude rules/agents/
   * hooks) into the target project on proposal creation. @default true
   */
  qualitySyncEnabled?: boolean
  /** Port allocation base for worktree .env injection. @default 3000 */
  basePort?: number
  /** Port step between worktree segments. @default 10 */
  portStep?: number
  /** Files copied from the main checkout into each new worktree. @default ['.env', '.env.local'] */
  copyFiles?: string[]
  /** Package manager run inside a new worktree. @default 'pnpm' */
  packageManager?: string
  /** Enable the WeKnora Wiki association flow. @default true */
  weknoraEnabled?: boolean
  /** Default WeKnora knowledge base id; empty = unconfigured. @default '' */
  weknoraKbId?: string
  /** Fail implementing→merging when declared wiki pages are missing. @default false */
  weknoraWikiRequired?: boolean
}

export type ResolvedConfig = Required<Config>

export const CONFIG_DEFAULTS: ResolvedConfig = {
  workmateHome: 'workmate',
  maxConcurrent: 3,
  gitnexusEnabled: true,
  weknoraBaseUrl: '',
  openspecRoot: 'openspec',
  projectRoot: '',
  qualitySyncEnabled: true,
  basePort: 3000,
  portStep: 10,
  copyFiles: ['.env', '.env.local'],
  packageManager: 'pnpm',
  weknoraEnabled: true,
  weknoraKbId: '',
  weknoraWikiRequired: false,
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
