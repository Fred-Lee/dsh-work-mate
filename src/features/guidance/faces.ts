/**
 * Minimal host faces for the two DSH guidance services WorkMate contributes to.
 *
 * Why local faces instead of importing the real packages:
 * `@deepseek-ai/dsh-system-prompt` / `@deepseek-ai/dsh-skill` are NOT resolvable
 * from this repo (pnpm does not hoist them; `require.resolve` and `tsc` both
 * fail), yet the system-prompt surface still reaches our program through
 * `@deepseek-ai/dsh-tools`' own type graph — as `0.1.1-rc.2`, which predates
 * `SystemPrompt.getSectionOrder` that the running host (0.1.7-rc.2) has. So:
 *
 *   - `systemPrompt` is ALREADY declared on Context by that graph — declaring it
 *     again is a TS2717 duplicate-property error. We only widen it locally to
 *     reach the newer, optional `getSectionOrder`.
 *   - `skills` is declared here (`register`), mirroring
 *     packages/skill/skill/lib/types/index.d.ts:257.
 */

/** Runtime skill contribution accepted by `ctx.skills.register()`. */
export interface RuntimeSkill {
  /** Kebab-case identifier used to address the skill. */
  name: string
  /** Short routing description shown by discovery consumers. */
  description: string
  /** Optional extra routing guidance. */
  whenToUse?: string
  /** Markdown instruction body. */
  content: string
}

export interface SkillRegistryFace {
  /** Register one borrowed readonly runtime skill; returns its unregister disposer. */
  register(skill: RuntimeSkill): () => void
}

/** One named system-prompt section (mirrors the host's `PromptSection`). */
export interface PromptSectionFace {
  readonly name: string
  readonly order: number
  readonly text: string
}

/**
 * The slice of `SystemPrompt` this plugin uses. `getSectionOrder` is optional
 * on purpose: it exists on the verified host line but not in the alpha-line
 * typings we compile against, so the call site falls back to the documented
 * numeric position.
 */
export interface SystemPromptFace {
  section(section: PromptSectionFace): () => void
  getSectionOrder?(name: 'TOOL_WORKFLOW'): number
}

/**
 * `SECTION_ORDERS.TOOL_WORKFLOW` — the standard slot for a plugin-provided
 * orchestration/tool family (dsh-system-prompt, `SECTION_ORDERS`).
 */
export const TOOL_WORKFLOW_ORDER = 2600

declare module '@deepseek-ai/cordis' {
  interface Context {
    skills: SkillRegistryFace
  }
}
