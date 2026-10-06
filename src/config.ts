/**
 * Plugin configuration (design D1/D2 of `adopt-dsh-native-config-and-guidance`).
 *
 * `Config` is exported TWICE on purpose: as a TypeScript interface (the host
 * contract type) and as a runtime Schemastery schema. The runtime value is what
 * the host inspects when it collects plugin config schemas — a native
 * Schemastery graph is the only shape it accepts
 * (packages/boot/app-boot/src/config-schema/native.ts: identity check on
 * `Symbol.for('schemastery')` + `type` + `meta`), and without it the plugin has
 * no config validation and no row in the configuration UI.
 *
 * `resolveConfig` stays as the in-process normalizer: schema defaults govern the
 * host boundary, while `resolveConfig` keeps the "explicit `undefined` never
 * shadows a default" rule for embedders and tests.
 */
import z from '@deepseek-ai/schemastery'

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
  /**
   * OpenSpec root relative to the target project. Applies to EVERY path that
   * touches the change directory: generation, status, lifecycle preconditions,
   * wiki.md/commits.md and the archive orchestration. @default 'openspec'
   */
  openspecRoot?: string
  /**
   * Default project root for openspec-directory generation and Git scanning.
   * Empty disables project-side actions unless the caller passes projectRoot
   * explicitly. @default ''
   */
  projectRoot?: string
  /**
   * Sync OpenSpec quality assets (constraints/schema/templates) into the target
   * project on proposal creation. @default true
   */
  qualitySyncEnabled?: boolean
  /**
   * Also distribute the Claude Code asset set (`.claude/rules`, `.claude/agents`,
   * `.claude/hooks` and the `.claude/settings.json` hook merge). Those files only
   * take effect under Claude Code (or a host running the first-party
   * `@deepseek-ai/dsh-hooks-claude-code` bridge); the DSH-native equivalent ships
   * as bundled skills. @default true
   */
  claudeAssetsEnabled?: boolean
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
  /**
   * States that require a human approval to enter (separation of duties:
   * the agent that produced the change cannot approve it). @default ['merging','archiving']
   */
  approvalsRequired?: string[]
  /** Allow the agent actor to cross gated states; weakens separation of duties. @default false */
  allowAgentApproval?: boolean
  /**
   * Severities whose unresolved findings block archiving (any of CRIT/HIGH/MED/LOW).
   * @default ['CRIT']
   */
  reviewBlockingSeverities?: string[]
  /**
   * Fail archiving when the diff touches files the plan never declared.
   * @default false (declarations are new; record and show, do not block)
   */
  planDriftGate?: boolean
  /** Enable the judgement layer (a model call inside a gate must be opt-in). @default false */
  decisionEnabled?: boolean
  /** Preferred judgement provider: agent | rules | jev. @default 'agent' */
  decisionProvider?: string
  /** LLM route for the agent provider; empty = first registered route. @default '' */
  decisionLlmProvider?: string
  /** Model for the agent provider; empty = the route's default model. @default '' */
  decisionModel?: string
  /** Samples per judgement (>1 turns the agreement ratio into the certainty proxy). @default 1 */
  decisionSamples?: number
  /** Per-judgement timeout in ms. @default 4000 */
  decisionTimeoutMs?: number
  /** certainty needed to act. @default 0.8 */
  decisionActThreshold?: number
  /** certainty needed to raise a review instead of acting. @default 0.6 */
  decisionReviewThreshold?: number
  /** States a high-risk proposal must also get human approval for. @default ['implementing'] */
  highRiskExtraGates?: string[]
  /** Block archiving on a judged-unsatisfied task (default: record only). @default false */
  taskJudgementGate?: boolean
  /** How many untagged review findings one archive run may grade. @default 5 */
  reviewGradeMax?: number
  /** Cache judgement answers so repeated questions cost nothing. @default true */
  decisionCacheEnabled?: boolean
  /** Cached judgement entries to keep (oldest evicted first). @default 500 */
  decisionCacheMax?: number
  /** Language for `gitnexus wiki` (e.g. chinese); empty = GitNexus default. @default '' */
  gitnexusWikiLang?: string
  /** Timeout for wiki generation in ms — per-module LLM work is slow. @default 900000 */
  gitnexusWikiTimeoutMs?: number
  /** Ensure the SSE-normalizing proxy before wiki generation (gateways that stream `data:{`). @default false */
  gitnexusSseProxyEnabled?: boolean
  /** Loopback port for that proxy. @default 8787 */
  gitnexusSseProxyPort?: number
  /** Real gateway chat-completions URL the proxy forwards to (e.g. https://gw/ai/v1/chat/completions). @default '' */
  gitnexusSseProxyUpstream?: string
  /** Env var whose value is mapped onto GITNEXUS_API_KEY for spawned gitnexus calls. @default '' */
  gitnexusApiKeyFromEnv?: string
  /** macOS Keychain service holding the gateway key — works even when the harness env lacks it. @default '' */
  gitnexusApiKeyKeychainService?: string
}

