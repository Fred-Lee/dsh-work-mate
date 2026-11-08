/**
 * Decision service (change `add-decision-layer`, design D3/D4/D5).
 *
 * Owns the two things a judgement must never outsource: the provider chain with its
 * degradation, and the thresholds that turn a probability into an action. Providers
 * answer; WorkMate decides. The action is only ever `act` / `review` / `abstain`, and
 * consumers must treat `review`/`abstain` as "do not take the optimistic path" —
 * never as permission (`act` is not a gate bypass either; see design D4).
 */
import { mkdir, appendFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { DecisionCache, cacheKey } from './cache.ts'
import type { DecisionAnswer, DecisionConfig, DecisionOutcome, DecisionProvider, DecisionQuestion } from './types.ts'

export interface DecisionServiceDeps {
  config: DecisionConfig
  providers: DecisionProvider[]
  /** Cache file path; omitted = caching off (tests/embeddings). */
  cacheFile?: string
  now?: () => Date
}

export const DECISION_DEFAULTS: DecisionConfig = {
  enabled: false,
  provider: 'agent',
  samples: 1,
  timeoutMs: 4_000,
  thresholds: { act: 0.8, review: 0.6 },
  cacheEnabled: true,
  cacheMax: 500,
}

/** Diagnostics share the agent provider's file so one place explains a silent judge. */
async function recordDiagnostic(line: Record<string, unknown>): Promise<void> {
  try {
    const file = join(homedir(), '.dsh', 'workmate', 'decision-diagnostics.jsonl')
    await mkdir(dirname(file), { recursive: true })
    await appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`, 'utf8')
  } catch {
    /* diagnostics must never break a judgement */
  }
}

export class DecisionService {
  private readonly providers: DecisionProvider[]
  private readonly config: DecisionConfig
  private readonly cache: DecisionCache | undefined

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
    this.cache =
      deps.cacheFile !== undefined && this.config.cacheEnabled !== false
        ? new DecisionCache(deps.cacheFile, this.config.cacheMax ?? 500)
        : undefined
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
    let cached = false
    const route = { provider: this.config.provider, samples: this.config.samples }
    const key = cacheKey(question, route)

    if (this.cache !== undefined) {
      const hit = await this.cache.get(key)
      // change `validate-decision-cache`：缓存是 fail-open 可写文件，命中必须过与
      // 活路径同级的形状校验——否则一条手改的 {choice, certainty} 就能旁路判断层
      // "只收紧不放松"的前提。失效按未命中处理（重算并覆盖写回），留诊断。
      const trusted =
        hit !== undefined &&
        Number.isFinite(hit.certainty) &&
        hit.certainty >= 0 &&
        hit.certainty <= 1 &&
        question.options.includes(hit.choice)
      if (hit !== undefined && !trusted) {
        await recordDiagnostic({
          node: question.node,
          provider: 'cache',
          failure: `cache entry rejected: choice=${JSON.stringify(hit.choice)} certainty=${String(hit.certainty)}`,
        })
      }
      if (hit !== undefined && trusted) {
        const outcome = this.toOutcome(question, {
          choice: hit.choice,
          certainty: hit.certainty,
          provider: hit.provider,
          ...(hit.model !== undefined ? { model: hit.model } : {}),
          ...(hit.samples !== undefined ? { samples: hit.samples } : {}),
        }, this.deps.now?.().getTime() ?? Date.now() - started, started)
        return { ...outcome, cached: true }
      }
    }

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
    // Only a model answer is worth caching: `rules` recomputes for free (design D2).
    if (answer !== undefined && this.cache !== undefined && usedProvider !== 'rules') {
      await this.cache.put(key, {
        choice: answer.choice,
        certainty: answer.certainty,
        provider: usedProvider,
        ...(answer.model !== undefined ? { model: answer.model } : {}),
        ...(answer.samples !== undefined ? { samples: answer.samples } : {}),
        at: (this.deps.now?.() ?? new Date()).toISOString(),
      })
    }
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
    const outcome = this.toOutcome(question, answer, latencyMs, started)
    return {
      ...outcome,
      provider: usedProvider,
      degraded: usedProvider !== this.config.provider,
      ...(reasons.length > 0 ? { reason: reasons.join('; ') } : {}),
      ...(cached ? { cached: true } : {}),
    }
  }

  /** Thresholds are WorkMate's, not the provider's (design D3 of the layer change). */
  private toOutcome(
    question: DecisionQuestion,
    answer: DecisionAnswer,
    latencyMs: number,
    started: number,
  ): DecisionOutcome {
    const thresholds = this.config.thresholds ?? { act: 0.8, review: 0.6 }
    const action =
      answer.certainty >= thresholds.act ? 'act' : answer.certainty >= thresholds.review ? 'review' : 'abstain'
    return {
      node: question.node,
      action,
      choice: answer.choice,
      certainty: answer.certainty,
      threshold: action === 'act' ? thresholds.act : thresholds.review,
      provider: answer.provider,
      ...(answer.model !== undefined ? { model: answer.model } : {}),
      ...(answer.samples !== undefined ? { samples: answer.samples } : {}),
      latencyMs: Math.max(0, (this.deps.now?.().getTime() ?? Date.now()) - started),
      degraded: false,
    }
  }
}
