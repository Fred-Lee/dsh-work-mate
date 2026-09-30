/**
 * Guidance contracts (change `adopt-dsh-native-config-and-guidance`): the flow
 * and audit skills ship with the plugin instead of relying on Claude-Code-only
 * files, and both contributions degrade silently when their service is absent.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { registerGuidance } from './index.ts'
import type { PromptSectionFace, RuntimeSkill } from './faces.ts'

interface FakeSkills {
  register: ReturnType<typeof vi.fn<(skill: RuntimeSkill) => () => void>>
}

interface FakePrompt {
  section: ReturnType<typeof vi.fn<(section: PromptSectionFace) => () => void>>
  getSectionOrder?: (name: string) => number
}

/** Reactive-inject context: callbacks run only for available services. */
function fakeCtx(available: Record<string, unknown>): {
  ctx: Context
  skills: FakeSkills | undefined
  prompt: FakePrompt | undefined
} {
  const skills = available['skills'] as FakeSkills | undefined
  const prompt = available['systemPrompt'] as FakePrompt | undefined
  const scope = { ...available, effect: (fn: () => unknown) => fn() }
  const ctx = {
    ...available,
    effect: (fn: () => unknown) => fn(),
    inject: (deps: readonly string[], callback: (scope: unknown) => void) => {
      if (deps.every((dep) => available[dep] !== undefined)) callback(scope)
      return {}
    },
  }
  return { ctx: ctx as unknown as Context, skills, prompt }
}

function fakeSkills(): FakeSkills {
  return { register: vi.fn((_skill: RuntimeSkill) => () => {}) }
}

function fakePrompt(order?: number): FakePrompt {
  return {
    section: vi.fn((_section: PromptSectionFace) => () => {}),
    ...(order !== undefined ? { getSectionOrder: () => order } : {}),
  }
}

describe('registerGuidance', () => {
  it('registers both skills and the flow section when the services exist', () => {
    const skills = fakeSkills()
    const prompt = fakePrompt(2600)
    const { ctx } = fakeCtx({ skills, systemPrompt: prompt })
    registerGuidance(ctx)

    expect(skills.register.mock.calls.map((call) => call[0].name)).toEqual([
      'workmate-proposal-flow',
      'workmate-proposal-audit',
    ])
    const flow = skills.register.mock.calls[0]?.[0] as RuntimeSkill
    expect(flow.description).toContain('WorkMate')
    expect(flow.content).toContain('workmate_proposal_block')
    expect(flow.content).toContain('supersedes')

    expect(prompt.section).toHaveBeenCalledTimes(1)
    const section = prompt.section.mock.calls[0]?.[0] as PromptSectionFace
    expect(section.name).toBe('tool:workmate')
    expect(section.order).toBe(2600)
  })

  it('falls back to the documented TOOL_WORKFLOW position on hosts without getSectionOrder', () => {
    const skills = fakeSkills()
    const prompt = fakePrompt(undefined)
    const { ctx } = fakeCtx({ skills, systemPrompt: prompt })
    registerGuidance(ctx)

    expect((prompt.section.mock.calls[0]?.[0] as PromptSectionFace).order).toBe(2600)
  })

  it('degrades silently when neither service is present', () => {
    const { ctx, skills, prompt } = fakeCtx({})
    expect(() => registerGuidance(ctx)).not.toThrow()
    expect(skills).toBeUndefined()
    expect(prompt).toBeUndefined()
  })

  it('registers skills even when systemPrompt is missing (and vice versa)', () => {
    const skills = fakeSkills()
    const first = fakeCtx({ skills })
    registerGuidance(first.ctx)
    expect(skills.register).toHaveBeenCalledTimes(2)

    const prompt = fakePrompt(2600)
    const second = fakeCtx({ systemPrompt: prompt })
    registerGuidance(second.ctx)
    expect(prompt.section).toHaveBeenCalledTimes(1)
  })
})
