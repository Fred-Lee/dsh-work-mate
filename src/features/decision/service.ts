/**
 * Decision service (change `add-decision-layer`, design D3/D4/D5).
 *
 * Owns the two things a judgement must never outsource: the provider chain with its
 * degradation, and the thresholds that turn a probability into an action. Providers
 * answer; WorkMate decides. The action is only ever `act` / `review` / `abstain`, and
 * consumers must treat `review`/`abstain` as "do not take the optimistic path" —
 * never as permission (`act` is not a gate bypass either; see design D4).
 */
import type { DecisionAnswer, DecisionConfig, DecisionOutcome, DecisionProvider, DecisionQuestion } from './types.ts'

export interface DecisionServiceDeps {
  config: DecisionConfig
  providers: DecisionProvider[]
  now?: () => Date
}

export const DECISION_DEFAULTS: DecisionConfig = {
  enabled: false,
  provider: 'agent',
  samples: 1,
  timeoutMs: 4_000,
  thresholds: { act: 0.8, review: 0.6 },
}

export class DecisionService {
  private readonly providers: DecisionProvider[]
  private readonly config: DecisionConfig

  constructor(private readonly deps: DecisionServiceDeps) {
    const defaults = DECISION_DEFAULTS.thresholds as { act: number; review: number }
    const given = deps.config.thresholds
    this.config = {
      ...DECISION_DEFAULTS,
      ...deps.config,
      thresholds: {
        act: given?.act ?? defaults.act,
        review: given?.review ?? defaults.review,
      },
    }
    this.providers = deps.providers
  }

  get enabled(): boolean {
    return this.config.enabled
  }

  get preferredProvider(): string {
    return this.config.provider
  }

  /** Provider order: the configured one first, `rules` last as the deterministic floor. */
  private chain(): DecisionProvider[] {
    const preferred = this.providers.filter((provider) => provider.name === this.config.provider)
    const rest = this.providers.filter((provider) => provider.name !== this.config.provider)
    const rules = rest.filter((provider) => provider.name === 'rules')
    const others = rest.filter((provider) => provider.name !== 'rules')
    const chain = [...preferred, ...others, ...rules]
    return chain.filter((provider, index) => chain.findIndex((entry) => entry.name === provider.name) === index)
  }

  /**
   * Ask the node and turn the answer into an action. Returns undefined when the
   * layer is disabled — callers then keep their deterministic behaviour.
   */
  async decide(question: DecisionQuestion, signal?: AbortSignal): Promise<DecisionOutcome | undefined> {
    if (!this.config.enabled) return undefined
    const started = this.deps.now?.().getTime() ?? Date.now()
    const reasons: string[] = []
    let answer: DecisionAnswer | undefined
    let usedProvider = 'none'

    for (const provider of this.chain()) {
      if (!provider.available()) {
        reasons.push(`${provider.name}: unavailable`)
        continue
      }
      try {
        const candidate = await provider.ask(question, signal)
        if (candidate === undefined) {
          reasons.push(`${provider.name}: no answer`)
          continue
        }
        if (!question.options.includes(candidate.choice)) {
          reasons.push(`${provider.name}: off-enum answer '${candidate.choice}'`)
          continue
        }
        answer = candidate
        usedProvider = provider.name
        break
      } catch (error) {
        reasons.push(`${provider.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const latencyMs = (this.deps.now?.().getTime() ?? Date.now()) - started
    const thresholds = this.config.thresholds ?? { act: 0.8, review: 0.6 }
    if (answer === undefined) {
      return {
        node: question.node,
        action: 'abstain',
        certainty: 0,
        threshold: thresholds.act,
        provider: 'none',
        latencyMs,
        degraded: true,
        reason: reasons.join('; ') || 'no provider answered',
      }
    }
    const action =
      answer.certainty >= thresholds.act ? 'act' : answer.certainty >= thresholds.review ? 'review' : 'abstain'
    return {
      node: question.node,
      action,
      choice: answer.choice,
      certainty: answer.certainty,
      threshold: action === 'act' ? thresholds.act : thresholds.review,
      provider: usedProvider,
      ...(answer.model !== undefined ? { model: answer.model } : {}),
      ...(answer.samples !== undefined ? { samples: answer.samples } : {}),
      latencyMs,
      degraded: usedProvider !== this.config.provider,
      ...(reasons.length > 0 ? { reason: reasons.join('; ') } : {}),
    }
  }
}
