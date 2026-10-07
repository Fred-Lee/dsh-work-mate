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
    messages: Array<{ role: 'user'; content: string }>
    tools?: Array<{ name: string; description?: string; parameters?: unknown }>
    temperature?: number
    maxTokens?: number
  }): AsyncIterable<{ type: string; reason?: unknown; text?: string; name?: string; argumentsDelta?: string }>
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
    await appendFile(file, `${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`, 'utf8')
  } catch {
    /* diagnostics must never break a judgement */
  }
}

export class AgentProvider implements DecisionProvider {
  readonly name = 'agent'

  constructor(private readonly options: AgentProviderOptions) {}

  available(): boolean {
    return this.options.llm() !== undefined
  }

  async ask(question: DecisionQuestion, signal?: AbortSignal): Promise<DecisionAnswer | undefined> {
    const llm = this.options.llm()
    if (llm === undefined) return undefined
    const route = this.resolveRoute(llm)
    if (route === undefined) return undefined

    const samples = Math.max(1, Math.floor(this.options.samples ?? 1))
    const votes: string[] = []
    for (let index = 0; index < samples; index += 1) {
      if (signal?.aborted === true) break
      const choice = await this.sampleOnce(llm, route, question, signal)
      if (choice !== undefined) votes.push(choice)
    }
    if (votes.length === 0) return undefined

    const tally = new Map<string, number>()
    for (const vote of votes) tally.set(vote, (tally.get(vote) ?? 0) + 1)
    const [choice, count] = [...tally.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0] as [string, number]
    return {
      choice,
      certainty: count / votes.length,
      provider: this.name,
      ...(route.model !== '' ? { model: route.model } : {}),
      samples: votes.length,
    }
  }

  private resolveRoute(llm: HostLlmFace): { provider: string; model: string } | undefined {
    const listed = llm.listProviders()
    if (listed.length === 0) return undefined
    const wanted = this.options.provider
    const provider =
      wanted !== undefined && wanted !== ''
        ? listed.find((entry) => entry.id === wanted || entry.name === wanted)
        : listed[0]
    if (provider === undefined) return undefined
    const providerId = provider.id ?? provider.name
    if (providerId === undefined) return undefined
    const model =
      this.options.model !== undefined && this.options.model !== ''
        ? this.options.model
        : (provider.models?.[0]?.id ?? provider.models?.[0]?.name ?? '')
    if (model === '') return undefined
    return { provider: providerId, model }
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
    let finishReason = ''
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
            content: `STATE:\n${question.state}\n\nQUESTION:\n${question.question}\n\nOPTIONS: ${question.options.join(' | ')}`,
          },
        ],
        tools: [tool],
        temperature: 0,
        maxTokens: 200,
      })
      for await (const chunk of stream) {
        if (abort.signal.aborted) {
          failure = failure === '' ? 'aborted (timeout or caller signal)' : failure
          break
        }
        if (chunk.type === 'finish') {
          finishReason = String(chunk.reason)
          if (!['stop', 'tool-calls', 'tool_call', 'end_turn'].includes(finishReason)) {
            failure = `finish:${finishReason}`
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
        finishReason: finishReason === '' ? '(no finish chunk)' : finishReason,
        failure: failure === '' ? 'no tool-call emitted (model answered in text?)' : failure,
        textChars,
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
