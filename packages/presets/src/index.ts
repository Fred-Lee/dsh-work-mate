/**
 * @helmsman/presets — DSH plugin entry.
 *
 * Ships 4 agent presets (research / prd / decompose / require-analyze) and
 * registers helmsman_* generation tools. Actual generation runs through the
 * injected `helmsman.generator` service — the DSH session start (T0.1) lives
 * behind that seam, so this package is tool-caller only and unit-testable.
 * Preset dirs are best-effort synced into the roster user-root (T0.2).
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'
import { installPresets, defaultPresetRoot } from './install.ts'
import type { GenerateResult, HelmsmanGenerator, PresetName } from './types.ts'

export const name = '@helmsman/presets'
export const inject = ['tools'] as const

export type { GenerateRequest, GenerateResult, HelmsmanGenerator, PresetName } from './types.ts'
export { installPresets, PRESET_NAMES, defaultPresetRoot } from './install.ts'

export interface Config {
  /** Roster user-root to sync presets into. @default ~/.helmsman/presets */
  presetRoot?: string
}

function generatorOf(ctx: Context): HelmsmanGenerator {
  const generator = ctx.get('helmsman.generator') as HelmsmanGenerator | undefined
  if (!generator) throw new Error('helmsman.generator not available: wire the DSH generation session (T0.1)')
  return generator
}

interface ToolDef {
  name: string
  description: string
  preset: PresetName
  params: Record<string, { required: boolean; description: string }>
}

function registerTool(ctx: Context, def: ToolDef): void {
  const parameters: Record<string, { type: 'string'; required: true; description: string }> = {}
  for (const [key, meta] of Object.entries(def.params)) {
    parameters[key] = { type: 'string', required: true, description: meta.description }
  }
  ctx.tools.register(defineTool({
    name: def.name,
    description: def.description,
    parameters,
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args: Record<string, string>) {
      const result: GenerateResult = await generatorOf(ctx).generate({ preset: def.preset, input: { ...args } })
      return JSON.parse(JSON.stringify(result))
    },
  }))
}

export function apply(ctx: Context, config: Config = {}): void {
  const presetRoot = config.presetRoot ?? defaultPresetRoot()
  // Best-effort sync so DSH's roster discovers the presets (never blocks apply).
  try {
    const synced = installPresets(presetRoot)
    console.log(`[helmsman/presets] synced ${synced.length} preset dirs → ${presetRoot}`)
  } catch (err) {
    console.warn('[helmsman/presets] preset sync failed:', err instanceof Error ? err.message : err)
  }

  registerTool(ctx, {
    name: 'helmsman_research',
    description: 'Run a Deep Research task and produce a research note (L1). Saves a markdown draft.',
    preset: 'research',
    params: { prompt: { required: true, description: 'Research brief / topic.' } },
  })
  registerTool(ctx, {
    name: 'helmsman_generate_prd',
    description: 'Generate a PRD from a research note or requirement (L2). Saves a PRD markdown draft.',
    preset: 'prd',
    params: {
      noteId: { required: false, description: 'Source research note id.' },
      prompt: { required: true, description: 'Requirement / PRD brief.' },
    },
  })
  registerTool(ctx, {
    name: 'helmsman_decompose',
    description: 'Break a PRD into milestones + tasks (L2). Saves structured task JSON.',
    preset: 'decompose',
    params: { prdId: { required: true, description: 'PRD draft id to decompose.' } },
  })
  registerTool(ctx, {
    name: 'helmsman_require_analyze',
    description: 'Analyze a requirement against the knowledge graph: reuse vs build (L4).',
    preset: 'require-analyze',
    params: {
      requirement: { required: true, description: 'New requirement text.' },
      projectGroupId: { required: false, description: 'Project group for the graph.' },
    },
  })
}
