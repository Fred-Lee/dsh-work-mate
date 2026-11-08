/**
 * System One provider (change `add-systemone-decision-provider`, design D1–D9).
 *
 * This is the concrete implementation behind the `jev` placeholder: a TypeSafe Jev
 * System One client whose `baseUrl` is configurable, so the same code talks to a
 * cloud Jev deployment or to a local Ollama (`POST /v1/systemone`, which the Ollama
 * docs describe as following TypeSafe's Jev API).
 *
 * Three semantics are pinned here on purpose, because each one has a plausible
 * wrong default that would look like a working judge:
 *
 *  - D2: `certainty` is the probability of the chosen option, NOT the response's
 *    `confidence`. Ollama defines confidence as `1 - H(p)/ln(N)` — "distribution
 *    concentration … Not calibrated correctness". WorkMate's act/review thresholds
 *    are a decision-confidence gate, so substituting concentration would silently
 *    swap the criterion the thresholds are compared against.
 *  - D3/D4: `choice` questions send a `criteria` OBJECT (option key → description);
 *    the binary nodes use `noul`, which returns P(true). `score` is not used: its
 *    published accuracy is measured as "top level exactly matched" and WorkMate's
 *    options are label enums, not a continuous scale.
 *  - D9: an over-long `state` is answered with "no conclusion", never truncated.
 *    The request limit (64 KiB, and the loaded context) is a real risk for
 *    `search-rerank` / `risk-tier` states, and a silently truncated request would
 *    make the audit trail disagree with what the model actually saw.
 *
 * Failure discipline (D6): availability is config-only — no startup probe and no
 * cached health verdict, because Ollama may start *after* the harness and a cached
 * "unavailable" would be permanently wrong. Every real failure (connection refused,
 * timeout, non-2xx, malformed body, off-enum option) surfaces as `undefined`, which
 * the existing provider chain degrades from; the reason is written to the same
 * diagnostics file the agent provider uses.
 */
import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { DecisionAnswer, DecisionProvider, DecisionQuestion } from './types.ts'

export interface SystemOneProviderOptions {
  /** Base URL of the System One server; the default port is Ollama's. */
  baseUrl?: string
  /** Model name; empty means "not configured" → `available()` is false. */
  model?: string
  /** How long the server keeps the model loaded after the request (Ollama `keep_alive`). */
  keepAlive?: string
  /** Per-request timeout in ms. A cold local model needs seconds to load. */
  timeoutMs?: number
  /** Request cap; the server rejects bodies over 64 KiB without images. */
  maxStateBytes?: number
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

/** Nodes whose answer is genuinely binary; everything else is a labelled choice. */
const NOUL_NODES: ReadonlySet<string> = new Set(['injection-risk', 'task-satisfied'])

/** Ollama's documented body cap for requests without images. */
const DEFAULT_MAX_STATE_BYTES = 64 * 1024

const DEFAULTS = {
  baseUrl: 'http://127.0.0.1:11434',
  keepAlive: '60s',
  // Covers a COLD load: measured TTFB is 18.6-23.5s while a ~9GB model is read from
  // disk, so a 20s default made the first judgement after `keep_alive` expiry fail
  // intermittently (observed: `aborted after 20012ms`, silently degrading to `agent`).
  timeoutMs: 60_000,
} as const

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A probability the response can be trusted to have produced. */
function asProbability(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined
}

export class SystemOneProvider implements DecisionProvider {
  readonly name = 'jev'

  constructor(private readonly options: SystemOneProviderOptions = {}) {}

  private get baseUrl(): string {
    const raw = this.options.baseUrl?.trim()
    return (raw === undefined || raw === '' ? DEFAULTS.baseUrl : raw).replace(/\/+$/, '')
  }

  private get model(): string {
    return this.options.model?.trim() ?? ''
  }

  available(): boolean {
    // Config-only on purpose (D6): probing here would cache a verdict that a
    // later `ollama serve` invalidates, and the chain already handles failures.
    return this.model !== ''
  }