/** Runtime schema the host collects (validation + config-UI projection). */
export const Config: z<Config> = z.object({
  workmateHome: z.string().default('workmate').description('Directory name under the DSH home holding WorkMate state.'),
  maxConcurrent: z.number().default(3).description('Upper bound for swarm parallel agents at archive time (reserved).'),
  gitnexusEnabled: z.boolean().default(true).description('Master switch for the GitNexus knowledge bridge.'),
  weknoraBaseUrl: z.string().default('').description('WeKnora REST base URL; empty disables knowledge search.'),
  openspecRoot: z
    .string()
    .default('openspec')
    .description('OpenSpec root relative to the target project; applies to generation, status, lifecycle gates and archiving.'),
  projectRoot: z.string().default('').description('Default project root for OpenSpec generation and Git scanning; empty = caller must pass it.'),
  qualitySyncEnabled: z.boolean().default(true).description('Sync the OpenSpec quality assets into the target project on proposal creation.'),
  claudeAssetsEnabled: z
    .boolean()
    .default(true)
    .description('Also distribute the Claude Code assets (.claude/rules, agents, hooks, settings merge); DSH uses the bundled skills instead.'),
  basePort: z.number().default(3000).description('Port allocation base for worktree .env injection.'),
  portStep: z.number().default(10).description('Port step between worktree segments.'),
  copyFiles: z.array(z.string()).default(['.env', '.env.local']).description('Files copied from the main checkout into each new worktree.'),
  packageManager: z.string().default('pnpm').description('Package manager run inside a new worktree.'),
  weknoraEnabled: z.boolean().default(true).description('Enable the WeKnora Wiki association flow.'),
  weknoraKbId: z.string().default('').description('Default WeKnora knowledge base id; empty = unconfigured.'),
  weknoraWikiRequired: z.boolean().default(false).description('Fail implementing→merging when declared wiki pages are missing.'),
  approvalsRequired: z
    .array(z.string())
    .default(['merging', 'archiving'])
    .description('States that require a human approval to enter; empty disables the gate.'),
  allowAgentApproval: z
    .boolean()
    .default(false)
    .description('Let the agent actor cross gated states (weakens separation of duties).'),
  reviewBlockingSeverities: z
    .array(z.string())
    .default(['CRIT'])
    .description('Severities whose unresolved review findings block archiving.'),
  planDriftGate: z
    .boolean()
    .default(false)
    .description('Fail archiving when the diff touches files the plan never declared.'),
  decisionEnabled: z.boolean().default(false).description('Enable the judgement layer (model-backed gates).'),
  decisionProvider: z.string().default('agent').description('Judgement provider: agent | rules | jev.'),
  decisionLlmProvider: z.string().default('').description('LLM route for the agent provider; empty = first registered.'),
  decisionModel: z.string().default('').description('Model for the agent provider; empty = route default.'),
  decisionSamples: z.number().default(1).description('Samples per judgement; the agreement ratio becomes certainty.'),
  decisionTimeoutMs: z.number().default(4000).description('Per-judgement timeout in milliseconds.'),
  decisionActThreshold: z.number().default(0.8).description('Certainty needed to act on a judgement.'),
  decisionReviewThreshold: z.number().default(0.6).description('Certainty needed to raise a review instead of acting.'),
  highRiskExtraGates: z
    .array(z.string())
    .default(['implementing'])
    .description('States a high-risk proposal must also get human approval for.'),
  taskJudgementGate: z.boolean().default(false).description('Block archiving on a judged-unsatisfied task.'),
  reviewGradeMax: z.number().default(5).description('How many untagged review findings one archive run may grade.'),
  decisionCacheEnabled: z.boolean().default(true).description('Cache judgement answers (repeated questions cost nothing).'),
  decisionCacheMax: z.number().default(500).description('Cached judgement entries to keep.'),
  gitnexusWikiLang: z.string().default('').description('Language for gitnexus wiki; empty = GitNexus default.'),
  gitnexusWikiTimeoutMs: z.number().default(900000).description('Timeout for wiki generation in milliseconds.'),
  gitnexusSseProxyEnabled: z.boolean().default(false).description('Ensure the SSE-normalizing proxy before wiki generation.'),
  gitnexusSseProxyPort: z.number().default(8787).description('Loopback port for the SSE normalize proxy.'),
  gitnexusSseProxyUpstream: z.string().default('').description('Real gateway chat-completions URL the proxy forwards to.'),
  gitnexusApiKeyFromEnv: z.string().default('').description('Env var mapped onto GITNEXUS_API_KEY for gitnexus calls.'),
  gitnexusApiKeyKeychainService: z.string().default('').description('macOS Keychain service holding the gateway key.'),
})

export type ResolvedConfig = Required<Config>

export const CONFIG_DEFAULTS: ResolvedConfig = {
  workmateHome: 'workmate',
  maxConcurrent: 3,
  gitnexusEnabled: true,
  weknoraBaseUrl: '',
  openspecRoot: 'openspec',
  projectRoot: '',
  qualitySyncEnabled: true,
  claudeAssetsEnabled: true,
  basePort: 3000,
  portStep: 10,
  copyFiles: ['.env', '.env.local'],
  packageManager: 'pnpm',
  weknoraEnabled: true,
  weknoraKbId: '',
  weknoraWikiRequired: false,
  approvalsRequired: ['merging', 'archiving'],
  allowAgentApproval: false,
  reviewBlockingSeverities: ['CRIT'],
  planDriftGate: false,
  decisionEnabled: false,
  decisionProvider: 'agent',
  decisionLlmProvider: '',
  decisionModel: '',
  decisionSamples: 1,
  decisionTimeoutMs: 4000,
  decisionActThreshold: 0.8,
  decisionReviewThreshold: 0.6,
  highRiskExtraGates: ['implementing'],
  taskJudgementGate: false,
  reviewGradeMax: 5,
  decisionCacheEnabled: true,
  decisionCacheMax: 500,
  gitnexusWikiLang: '',
  gitnexusWikiTimeoutMs: 900000,
  gitnexusSseProxyEnabled: false,
  gitnexusSseProxyPort: 8787,
  gitnexusSseProxyUpstream: '',
  gitnexusApiKeyFromEnv: '',
  gitnexusApiKeyKeychainService: '',
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
