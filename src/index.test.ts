/**
 * Host entry shape: `webServer` is provided by the web-app bundle ONLY, so a
 * hard `inject` on it would park the fiber — and with it every `workmate_*`
 * tool — in headless / acp / sdk profiles (change `harden-dsh-plugin-fit`).
 * These tests pin `inject = ['tools']`, the lazy UI mount, the native
 * Schemastery `Config` export and the guidance registrations (change
 * `adopt-dsh-native-config-and-guidance`).
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Config, apply, inject, name } from './index.ts'

let home: string

interface FakeRoute {
  kind: 'exact' | 'prefix'
  path: string
}

function fakeCtx(available: Record<string, unknown>): {
  ctx: never
  registered: unknown[]
  routes: FakeRoute[]
  skills: { register: ReturnType<typeof vi.fn> } | undefined
  prompt: { section: ReturnType<typeof vi.fn> } | undefined
} {
  const registered: unknown[] = []
  const routes: FakeRoute[] = []
  const webServer = available['webServer'] as { register(route: FakeRoute): void } | undefined
  const skills = available['skills'] as { register: ReturnType<typeof vi.fn> } | undefined
  const prompt = available['systemPrompt'] as { section: ReturnType<typeof vi.fn> } | undefined
  const scopeFor = (): Record<string, unknown> => ({
    ...available,
    get: (key: string) => available[key],
    effect: (fn: () => unknown) => fn(),
    inject: () => ({}),
  })
  const ctx = {
    ...available,
    // Emulate cordis `ctx.provide('a.b', value)` so tests can reach the service.
    provide: (name: string, value: unknown) => {
      const [head, tail] = name.split('.')
      if (head === undefined || tail === undefined) return
      const root = ((ctx as unknown as Record<string, unknown>)[head] ?? {}) as Record<string, unknown>
      root[tail] = value
      ;(ctx as unknown as Record<string, unknown>)[head] = root
    },
    tools: {
      register: (definition: unknown) => {
        registered.push(definition)
      },
    },
    get: (key: string) => available[key],
    inject: (deps: readonly string[], callback: (scope: never) => void) => {
      if (deps.every((dep) => available[dep] !== undefined)) callback(scopeFor() as never)
      return {}
    },
  }
  if (webServer !== undefined) {
    webServer.register = (route: FakeRoute) => {
      routes.push(route)
    }
  }
  return { ctx: ctx as never, registered, routes, skills, prompt }
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'workmate-entry-'))
  process.env['DSH_HOME'] = home
})

afterEach(async () => {
  delete process.env['DSH_HOME']
  await rm(home, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('decision layer wiring (add-decision-layer)', () => {
  /** Fake host LLM answering the forced tool call with the given choices, in order. */
  const fakeLlm = (...choices: string[]) => {
    let index = 0
    return {
      listProviders: () => [{ id: 'deepseek', models: [{ id: 'deepseek-v4-pro' }] }],
      stream: () => {
        const choice = choices[Math.min(index, choices.length - 1)] ?? 'consistent'
        index += 1
        return (async function* generate() {
          yield { type: 'tool-call-delta', name: 'answer', argumentsDelta: `{"choice":"${choice}"}` }
        })()
      },
    }
  }

  const decideTool = (registered: unknown[]): { execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown> } =>
    registered.find((tool) => (tool as { name: string }).name === 'workmate_proposal_decide') as {
      execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown>
    }

  it('refuses a silent reversal once the layer says the decision contradicts', async () => {
    const { ctx, registered } = fakeCtx({ llm: fakeLlm('contradicts') })
    apply(ctx, { decisionEnabled: true, decisionProvider: 'agent' })
    await (ctx as unknown as { workmate: { proposal: { upsert: (input: { id: string; title: string }) => Promise<unknown> } } }).workmate.proposal.upsert({ id: 'p1', title: 't' })

    await expect(
      decideTool(registered).execute({ id: 'p1', decision: '改用 SQLite', rationale: '更快' }, { signal: undefined }),
    ).rejects.toThrow(/supersedes/)
  })

  it('accepts the same decision when supersedes is declared', async () => {
    const { ctx, registered } = fakeCtx({ llm: fakeLlm('consistent', 'contradicts') })
    apply(ctx, { decisionEnabled: true, decisionProvider: 'agent' })
    const service = (ctx as unknown as { workmate: { proposal: { upsert: (input: { id: string; title: string }) => Promise<unknown>; get: (id: string) => Promise<{ decisions?: unknown[] }> } } }).workmate.proposal
    await service.upsert({ id: 'p1', title: 't' })

    // The mechanical check needs the referenced id to exist, so seed one first.
    await decideTool(registered).execute({ id: 'p1', decision: '用 JSON 存提案', rationale: '简单' }, { signal: undefined })
    const seeded = await service.get('p1')
    const previousId = (seeded.decisions?.[0] as { id?: string } | undefined)?.id
    expect(previousId).toBeTruthy()
    await expect(
      decideTool(registered).execute(
        { id: 'p1', decision: '改用 SQLite', rationale: '更快', supersedes: previousId },
        { signal: undefined },
      ),
    ).resolves.toBeDefined()
  })

  it('keeps the previous behaviour when the layer is disabled', async () => {
    const { ctx, registered } = fakeCtx({ llm: fakeLlm('contradicts') })
    apply(ctx)
    await (ctx as unknown as { workmate: { proposal: { upsert: (input: { id: string; title: string }) => Promise<unknown> } } }).workmate.proposal.upsert({ id: 'p1', title: 't' })

    await expect(
      decideTool(registered).execute({ id: 'p1', decision: '改用 SQLite', rationale: '更快' }, { signal: undefined }),
    ).resolves.toBeDefined()
  })
})

