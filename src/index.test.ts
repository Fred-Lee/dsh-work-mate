/**
 * Host entry shape: `webServer` is provided by the web-app bundle ONLY, so a
 * hard `inject` on it would park the fiber — and with it every `workmate_*`
 * tool — in headless / acp / sdk profiles (change `harden-dsh-plugin-fit`).
 * These tests pin `inject = ['tools']`, the lazy UI mount, the native
 * Schemastery `Config` export and the guidance registrations (change
 * `adopt-dsh-native-config-and-guidance`).
 */
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Config, apply, inject, name } from './index.ts'

const git = (args: string[], cwd: string): Promise<string> =>
  new Promise((resolvePromise, reject) => {
    execFile('git', args, { cwd }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message))
      else resolvePromise(stdout)
    })
  })

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

    expect(registered).toHaveLength(23)
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

    expect(registered).toHaveLength(23)
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
    expect(byName.get('workmate_team_status')?.isConcurrencySafe?.({ runId: 'r1' })).toBe(true)
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
    expect(registered).toHaveLength(23)
  })
})

describe('swarm verify wiring (wire-swarm-independent-review)', () => {
  it('passes the resolved project root to action=verify', async () => {
    // The tool resolves the root for start/merge; verify used to be left out, and since
    // the manager's own `repoRoot` comes from the (usually unset) Config.projectRoot,
    // every verdict degraded to `undetermined` — i.e. the feature was inert in the
    // normal profile. This pins the wiring end to end through the registered tool.
    const project = await mkdtemp(join(tmpdir(), 'wm-entry-swarm-'))
    await git(['init', '-b', 'main'], project)
    await git(['config', 'user.email', 'author@example.com'], project)
    await git(['config', 'user.name', 'author'], project)
    await writeFile(join(project, 'app.txt'), 'one\n', 'utf8')
    await git(['add', '-A'], project)
    await git(['commit', '-m', 'init', '-q'], project)

    const { ctx, registered } = fakeCtx({})
    apply(ctx)
    const service = (ctx as unknown as { workmate: { proposal: { upsert: (input: { id: string; title: string; projects?: string[] }) => Promise<unknown>; patchFields: (id: string, patch: Record<string, unknown>) => Promise<unknown> } } }).workmate.proposal
    await service.upsert({ id: 'p1', title: 'swarm 接线', projects: ['demo'] })
    await service.patchFields('p1', {
      swarmTasks: [{ id: 't1', title: '任务一', writes: ['app.txt'], status: 'merged' }],
    })

    const tool = (registered as Array<{ name: string; execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown> }>)
      .find((definition) => definition.name === 'workmate_swarm_task')
    expect(tool).toBeDefined()

    // No Config.projectRoot, no registry entry for `demo` → it must fall back to the
    // explicit argument, which is what a caller does today.
    const self = (await tool?.execute(
      { id: 'p1', action: 'verify', taskId: 't1', reviewer: 'author', verdict: 'verified', projectRoot: project },
      { signal: undefined },
    )) as { independence: string; warning?: string }
    expect(self.independence).toBe('same-as-author')
    expect(self.warning).toContain('同一身份')

    const other = (await tool?.execute(
      { id: 'p1', action: 'verify', taskId: 't1', reviewer: 'auditor@9', verdict: 'issues', projectRoot: project },
      { signal: undefined },
    )) as { independence: string }
    expect(other.independence).toBe('independent')

    await rm(project, { recursive: true, force: true })
  })

  it('warns when the independence cannot be determined', async () => {
    const { ctx, registered } = fakeCtx({})
    apply(ctx)
    const service = (ctx as unknown as { workmate: { proposal: { upsert: (input: { id: string; title: string }) => Promise<unknown>; patchFields: (id: string, patch: Record<string, unknown>) => Promise<unknown> } } }).workmate.proposal
    await service.upsert({ id: 'p2', title: '无仓库事实' })
    await service.patchFields('p2', {
      swarmTasks: [{ id: 't1', title: '任务一', writes: [], status: 'merged' }],
    })

    const tool = (registered as Array<{ name: string; execute: (args: Record<string, unknown>, exec: unknown) => Promise<unknown> }>)
      .find((definition) => definition.name === 'workmate_swarm_task')
    // A non-git directory: git facts are unreachable, so the verdict is honest about it
    // and the caller is told the gate will treat it as unverified.
    const notARepo = await mkdtemp(join(tmpdir(), 'wm-entry-nogit-'))
    const result = (await tool?.execute(
      { id: 'p2', action: 'verify', taskId: 't1', reviewer: 'auditor@9', verdict: 'verified', projectRoot: notARepo },
      { signal: undefined },
    )) as { independence: string; warning?: string }
    expect(result.independence).toBe('undetermined')
    expect(result.warning).toContain('无法判定')
    await rm(notARepo, { recursive: true, force: true })
  })
})