  async ask(question: DecisionQuestion, signal?: AbortSignal): Promise<DecisionAnswer | undefined> {
    const model = this.model
    if (model === '') return undefined
    if (question.options.length < 2) {
      // A one-option question is not a question; System One also requires 2+ criteria.
      await recordDiagnostic({
        node: question.node,
        provider: this.name,
        model,
        failure: `question has ${question.options.length} option(s); System One requires 2-26`,
      })
      return undefined
    }

    const body = await this.buildBody(question, model)
    if (body === undefined) return undefined

    const timeoutMs = this.options.timeoutMs ?? DEFAULTS.timeoutMs
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const started = Date.now()
    let response: Response
    try {
      response = await (this.options.fetchImpl ?? fetch)(`${this.baseUrl}/v1/systemone`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      const aborted = Boolean(signal?.aborted) || controller.signal.aborted
      await recordDiagnostic({
        node: question.node,
        provider: this.name,
        model,
        failure: aborted ? `aborted after ${Date.now() - started}ms (timeout ${timeoutMs}ms)` : `threw:${describe(error)}`,
        elapsedMs: Date.now() - started,
      })
      return undefined
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      await recordDiagnostic({
        node: question.node,
        provider: this.name,
        model,
        failure: `http ${response.status}`,
        detail: detail.slice(0, 400),
      })
      return undefined
    }

    // MED-1（change `add-systemone-decision-provider` 审查）：timer 与外部 signal 必须
    // 活到 body 读完为止——否则服务器在握手后挂起 body 时（实测 undici 默认
    // bodyTimeout ≈ 301s），`timeoutMs` 与调用方的取消都形同虚设。
    try {
      const payload: unknown = await response.json()
      return await this.parseAnswer(question, model, payload)
    } catch (error) {
      const aborted = Boolean(signal?.aborted) || controller.signal.aborted
      await recordDiagnostic({
        node: question.node,
        provider: this.name,
        model,
        failure: aborted
          ? `aborted after ${Date.now() - started}ms (timeout ${timeoutMs}ms)`
          : error instanceof SyntaxError
            ? `invalid JSON: ${describe(error)}`
            : `body read threw:${describe(error)}`,
        elapsedMs: Date.now() - started,
      })
      return undefined
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  /**
   * Map one typed question onto the wire format. Returns undefined (and records why)
   * when the question cannot be expressed — e.g. a state that cannot fit the cap.
   */
  private async buildBody(question: DecisionQuestion, model: string): Promise<Record<string, unknown> | undefined> {
    const maxBytes = this.options.maxStateBytes ?? DEFAULT_MAX_STATE_BYTES
    const stateBytes = Buffer.byteLength(question.state, 'utf8')
    if (stateBytes > maxBytes) {
      // D9: an explicit abstention, not a silent truncation.
      await recordDiagnostic({
        node: question.node,
        provider: this.name,
        model,
        failure: `state is ${stateBytes} bytes; limit is ${maxBytes}`,
      })
      return undefined
    }

    const instructions = question.question.trim() === '' ? 'Choose the option that fits the state best.' : question.question
    const spec = NOUL_NODES.has(question.node)
      ? { type: 'noul', instructions, criteria: { false: question.options[0], true: question.options[1] } }
      : {
          type: 'choice',
          instructions,
          criteria: Object.fromEntries(question.options.map((option) => [option, describeOption(option)])),
        }

    return {
      model,
      state: question.state,
      questions: { answer: spec },
      keep_alive: this.options.keepAlive ?? DEFAULTS.keepAlive,
    }
  }

  /** Response → DecisionAnswer. Anything off-enum or malformed is "no answer" (D2/D3). */
  private async parseAnswer(question: DecisionQuestion, model: string, payload: unknown): Promise<DecisionAnswer | undefined> {
    if (!isRecord(payload)) {
      await recordDiagnostic({ node: question.node, provider: this.name, model, failure: 'response is not an object' })
      return undefined
    }
    const answers = payload['answers']
    const entry = isRecord(answers) ? answers['answer'] : undefined
    if (!isRecord(entry)) {
      await recordDiagnostic({ node: question.node, provider: this.name, model, failure: 'answers.answer missing' })
      return undefined
    }

    if (entry['type'] === 'noul') {
      const trueProbability = asProbability(entry['noul'])
      if (trueProbability === undefined) {
        await recordDiagnostic({ node: question.node, provider: this.name, model, failure: 'noul field missing or not a probability' })
        return undefined
      }
      // P(true) is the second option's probability by definition of the node table.
      return {
        choice: trueProbability >= 0.5 ? (question.options[1] as string) : (question.options[0] as string),
        certainty: Math.max(trueProbability, 1 - trueProbability),
        provider: this.name,
        model,
        samples: 1,
      }
    }

    const choice = entry['choice']
    if (typeof choice !== 'string' || !question.options.includes(choice)) {
      await recordDiagnostic({
        node: question.node,
        provider: this.name,
        model,
        failure: typeof choice === 'string' ? `off-enum choice '${choice}'` : 'choice missing',
      })
      return undefined
    }
    const probabilities = entry['probabilities']
    const probability = isRecord(probabilities) ? asProbability(probabilities[choice]) : undefined
    // D2: `entry.confidence` exists here and is deliberately NOT read.
    const certainty = probability ?? maxProbability(probabilities)
    if (certainty === undefined) {
      await recordDiagnostic({
        node: question.node,
        provider: this.name,
        model,
        failure: 'choice answer without a usable probability',
      })
      return undefined
    }
    return { choice, certainty, provider: this.name, model, samples: 1 }
  }
}

/** Fallback when the chosen key is absent from `probabilities` but others are not. */
function maxProbability(probabilities: unknown): number | undefined {
  if (!isRecord(probabilities)) return undefined
  const values = Object.values(probabilities)
    .map((value) => asProbability(value))
    .filter((value): value is number => value !== undefined)
  return values.length === 0 ? undefined : Math.max(...values)
}

/** The option label is already the whole answer; the server also accepts `null`. */
function describeOption(option: string): string {
  return option
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
