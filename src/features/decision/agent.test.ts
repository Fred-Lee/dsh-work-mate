import { describe, expect, it } from 'vitest'
describe('agent provider finish kinds (decision-call-diagnostics)', () => {
  const options = (chunks: unknown[]) => ({
    llm: () => ({
      listProviders: () => [{ id: 'deepseek-official', models: [{ id: 'deepseek-flash' }] }],
      stream: () => (async function* () { for (const c of chunks) yield c })(),
    }),
    model: 'deepseek-flash',
    samples: 1,
    timeoutMs: 1_000,
  })

  it('accepts a tool call that arrives before an error finish', async () => {
    const { AgentProvider } = await import('./agent.ts')
    const ask = await new AgentProvider(options([
      { type: 'tool-call-delta', index: 0, id: 'c1', name: 'answer', argumentsDelta: '{"choice":"b"}' },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]) as never).ask({ node: 'module-match', state: 's', question: 'q', options: ['a', 'b', 'none'] })

    expect(ask?.choice).toBe('b')
    expect(ask?.certainty).toBeGreaterThan(0)
    expect(ask?.provider).toBe('agent')
  })

  it('returns undefined and records the failure kind when the adapter errors', async () => {
    const { AgentProvider } = await import('./agent.ts')
    const result = await new AgentProvider(options([
      { type: 'finish', reason: { kind: 'error', failure: { message: 'model not found' } } },
    ]) as never).ask({ node: 'module-match', state: 's', question: 'q', options: ['a', 'none'] })

    expect(result).toBeUndefined()
  })
})

describe('route resolution resilience (decision-route-diagnostics)', () => {
  const face = (providers: unknown[]) => ({
    llm: () => ({ listProviders: () => providers, stream: () => (async function* () {})() }),
    samples: 1,
    timeoutMs: 500,
  })

  it('falls back to the first provider when the configured one is absent', async () => {
    const { AgentProvider } = await import('./agent.ts')
    const provider = new AgentProvider({
      ...face([{ id: 'deepseek-account', models: [{ id: 'deepseek-v4-pro' }] }]),
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
    } as never)

    // Reaches the adapter (no route → no call would leave llmAsked at 0 forever).
    const answer = await provider.ask({ node: 'module-match', state: 's', question: 'q', options: ['a', 'none'] })
    expect(answer).toBeUndefined()          // empty stream ⇒ no answer
    expect(provider.available()).toBe(true)
  })

  it('answers nothing when no provider is registered at all', async () => {
    const { AgentProvider } = await import('./agent.ts')
    const answer = await new AgentProvider(face([]) as never).ask({
      node: 'module-match',
      state: 's',
      question: 'q',
      options: ['a'],
    })

    expect(answer).toBeUndefined()
  })
})

describe('message shape (decision-content-block)', () => {
  it('sends user content as a block array, not a bare string', async () => {
    const { AgentProvider } = await import('./agent.ts')
    let seen: unknown
    const provider = new AgentProvider({
      llm: () => ({
        listProviders: () => [{ id: 'p', models: [{ id: 'm' }] }],
        stream: (options: { messages: unknown }) => {
          seen = options.messages
          return (async function* () {
            yield { type: 'tool-call-delta', index: 0, id: 'c', name: 'answer', argumentsDelta: '{"choice":"a"}' }
            yield { type: 'finish', reason: { kind: 'tool-calls' } }
          })()
        },
      }),
      provider: 'p',
      model: 'm',
      samples: 1,
    } as never)

    const answer = await provider.ask({ node: 'module-match', state: 'S', question: 'Q', options: ['a', 'none'] })

    expect(answer?.choice).toBe('a')
    const content = (seen as Array<{ content: unknown }>)[0]?.content
    expect(Array.isArray(content)).toBe(true)          // adapters call content.some()
    expect((content as Array<{ type: string }>)[0]?.type).toBe('text')
  })
})
