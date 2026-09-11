/**
 * helmsman.generator — one-shot DSH preset-session generation engine (T0.1).
 *
 * Mirrors the headless bundle's proven recipe: create an Agent whose setup
 * mounts the requested Helmsman agent preset, drive one followup turn, wait
 * for idle, then summarize the durable session log into draft text.
 *
 * Harness-internal ESM packages (@deepseek-ai/dsh-brand, dsh-llm) are resolved
 * at RUNTIME — first as plain imports, then through a createRequire anchored
 * at process.cwd() (the harness checkout for source-run deployments). The
 * profile's node_modules deliberately does not contain @deepseek-ai packages,
 * so bundling them is not an option.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { PresetName } from './types.ts'

/**
 * Recursion guard. The generated agent sees the host-plane tool registry —
 * including `helmsman_research` — and a research/prd model will happily call
 * that tool, which would fork-bomb new agent sessions. Nested generate() calls
 * execute inside the outer generation's async context, so an ALS marker is a
 * precise, race-free detector.
 */
const generationScope = new AsyncLocalStorage<boolean>()

/** Hard ceiling for one generation turn (ms) — a stuck turn must not burn tokens forever. */
const TURN_TIMEOUT_MS = 240_000

const PRESET_IDS: Record<PresetName, string> = {
  research: 'helmsman-research',
  prd: 'helmsman-prd',
  decompose: 'helmsman-decompose',
  'require-analyze': 'helmsman-require-analyze',
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Resolve a harness-internal package at runtime (profile tree lacks @deepseek-ai). */
async function importHarness(spec: string): Promise<any> {
  try {
    return await import(spec)
  } catch {
    // fall through to anchored resolution
  }
  const bases = [process.cwd(), homedir()]
  for (const base of bases) {
    try {
      const req = createRequire(join(base, 'package.json'))
      const resolved = req.resolve(spec)
      return await import(pathToFileURL(resolved).href)
    } catch {
      // try next base
    }
  }
  throw new Error(`helmsman.generator: cannot resolve harness package ${spec} (is dsh running from its checkout?)`)
}

/** Reimplementation of the headless bundle's summarize(): final assistant text after firstSeq. */
function summarizeSession(session: any, firstSeq: number): string {
  let started = false
  let text = ''
  const length = Number(session.seq)
  for (let seq = firstSeq; seq < length; seq++) {
    const event = session.eventAt(seq)
    if (event === undefined) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = (event.data?.message?.content ?? [])
        .filter((block: any) => block.type === 'text')
        .map((block: any) => block.text)
        .join('')
      if (joined !== '') text = joined
    }
  }
  return text
}

function buildPrompt(preset: PresetName, input: Record<string, unknown>): string {
  const prompt = typeof input.prompt === 'string' ? input.prompt : ''
  const noteId = typeof input.noteId === 'string' ? input.noteId : ''
  const prdId = typeof input.prdId === 'string' ? input.prdId : ''
  switch (preset) {
    case 'research':
      return `请对以下主题做行业研究并输出结构化研究笔记: ${prompt}`
    case 'prd':
      return `请基于以下需求或研究笔记${noteId ? `(笔记 id: ${noteId})` : ''}生成结构化 PRD: ${prompt}`
    case 'decompose':
      return `请把以下 PRD 拆解为里程碑与任务(按你的人格定义输出 JSON): ${prdId || prompt}`
    case 'require-analyze':
      return `请基于知识库分析以下需求, 给出已有资产复用与待新建评估: ${prompt}`
  }
}

export interface GeneratorImpl {
  generate(req: { preset: PresetName; input: Record<string, unknown> }): Promise<{
    taskId: string
    status: 'completed' | 'failed'
    draftId?: string
    error?: string
    text?: string
    /** Delivery artifacts registered for the produced draft bytes (when the
     * `helmsman.artifacts` registry is present). */
    artifacts?: RegisteredArtifact[]
  }>
}

