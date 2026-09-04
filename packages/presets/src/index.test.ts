import { mkdtemp, rm } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply } from './index.ts'
import { installPresets, PRESET_NAMES } from './install.ts'
import type { HelmsmanGenerator } from './types.ts'
import type { Context } from '@deepseek-ai/cordis'

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'presets-'))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function fakeContext(generator?: HelmsmanGenerator): Context & { tools: { register: ReturnType<typeof vi.fn> } } {
  const tools = { register: vi.fn() }
  const ctx = { tools, get: (_key: string) => generator } as unknown as Context & { tools: { register: ReturnType<typeof vi.fn> } }
  return ctx
}

describe('@helmsman/presets tools', () => {
  it('registers 4 generation tools', () => {
    const ctx = fakeContext({ generate: vi.fn() })
    apply(ctx, { presetRoot: join(tmp, 'roster') })
    expect(ctx.tools.register).toHaveBeenCalledTimes(4)
  })

  it('calls the generator with the right preset and input', async () => {
    const generate = vi.fn().mockResolvedValue({ taskId: 't1', status: 'queued' })
    const ctx = fakeContext({ generate })
    apply(ctx, { presetRoot: join(tmp, 'roster') })
    const researchTool = ctx.tools.register.mock.calls.find(([t]) => t.name === 'helmsman_research')[0]
    const res = await researchTool.execute({ prompt: '教育批改 SaaS' })
    expect(res).toEqual({ taskId: 't1', status: 'queued' })
    expect(generate).toHaveBeenCalledWith({ preset: 'research', input: { prompt: '教育批改 SaaS' } })
  })

  it('throws a clear error when no generator is wired', async () => {
    const ctx = fakeContext(undefined)
    apply(ctx, { presetRoot: join(tmp, 'roster') })
    const prdTool = ctx.tools.register.mock.calls.find(([t]) => t.name === 'helmsman_generate_prd')[0]
    await expect(prdTool.execute({ prompt: 'x', noteId: 'n1' })).rejects.toThrow(/helmsman\.generator not available/)
  })
})

describe('installPresets', () => {
  it('copies all 4 preset dirs into the target root', () => {
    const target = join(tmp, 'roster')
    const synced = installPresets(target)
    expect(synced.length).toBe(4)
    const dirs = readdirSync(target)
    expect(dirs.sort()).toEqual([...PRESET_NAMES].sort())
  })
})
