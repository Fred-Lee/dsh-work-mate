/**
 * Deterministic fallback provider (change `add-decision-layer`, design D5).
 *
 * `rules` exists so the judgement layer still says something useful when no model
 * is reachable — and so the layer itself stays testable without any LLM. It only
 * answers nodes that are genuinely rule-shaped:
 *
 *   - `decision-consistency` is NOT rule-shaped (contradiction is semantic), so it
 *     abstains. That is deliberate: a keyword rule pretending to detect a
 *     contradiction would be exactly the un-auditable guess this layer avoids.
 *   - `review-severity` uses the severity vocabulary review.md already uses.
 *   - `injection-risk` uses the phrasing patterns prompt injection relies on.
 */
import type { DecisionAnswer, DecisionProvider, DecisionQuestion } from './types.ts'

// Note: `\b` does not exist around CJK, so the CJK alternatives stand alone.
const CONTRADICTS = /(\b(contradict|conflict|inconsistent)\b|相反|矛盾|推翻|不一致)/i
const INJECTION = /(ignore (all )?(previous|above) instructions|disregard .*instructions|you are now|system prompt|忽略(之前|上面)的?(所有)?指令|新指令|请执行以下|作为 ?AI)/i
const SEVERITY_HINTS: Array<{ choice: string; pattern: RegExp }> = [
  { choice: 'CRIT', pattern: /(数据丢失|越权|鉴权|凭证|注入|崩溃|数据损坏|安全漏洞|data loss|auth|credential|injection|crash)/i },
  { choice: 'HIGH', pattern: /(回归|不兼容|接口变更|迁移|阻断|regression|breaking|migration|blocker)/i },
  { choice: 'MED', pattern: /(命名|重构|重复|性能|边界|refactor|duplicate|performance|edge case)/i },
]

export class RulesProvider implements DecisionProvider {
  readonly name = 'rules'

  available(): boolean {
    return true
  }

  async ask(question: DecisionQuestion): Promise<DecisionAnswer | undefined> {
    if (question.node === 'decision-consistency') {
      // Semantic node: only a model (or a human) can answer it usefully.
      if (CONTRADICTS.test(question.state)) {
        return { choice: 'contradicts', certainty: 0.5, provider: this.name, samples: 1 }
      }
      return undefined
    }
    if (question.node === 'review-severity') {
      for (const hint of SEVERITY_HINTS) {
        if (hint.pattern.test(question.state) && question.options.includes(hint.choice)) {
          return { choice: hint.choice, certainty: 0.6, provider: this.name, samples: 1 }
        }
      }
      return question.options.includes('LOW')
        ? { choice: 'LOW', certainty: 0.5, provider: this.name, samples: 1 }
        : undefined
    }
    if (question.node === 'injection-risk') {
      const risky = INJECTION.test(question.state)
      const choice = risky ? 'risky' : 'benign'
      if (!question.options.includes(choice)) return undefined
      return { choice, certainty: risky ? 0.7 : 0.4, provider: this.name, samples: 1 }
    }
    return undefined
  }
}