/**
 * Structural surface of @helmsman/artifacts consumed by the generator — the
 * plugin is OPTIONAL, so we never `inject` it; `ctx.get('helmsman.artifacts')`
 * may be undefined and generation must degrade gracefully (design.md D1).
 */
export interface ArtifactRegisterLike {
  register(input: {
    type: string
    fileName: string
    bytes: Uint8Array
    meta?: Record<string, unknown>
    keepMeta?: boolean
  }): Promise<{ id: string; duplicate: boolean }>
}

export interface RegisteredArtifact {
  id: string
  fileName: string
  type: string
  duplicate: boolean
}

export interface DraftArtifactOpts {
  preset: PresetName
  draftId: string
  /** Markdown twin written to `drafts/<draftId>.md`. */
  text: string
  /** Optional `.json` twin written by decompose (JSON extraction). */
  json?: string
}

/**
 * Registers the bytes of a freshly generated draft with the content-addressed
 * artifact registry (one artifact per written file). Re-generating identical
 * content is deduped structurally by the store (same bytes → same id).
 */
export async function registerDraftArtifacts(
  artifacts: ArtifactRegisterLike,
  opts: DraftArtifactOpts,
): Promise<RegisteredArtifact[]> {
  const out: RegisteredArtifact[] = []
  const register = async (fileName: string, text: string): Promise<void> => {
    const meta: Record<string, unknown> = {
      producer: 'workbench:generator',
      preset: opts.preset,
      draftId: opts.draftId,
    }
    const res = await artifacts.register({
      type: 'draft',
      fileName,
      bytes: new TextEncoder().encode(text),
      meta,
    })
    out.push({ id: res.id, fileName, type: 'draft', duplicate: res.duplicate })
  }
  await register(`${opts.draftId}.md`, opts.text)
  if (opts.json !== undefined) await register(`${opts.draftId}.json`, opts.json)
  return out
}

/**
 * Best-effort draft registration through the live context: reads the optional
 * `helmsman.artifacts` service and registers the generated bytes. Generation
 * is NEVER blocked by a missing or failing registry — the draft file is the
 * source of truth and artifact delivery is a bonus layer (design.md D5).
 */
async function registerGeneratedDraft(
  ctx: Context,
  opts: DraftArtifactOpts,
): Promise<RegisteredArtifact[] | undefined> {
  const artifacts = artifactServiceFrom(ctx)
  if (!artifacts) return undefined
  try {
    return await registerDraftArtifacts(artifacts, opts)
  } catch (err) {
    console.warn(
      `[helmsman/generator] draft artifact registration failed (draft kept on disk): ${err instanceof Error ? err.message : String(err)}`,
    )
    return undefined
  }
}

/** Reads the optional artifact service off the context (undefined when absent). */
export function artifactServiceFrom(ctx: Context): ArtifactRegisterLike | undefined {
  // ctx is a cordis proxy: property reads of a provided service resolve; an
  // unprovided name (plugin not installed) yields undefined — never throws.
  return (ctx as unknown as Record<string, unknown>)['helmsman.artifacts'] as ArtifactRegisterLike | undefined
}

/** Draft dir under HELMSMAN_HOME. */
export function draftsDir(): string {
  const base = process.env.HELMSMAN_HOME ?? join(homedir(), '.helmsman')
  return join(base, 'workbench', 'drafts')
}

export function createGenerator(ctx: Context): GeneratorImpl {
  const run = (req: { preset: PresetName; input: Record<string, unknown> }) => runGenerate(ctx, req)
  return {
    generate(req) {
      if (generationScope.getStore() === true) {
        // Agent-initiated nested call: refuse with an error (no fake taskId —
        // a synthesized "failed task" record used to confuse downstream agents).
        throw new Error('helmsman.generator: 嵌套生成已拒绝 — 你已处于 Helmsman 生成会话中,请直接作答,不要再调用 helmsman_* 生成工具')
      }
      return generationScope.run(true, () => run(req))
    },
  }
}

