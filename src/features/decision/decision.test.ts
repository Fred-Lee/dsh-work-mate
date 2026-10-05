import { describe, expect, it, vi } from 'vitest'
import { AgentProvider, type HostLlmFace } from './agent.ts'
import { RulesProvider } from './rules.ts'
import { DecisionService } from './service.ts'
import type { DecisionQuestion } from './types.ts'

const question: DecisionQuestion = {
  node: 'decision-consistency',
  state: '既有决策：1. 用 JSON 存提案\n\n新决策：改用 SQLite',
  question: '新决策是否与既有决策矛盾？',
  options: ['consistent', 'contradicts'],
}

/** Fake host LLM: streams one forced tool call with the given choices, per sample. */
function fakeLlm(choices: Array<string | undefined>): HostLlmFace & { calls: unknown[] } {
  const calls: unknown[] = []
  let index = 0
  return {
    calls,
    listProviders: () => [{ id: 'deepseek', models: [{ id: 'deepseek-v4-pro' }] }],
    stream(options) {
      calls.push(options)
      const choice = choices[Math.min(index, choices.length - 1)]
      index += 1
      return (async function* generate() {
        if (choice === undefined) {
          yield { type: 'text-delta', argumentsDelta: 'no tool call here' }
          return
        }
        yield { type: 'tool-call-delta', name: 'answer', argumentsDelta: `{"choice":"${choice}"}` }
        yield { type: 'tool-call-delta', name: 'answer', argumentsDelta: '' }
      })()
    },
  }
}

describe('AgentProvider', () => {
  it('is unavailable without the host service', () => {
    expect(new AgentProvider({ llm: () => undefined }).available()).toBe(false)
  })

  it('resolves the first registered route and forces the answer tool', async () => {
    const llm = fakeLlm(['contradicts'])
    const answer = await new AgentProvider({ llm: () => llm }).ask(question)

    expect(answer).toEqual({ choice: 'contradicts', certainty: 1, provider: 'agent', model: 'deepseek-v4-pro', samples: 1 })
    const call = llm.calls[0] as { provider: string; model: string; tools: Array<{ parameters: unknown }> }
    expect(call.provider).toBe('deepseek')
    expect(call.model).toBe('deepseek-v4-pro')
    expect(JSON.stringify(call.tools[0]?.parameters)).toContain('"enum":["consistent","contradicts"]')
  })

  it('turns an off-enum or missing answer into no answer', async () => {
    expect(await new AgentProvider({ llm: () => fakeLlm(['maybe']) }).ask(question)).toBeUndefined()
    expect(await new AgentProvider({ llm: () => fakeLlm([undefined]) }).ask(question)).toBeUndefined()
  })

  it('uses the agreement ratio across samples as certainty', async () => {
    const answer = await new AgentProvider({ llm: () => fakeLlm(['contradicts', 'contradicts', 'consistent']), samples: 3 }).ask(question)

    expect(answer?.choice).toBe('contradicts')
    expect(answer?.certainty).toBeCloseTo(2 / 3)
    expect(answer?.samples).toBe(3)
  })

  it('honours an explicit route and model override', async () => {
    const llm = fakeLlm(['consistent'])
    await new AgentProvider({ llm: () => llm, provider: 'deepseek', model: 'jev-latest' }).ask(question)

    expect((llm.calls[0] as { model: string }).model).toBe('jev-latest')
  })
})

describe('RulesProvider', () => {
  it('abstains on the semantic node unless the text says so outright', async () => {
    expect(await new RulesProvider().ask(question)).toBeUndefined()
    expect((await new RulesProvider().ask({ ...question, state: '这条决策与既有决策矛盾' }))?.choice).toBe('contradicts')
  })
})

describe('DecisionService', () => {
  const provider = (name: string, answer: { choice: string; certainty: number } | undefined) => ({
    name,
    available: () => true,
    ask: vi.fn(async () => (answer === undefined ? undefined : { ...answer, provider: name, samples: 1 })),
  })

  it('does nothing while the layer is disabled', async () => {
    const service = new DecisionService({ config: { enabled: false, provider: 'agent' }, providers: [] })

    expect(service.enabled).toBe(false)
    expect(await service.decide(question)).toBeUndefined()
  })

  it('computes the action from its own thresholds, not from the provider', async () => {
    const service = new DecisionService({
      config: { enabled: true, provider: 'agent', thresholds: { act: 0.8, review: 0.6 } },
      providers: [provider('agent', { choice: 'contradicts', certainty: 0.9 })],
    })
    const outcome = await service.decide(question)

    expect(outcome).toMatchObject({ action: 'act', choice: 'contradicts', provider: 'agent', degraded: false })
  })

  it('raises review, then abstains, as certainty falls', async () => {
    const review = new DecisionService({
      config: { enabled: true, provider: 'agent', thresholds: { act: 0.8, review: 0.6 } },
      providers: [provider('agent', { choice: 'contradicts', certainty: 0.7 })],
    })
    expect((await review.decide(question))?.action).toBe('review')

    const abstain = new DecisionService({
      config: { enabled: true, provider: 'agent', thresholds: { act: 0.8, review: 0.6 } },
      providers: [provider('agent', { choice: 'contradicts', certainty: 0.4 })],
    })
    expect((await abstain.decide(question))?.action).toBe('abstain')
  })

  it('falls back to rules and reports itself degraded', async () => {
    const service = new DecisionService({
      config: { enabled: true, provider: 'agent' },
      providers: [provider('agent', undefined), provider('rules', { choice: 'contradicts', certainty: 0.5 })],
    })
    const outcome = await service.decide(question)

    expect(outcome).toMatchObject({ action: 'abstain', provider: 'rules', degraded: true, choice: 'contradicts' })
    expect(outcome?.reason).toContain('agent: no answer')
  })

  it('skips unavailable providers and abstains when nothing answers', async () => {
    const unavailable = { name: 'agent', available: () => false, ask: vi.fn() }
    const service = new DecisionService({ config: { enabled: true, provider: 'agent' }, providers: [unavailable] })
    const outcome = await service.decide(question)

    expect(outcome).toMatchObject({ action: 'abstain', provider: 'none', degraded: true })
    expect(outcome?.choice).toBeUndefined()
    expect(unavailable.ask).not.toHaveBeenCalled()
  })

  it('ignores an off-enum answer instead of trusting it', async () => {
    const service = new DecisionService({
      config: { enabled: true, provider: 'agent' },
      providers: [provider('agent', { choice: 'invented', certainty: 1 })],
    })
    const outcome = await service.decide(question)

    expect(outcome?.choice).toBeUndefined()
    expect(outcome?.reason).toContain('off-enum')
  })
})
