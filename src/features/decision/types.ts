/**
 * Decision layer types (change `add-decision-layer`).
 *
 * A judgement node is a closed question: a `state` (the evidence), a question and
 * a fixed option set. Jev's System One answers such questions with probabilities;
 * when no TypeSafe key exists, the `agent` provider asks the harness LLM through a
 * FORCED single tool call (D1) — the option enum is the tool's parameter schema, so
 * there is no free text to parse and a malformed answer counts as "no answer".
 */

/** Nodes WorkMate asks about. Kept small: each one must be closed and checkable. */
export type DecisionNode =
  | 'decision-consistency'
  | 'review-severity'
  | 'injection-risk'
  | 'risk-tier'
  | 'task-satisfied'
  /** change `classify-touches-by-decision`: which module does a change affect? */
  | 'module-match'

export interface DecisionQuestion {
  node: DecisionNode
  /** Human-readable state: the evidence the judgement is about. */
  state: string
  /** The question in one line. */
  question: string
  /** Fixed answers, first one is the "no change" / neutral default. */
  options: readonly string[]
}

export interface DecisionAnswer {
  choice: string
  /** Calibrated probability (Jev) or the agreement ratio across samples (`agent`). */
  certainty: number
  provider: string
  model?: string
  /** How many model samples backed the answer (`agent`); 1 for deterministic providers. */
  samples?: number
}

/** A judgement with the action WorkMate computed from its own thresholds. */
export interface DecisionOutcome {
  node: DecisionNode
  action: 'act' | 'review' | 'abstain'
  choice?: string
  certainty: number
  threshold: number
  provider: string
  model?: string
  samples?: number
  latencyMs: number
  /** True when the configured provider did not answer and a fallback did. */
  degraded: boolean
  /** True when this judgement was answered from the cache, not by a fresh call. */
  cached?: boolean
  reason?: string
}

export interface DecisionProvider {
  readonly name: string
  /** Whether this provider can answer at all right now (key/route present). */
  available(): boolean
  /** One typed judgement; throw or return undefined when it cannot answer. */
  ask(question: DecisionQuestion, signal?: AbortSignal): Promise<DecisionAnswer | undefined>
}

export interface DecisionConfig {
  enabled: boolean
  /** Preferred provider; the service falls back to `rules` when it cannot answer. */
  provider: 'agent' | 'rules' | 'jev'
  /** LLM route/provider for the `agent` provider (empty = first registered route). */
  llmProvider?: string
  /** Model for the `agent` provider (empty = the provider's default). */
  model?: string
  /** Samples per question; >1 turns the agreement ratio into the certainty proxy. */
  samples?: number
  timeoutMs?: number
  /** Action thresholds: `act` = confident, `review` = needs a human look. */
  thresholds?: { act: number; review: number }
  /** Reuse answers for identical questions (design of `add-decision-cache`). @default true */
  cacheEnabled?: boolean
  /** Cached entries to keep; the oldest are evicted first. @default 500 */
  cacheMax?: number
}
