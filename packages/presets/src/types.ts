/** @helmsman/presets shared types — the generation contract (DI seam). */

export type PresetName = 'research' | 'prd' | 'decompose' | 'require-analyze'

export interface GenerateRequest {
  preset: PresetName
  /** Arbitrary per-preset input (e.g. { prompt } for research, { prdId } for decompose). */
  input: Record<string, unknown>
}

export interface GenerateResult {
  taskId: string
  status: string
  draftId?: string
}

/**
 * The generation engine seam. Tools call `ctx.get('helmsman.generator')`; the
 * actual DSH session start (T0.1) lives behind this interface, so the presets
 * tools are unit-testable with a fake generator and decoupled from DSH internals.
 */
export interface HelmsmanGenerator {
  generate(req: GenerateRequest): Promise<GenerateResult>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    'helmsman.generator': HelmsmanGenerator
  }
}
