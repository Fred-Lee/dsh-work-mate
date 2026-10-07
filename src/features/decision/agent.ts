/**
 * Agent-backed provider (change `add-decision-layer`, design D1/D2).
 *
 * "Agent instead of Jev": the harness LLM service answers the SAME typed question,
 * but the answer is constrained to one forced tool call whose parameter schema is
 * the option enum — so there is nothing to parse out of prose, and an answer that
 * does not match counts as no answer (not as the default option).
 *
 * Certainty proxy (D2): Jev returns calibrated probabilities; an LLM does not. With
 * `samples > 1` the majority share becomes the proxy, and the sample count is
 * carried into the audit trail so a single-sample guess is never read as confidence.
 */
import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { DecisionAnswer, DecisionProvider, DecisionQuestion } from './types.ts'

/** The slice of the host LLM service this provider uses. */
export interface HostLlmFace {
  listProviders(): Array<{ id?: string; name?: string; models?: Array<{ id?: string; name?: string }> }>
  stream(options: {
    provider: string
    model: string
    system?: string
    /** Host accepts block arrays; some adapters call `.some()` on the content, so a bare string breaks them. */
    messages: Array<{ role: 'user'; content: string | Array<{ type: 'text'; text: string }> }>
    tools?: Array<{ name: string; description?: string; parameters?: unknown }>
    temperature?: number
    maxTokens?: number
  }): AsyncIterable<{
    type: string
    /** Host `FinishReason`: `{ kind: 'stop' | 'tool-calls' | 'max-tokens' | 'aborted' | 'error', failure? }`. */
    reason?: { kind?: string; failure?: unknown }
    text?: string
    name?: string
    argumentsDelta?: string
  }>
}

export interface AgentProviderOptions {
  /** Resolved lazily: the plugin must stay ACTIVE when no `llm` service exists. */
  llm(): HostLlmFace | undefined
  provider?: string
  model?: string
  samples?: number
  timeoutMs?: number
}

const TOOL_NAME = 'answer'
const SYSTEM =
  'You are a decision function, not an assistant. Answer ONLY by calling the `answer` tool with one of the given options. ' +
  'Never explain, never write prose, never invent an option outside the list. If the state does not support a confident answer, pick the option that says so.'

/**
 * The host normalizes an adapter failure into a terminal `finish` chunk instead of
 * throwing, so a failed call looks exactly like "the model returned no tool call".
 * That is how the judgement layer stayed silent for days. Record the reason.
 */
async function recordDiagnostic(line: Record<string, unknown>): Promise<void> {
  try {
    const file = join(homedir(), '.dsh', 'workmate', 'decision-diagnostics.jsonl')
    await mkdir(dirname(file), { recursive: true })
    const payload = JSON.stringify({ at: new Date().toISOString(), ...line }, (_key, value: unknown) =>
      typeof value === 'bigint' ? String(value) : value,
    )
    await appendFile(file, `${payload}\n`, 'utf8')
  } catch {
    /* diagnostics must never break a judgement */
  }
}

export class AgentProvider implements DecisionProvider {
  readonly name = 'agent'

  /** Set when the configured provider had to be swapped/loosened; reported once per call. */
  private lastRouteNote: string | undefined

  constructor(private readonly options: AgentProviderOptions) {}

  available(): boolean {
    return this.options.llm() !== undefined
  }