async function runGenerate(
  ctx: Context,
  { preset, input }: { preset: PresetName; input: Record<string, unknown> },
): Promise<{ taskId: string; status: 'completed' | 'failed'; draftId?: string; error?: string; text?: string; artifacts?: RegisteredArtifact[] }> {
      const taskId = `gen-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
      const store = ctx as unknown as Record<string, any>
      try {
        // Await the complete application so scoped tools/adapters are composed.
        console.log(`[helmsman/generator] ${taskId}: awaiting loader`)
        await store.loader?.await?.()
        console.log(`[helmsman/generator] ${taskId}: loader settled`)
        const agents = store.agents
        const defaultModel = store.agentDefaultModel
        const sessions = store.sessions
        const presets = store.agentPresets
        if (!agents || !defaultModel) {
          throw new Error('agents/agentDefaultModel services unavailable in this profile')
        }
        const { brandString } = await importHarness('@deepseek-ai/dsh-brand')
        const { createUserMessage } = await importHarness('@deepseek-ai/dsh-llm')
        const selection = defaultModel.currentSelection()
        const presetId = PRESET_IDS[preset] ?? 'helmsman-research'
        console.log(`[helmsman/generator] ${taskId}: creating agent (preset=${presetId}, provider=${selection.provider}, model=${selection.model})`)
        const { agent } = await agents.create({
          sessionId: brandString(`helmsman-${randomUUID()}`),
          meta: { cwd: process.cwd() },
          agentOptions: { provider: selection.provider, model: selection.model },
          setup: async (agentCtx: any) => {
            // Join the Helmsman preset so the session gets the research/prd persona.
            if (presets?.mount) await presets.mount(agentCtx, presetId)
          },
        })
        console.log(`[helmsman/generator] ${taskId}: agent created, waiting idle`)
        await agent.whenIdle()
        console.log(`[helmsman/generator] ${taskId}: idle before followup`)
        const firstSeq = Number(agent.session.seq)
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: buildPrompt(preset, input) }],
          source: { kind: 'user' },
        }))
        console.log(`[helmsman/generator] ${taskId}: followup dispatched, awaiting turn end`)
        let timeoutTimer: NodeJS.Timeout | undefined
        try {
          await Promise.race([
            agent.whenIdle(),
            new Promise<never>((_, reject) => {
              timeoutTimer = setTimeout(() => {
                try { agent.cancel?.() } catch { /* already gone */ }
                reject(new Error(`generation turn exceeded ${TURN_TIMEOUT_MS / 1000}s and was cancelled`))
              }, TURN_TIMEOUT_MS)
              // Do not hold the event loop open for the timer alone.
              timeoutTimer.unref?.()
            }),
          ])
        } finally {
          if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
        }
        console.log(`[helmsman/generator] ${taskId}: turn ended`)
        await sessions?.flush?.(agent.session)
        const text = summarizeSession(agent.session, firstSeq)
        if (!text) throw new Error('generation produced no assistant text')
        // Persist the draft (markdown; decompose tries JSON extraction for a .json twin).
        // Random suffix: same-preset same-millisecond writes must not clobber.
        const dir = draftsDir()
        await mkdir(dir, { recursive: true })
        const draftId = `${preset}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
        await writeFile(join(dir, `${draftId}.md`), text, 'utf8')
        let jsonTwin: string | undefined
        if (preset === 'decompose') {
          const match = text.match(/\{[\s\S]*\}/)
          if (match) {
            try {
              JSON.parse(match[0])
              jsonTwin = match[0]
              await writeFile(join(dir, `${draftId}.json`), jsonTwin, 'utf8')
            } catch {
              // not valid JSON — markdown twin is enough
            }
          }
        }
        // Register the produced bytes as delivery artifacts (optional registry:
        // when `helmsman.artifacts` is absent, drafts stay plain local files).
        const artifacts = await registerGeneratedDraft(ctx, { preset, draftId, text, json: jsonTwin })
        return { taskId, status: 'completed', draftId, text, artifacts }
    } catch (err) {
      return {
        taskId,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      }
  }
}
