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