  async ask(question: DecisionQuestion, signal?: AbortSignal): Promise<DecisionAnswer | undefined> {
    const llm = this.options.llm()
    if (llm === undefined) return undefined
    const routes = await this.resolveRoutes(llm)
    if (routes.length === 0) {
      // The last silent exit: no call is attempted, so nothing else would ever say why.
      await recordDiagnostic({
        node: question.node,
        failure: 'no route resolved (call not attempted)',
        wantedProvider: this.options.provider === undefined || this.options.provider === '' ? '(first)' : this.options.provider,
        wantedModel: this.options.model === undefined || this.options.model === '' ? '(route default)' : this.options.model,
        listed: llm.listProviders().map((entry) => ({
          id: entry.id,
          name: entry.name,
          models: entry.models?.length ?? 0,
          sample: entry.models?.[0]?.id ?? entry.models?.[0]?.name,
        })),
      })
      return undefined
    }

    const samples = Math.max(1, Math.floor(this.options.samples ?? 1))
    // Try every candidate route: one provider may be unusable for this deployment
    // (`ACCOUNT_SIGN_IN_REQUIRED`, transport failure…) while the next one answers fine.
    for (const route of routes) {
      const votes: string[] = []
      for (let index = 0; index < samples; index += 1) {
        if (signal?.aborted === true) break
        const choice = await this.sampleOnce(llm, route, question, signal)
        if (choice !== undefined) votes.push(choice)
      }
      if (votes.length === 0) continue

      const tally = new Map<string, number>()
      for (const vote of votes) tally.set(vote, (tally.get(vote) ?? 0) + 1)
      const [choice, count] = [...tally.entries()].sort(
        (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
      )[0] as [string, number]
      return {
        choice,
        certainty: count / votes.length,
        provider: this.name,
        ...(route.model !== '' ? { model: route.model } : {}),
        samples: votes.length,
      }
    }
    return undefined
  }

  private async resolveRoutes(llm: HostLlmFace): Promise<Array<{ provider: string; model: string }>> {
    const listed = llm.listProviders()
    if (listed.length === 0) return []
    const wanted = this.options.provider
    const idOf = (entry: { id?: string; name?: string }): string | undefined => entry.id ?? entry.name

    // Exact id/name first; everything else follows in registration order as a fallback so a
    // provider that cannot serve this deployment (e.g. account sign-in required) is skipped
    // instead of silently sinking the judgement.
    const exact = wanted !== undefined && wanted !== '' ? listed.find((entry) => idOf(entry) === wanted) : undefined
    const ordered = exact !== undefined ? [exact, ...listed.filter((entry) => entry !== exact)] : [...listed]

    const routes: Array<{ provider: string; model: string }> = []
    const unroutable: Array<Record<string, unknown>> = []
    for (const provider of ordered) {
      const providerId = idOf(provider)
      if (providerId === undefined) continue
      const model =
        this.options.model !== undefined && this.options.model !== ''
          ? this.options.model
          : (provider.models?.[0]?.id ?? provider.models?.[0]?.name ?? '')
      if (model === '') {
        unroutable.push({ provider: providerId, listedModels: provider.models?.length ?? 0 })
        continue
      }
      routes.push({ provider: providerId, model })
    }

    if (routes.length === 0) {
      await recordDiagnostic({
        node: 'route',
        failure: 'no provider could supply a model',
        wantedProvider: wanted === undefined || wanted === '' ? '(first)' : wanted,
        unroutable,
      })
      return []
    }
    if (wanted !== undefined && wanted !== '' && exact === undefined) {
      await recordDiagnostic({
        node: 'route',
        note: `provider '${wanted}' 未精确匹配，候选顺序：${routes.map((route) => route.provider).join(' → ')}`,
        provider: routes[0]?.provider,
        model: routes[0]?.model,
      })
    }
    return routes
  }

  /** One forced tool call; anything unparseable or off-enum is "no answer". */
  private async sampleOnce(
    llm: HostLlmFace,
    route: { provider: string; model: string },
    question: DecisionQuestion,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const tool = {
      name: TOOL_NAME,
      description: 'Return the single best option for this judgement.',
      parameters: {
        type: 'object',
        properties: {
          choice: { type: 'string', enum: [...question.options], description: 'The chosen option.' },
        },
        required: ['choice'],
        additionalProperties: false,
      },
    }
    let argumentsJson = ''
    let chunksSeen = 0
    let finishKind = '(no finish chunk)'
    let finishFailure: unknown
    let textChars = 0
    let failure = ''
    const timeoutMs = this.options.timeoutMs ?? 4_000
    const abort = new AbortController()
    const onAbort = (): void => abort.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    const stop = setTimeout(() => abort.abort(), timeoutMs)
    try {
      const stream = llm.stream({
        provider: route.provider,
        model: route.model,
        system: SYSTEM,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `STATE:\n${question.state}\n\nQUESTION:\n${question.question}\n\nOPTIONS: ${question.options.join(' | ')}`,
              },
            ],
          },
        ],
        tools: [tool],
        temperature: 0,
        maxTokens: 200,
      })
      for await (const chunk of stream) {
        chunksSeen += 1
        if (abort.signal.aborted) {
          failure = failure === '' ? 'aborted (timeout or caller signal)' : failure
          break
        }
        if (chunk.type === 'finish') {
          finishKind = chunk.reason?.kind ?? '(no kind)'
          finishFailure = chunk.reason?.failure
          // `stop` / `tool-calls` are normal ends; `max-tokens` means the answer may be
          // truncated; `aborted` / `error` carry the adapter failure we need to see.
          if (!['stop', 'tool-calls', 'max-tokens'].includes(finishKind)) {
            failure = `finish:${finishKind}`
          }
          continue
        }
        if (chunk.type === 'text-delta') {
          textChars += chunk.text?.length ?? 0
          continue
        }
        if (chunk.type !== 'tool-call-delta') continue
        if (chunk.name !== undefined && chunk.name !== TOOL_NAME) continue
        argumentsJson += chunk.argumentsDelta ?? ''
      }
    } catch (error) {
      failure = `threw:${error instanceof Error ? error.message : String(error)}`
      await recordDiagnostic({ node: question.node, provider: route.provider, model: route.model, failure, textChars })
      return undefined
    } finally {
      clearTimeout(stop)
      signal?.removeEventListener('abort', onAbort)
    }
    if (argumentsJson === '') {
      await recordDiagnostic({
        node: question.node,
        provider: route.provider,
        model: route.model,
        finishKind,
        ...(finishFailure !== undefined ? { finishFailure } : {}),
        failure:
          failure === ''
            ? chunksSeen === 0
              ? 'empty stream (no chunk at all)'
              : 'no tool-call emitted (model answered in text?)'
            : failure,
        textChars,
        chunksSeen,
      })
      return undefined
    }
    try {
      const parsed: unknown = JSON.parse(argumentsJson)
      if (parsed === null || typeof parsed !== 'object') return undefined
      const choice = (parsed as { choice?: unknown }).choice
      return typeof choice === 'string' && question.options.includes(choice) ? choice : undefined
    } catch {
      return undefined
    }
  }
}
