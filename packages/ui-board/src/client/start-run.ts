/**
 * 发起执行 — the pure, local half of the 第 ③ 列 entry (design D2/D3).
 *
 * Every function here is a pure function of the card's own text and the
 * `checkAgents()` install list: no LLM, no network, no service call, 0 token.
 * The heuristics only choose a DEFAULT for the dialog — the user can always
 * change it, and an explicit `claude` / `codex` pick is used VERBATIM with no
 * fallback (spec card-start-run 「用户主动改」).
 *
 * Kept out of the components so the rule is unit-testable on its own and has
 * exactly one definition (the card entry and the dialog both render it).
 */

export type AgentChoice = 'auto' | 'claude' | 'codex'

/** The three-way control's display order; `auto` first (it is the default). */
export const AGENT_CHOICES: readonly AgentChoice[] = ['auto', 'claude', 'codex']

export const AGENT_CHOICE_LABELS: Record<AgentChoice, string> = {
  auto: '按场景自适应(默认)',
  claude: 'claude',
  codex: 'codex',
}

export type ScenarioKind = 'decompose' | 'parallel' | 'simple'

export const SCENARIO_LABELS: Record<ScenarioKind, string> = {
  decompose: '拆解/计划型任务',
  parallel: '并行独立任务',
  simple: '简单/单步任务',
}

/** Decomposable / planning signals (design D2: 子任务/多步/计划型 → claude). */
export const DECOMPOSE_PATTERN = /拆解|拆分|计划|子任务|设计|方案|step|plan/i

/** Independent, parallelisable work (design D2: 多个可并行独立完成 → codex). */
export const PARALLEL_PATTERN = /并行|同时|各自|独立|parallel/i

/**
 * Reachable approximation of "the fastest INSTALLED agent" (design D2): the
 * documented preference order `claude → codex`, which is the only ordering this
 * package can defensibly claim without measuring the CLIs. Judgment call: the
 * design's own fallback order is used verbatim rather than guessing at runtime
 * latencies; the user can override with one click.
 */
export const AGENT_FASTEST_ORDER: readonly string[] = ['claude', 'codex']

/** The "fastest installed" agent, or the first unknown one, or null. */
export function fastestInstalled(installed: readonly string[]): string | null {
  for (const name of AGENT_FASTEST_ORDER) {
    if (installed.includes(name)) return name
  }
  return installed[0] ?? null
}

/**
 * Keyword classification of the card's text (title + summary).
 *
 * Judgment call: when a task shows BOTH signals ("拆解为 N 个子任务并行做")
 * decomposition wins, because planning is the scarcer capability and the
 * fan-out to several agents is already the orchestrator's job. Length is
 * deliberately NOT a signal: no defensible threshold exists for "简短", so a
 * keyword-free task is simply 简单/单步.
 */
export function classifyScenario(text: string): ScenarioKind {
  if (DECOMPOSE_PATTERN.test(text)) return 'decompose'
  if (PARALLEL_PATTERN.test(text)) return 'parallel'
  return 'simple'
}

/** What the 按场景自适应 option resolves to for one card + install list. */
export interface AutoResolution {
  scenario: ScenarioKind
  /** Concrete agent to start, or null when nothing is installed. */
  agent: string | null
  /** Chinese rationale rendered next to the control. */
  reason: string
}

/** The 按场景自适应 rule itself (design D2). */
export function resolveAuto(text: string, installed: readonly string[]): AutoResolution {
  const scenario = classifyScenario(text)
  const preferred =
    scenario === 'decompose' ? 'claude' : scenario === 'parallel' ? 'codex' : fastestInstalled(installed)
  if (preferred !== null && installed.includes(preferred)) {
    return { scenario, agent: preferred, reason: `${SCENARIO_LABELS[scenario]} → ${preferred}` }
  }
  // The first choice is not installed: fall back to the fastest installed one.
  // This is the AUTO branch only — an explicit user pick never falls back.
  const fallback = fastestInstalled(installed)
  return {
    scenario,
    agent: fallback,
    reason:
      fallback === null
        ? `${SCENARIO_LABELS[scenario]},但该项目群没有已安装的 agent`
        : `${SCENARIO_LABELS[scenario]}首选 ${preferred} 未安装 → 改用最快已装 ${fallback}`,
  }
}

export interface ChoiceResolution {
  /** The agent that will be submitted, or null when none can be. */
  agent: string | null
  /** The auto rule's scenario, or null when the user overrode it. */
  scenario: ScenarioKind | null
  reason: string
  /** True when the user picked claude/codex by hand (no auto decision). */
  overridden: boolean
}

/**
 * Resolution of the EFFECTIVE choice: `auto` follows the rule, an explicit
 * `claude` / `codex` is honoured verbatim — the system does not second-guess it,
 * not even to fall back when it is not installed (spec 「用户主动改」: 提交时使用
 * codex,系统不再回退到自适应). An impossible pick is refused loudly instead.
 */
export function resolveChoice(
  choice: AgentChoice,
  text: string,
  installed: readonly string[],
): ChoiceResolution {
  if (choice !== 'auto') {
    return { agent: choice, scenario: null, reason: `已手动指定 ${choice},不做自动回退`, overridden: true }
  }
  const auto = resolveAuto(text, installed)
  return { ...auto, overridden: false }
}

/**
 * The submitted prompt: card title + card summary (product decision ① —
 * 标题作标题行,摘要作骨架正文). Empty parts are dropped, so a summary-less card
 * still starts with its title and a title-less draft is submitted as-is.
 */
export function composePrompt(title: string, summary: string): string {
  const head = title.trim()
  const body = summary.trim()
  if (head === '') return body
  if (body === '') return head
  return `${head}\n\n${body}`
}