describe('host entry dependency shape', () => {
  it('injects only tools, never webServer', () => {
    expect(name).toBe('workmate')
    expect(inject).toEqual(['tools'])
  })

  it('registers every tool and mounts no UI when webServer is absent', () => {
    const { ctx, registered, routes } = fakeCtx({})
    apply(ctx)

    expect(registered).toHaveLength(20)
    expect(registered.map((tool) => (tool as { name: string }).name)).toContain('workmate_metrics')
    expect(registered.map((tool) => (tool as { name: string }).name)).toContain('workmate_bands')
    expect(registered.map((tool) => (tool as { name: string }).name)).toContain('workmate_swarm_plan')
    expect(registered.map((tool) => (tool as { name: string }).name)).toContain('workmate_swarm_task')
    expect(registered.map((tool) => (tool as { name: string }).name)).toContain('workmate_plan_drift')
    expect(registered.map((tool) => (tool as { name: string }).name)).toContain('workmate_assess_risk')
    expect(registered.map((tool) => (tool as { name: string }).name)).toContain('workmate_wiki_generate')
    expect(registered.map((tool) => (tool as { name: string }).name)).toContain('workmate_wiki_export')
    expect(registered.map((tool) => (tool as { name: string }).name)).toContain('workmate_wiki_search')
    // Root resolution is implicit (session cwd / sole registered project), so the
    // schema must not force callers to paste an absolute path.
    const wikiTool = registered.find((tool) => (tool as { name: string }).name === 'workmate_wiki_generate') as {
      parameters: Record<string, { required?: boolean }>
    }
    expect(wikiTool.parameters['projectRoot']?.required).not.toBe(true)
    expect(routes).toEqual([])
  })

  it('mounts the /workmate prefix once webServer exists', () => {
    const { ctx, registered, routes } = fakeCtx({ webServer: { register: () => {} } })
    apply(ctx)

    expect(registered).toHaveLength(20)
    expect(routes.map((route) => ({ kind: route.kind, path: route.path }))).toEqual([
      { kind: 'prefix', path: '/workmate' },
    ])
  })

  it('declares cooperative timeouts and read-only concurrency on the long tools', () => {
    const { ctx, registered } = fakeCtx({})
    apply(ctx)

    const byName = new Map(
      (registered as Array<{ name: string; timeoutMs?: number; isConcurrencySafe?: (args: unknown) => boolean }>).map(
        (definition) => [definition.name, definition],
      ),
    )
    expect(byName.get('workmate_proposal_archive')?.timeoutMs).toBe(15 * 60_000)
    expect(byName.get('workmate_knowledge_query')?.timeoutMs).toBe(120_000)
    expect(byName.get('workmate_knowledge_search')?.timeoutMs).toBe(60_000)

    // `defineTool` validates args before the classifier runs, so these use
    // valid minimal argument sets.
    expect(byName.get('workmate_proposal_status')?.isConcurrencySafe?.({ id: 'p1' })).toBe(true)
    expect(byName.get('workmate_wiki_links')?.isConcurrencySafe?.({ id: 'p1' })).toBe(true)
    expect(
      byName.get('workmate_knowledge_query')?.isConcurrencySafe?.({
        action: 'query',
        target: 'x',
        projectRoot: '/srv/api',
      }),
    ).toBe(true)
    expect(
      byName.get('workmate_knowledge_search')?.isConcurrencySafe?.({ query: 'q', projectRoot: '/srv/api' }),
    ).toBe(true)
    // writers stay exclusive (single-file read-modify-write store)
    expect(byName.get('workmate_proposal_create')?.isConcurrencySafe).toBeUndefined()
    expect(byName.get('workmate_proposal_archive')?.isConcurrencySafe).toBeUndefined()
  })

  it('exposes force on the archive tool parameters', () => {
    const { ctx, registered } = fakeCtx({})
    apply(ctx)

    const archiveTool = (
      registered as Array<{ name: string; parameters: { properties?: Record<string, unknown> } }>
    ).find((definition) => definition.name === 'workmate_proposal_archive')
    expect(archiveTool?.parameters.properties).toHaveProperty('force')
  })

  it('exports the Config schema the host collects (native Schemastery identity)', () => {
    const meta: unknown = Reflect.get(Config, 'meta')
    expect(Reflect.get(Config, Symbol.for('schemastery'))).toBe(true)
    expect(typeof Reflect.get(Config, 'type')).toBe('string')
    expect(meta).not.toBeNull()
    expect(typeof meta).toBe('object')
  })

  it('registers the guidance skills and prompt section when those services exist', () => {
    const skills = { register: vi.fn(() => () => {}) }
    const prompt = { section: vi.fn(() => () => {}) }
    const { ctx } = fakeCtx({ skills, systemPrompt: prompt })
    apply(ctx)

    expect(skills.register).toHaveBeenCalledTimes(4)
    expect(prompt.section).toHaveBeenCalledTimes(1)
  })

  it('stays ACTIVE with no guidance services (tools still register)', () => {
    const { ctx, registered } = fakeCtx({})
    expect(() => apply(ctx)).not.toThrow()
    expect(registered).toHaveLength(20)
  })
})
