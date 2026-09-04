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
  }>
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
): Promise<{ taskId: string; status: 'completed' | 'failed'; draftId?: string; error?: string; text?: string }> {
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
        await Promise.race([
          agent.whenIdle(),
          new Promise<never>((_, reject) => {
            const timer = setTimeout(() => {
              try { agent.cancel?.() } catch { /* already gone */ }
              reject(new Error(`generation turn exceeded ${TURN_TIMEOUT_MS / 1000}s and was cancelled`))
            }, TURN_TIMEOUT_MS)
            // Do not hold the event loop open for the timer alone.
            timer.unref?.()
          }),
        ])
        console.log(`[helmsman/generator] ${taskId}: turn ended`)
        await sessions?.flush?.(agent.session)
        const text = summarizeSession(agent.session, firstSeq)
        if (!text) throw new Error('generation produced no assistant text')
        // Persist the draft (markdown; decompose tries JSON extraction for a .json twin).
        const dir = draftsDir()
        await mkdir(dir, { recursive: true })
        const draftId = `${preset}-${Date.now().toString(36)}`
        await writeFile(join(dir, `${draftId}.md`), text, 'utf8')
        if (preset === 'decompose') {
          const match = text.match(/\{[\s\S]*\}/)
          if (match) {
            try {
              JSON.parse(match[0])
              await writeFile(join(dir, `${draftId}.json`), match[0], 'utf8')
            } catch {
              // not valid JSON — markdown twin is enough
            }
          }
        }
        return { taskId, status: 'completed', draftId, text }
    } catch (err) {
      return {
        taskId,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      }
  }
}
