// @vitest-environment jsdom
/**
 * Client-half dependency shape (change harden-dsh-plugin-fit):
 *
 * `betterSidebar` is a THIRD-PARTY service (`dsh-better-sidebar`). Declaring it
 * in the module-level `inject` would park the whole client half — including the
 * two `slots` entries that only need the first-party slot registry — whenever
 * that plugin is absent or disabled. These tests pin the decoupled shape.
 */
import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from './index'

function fakeSlots() {
  return {
    register: vi.fn((_options: { name: string; id?: string }, _component: unknown) => () => {}),
    inject: vi.fn((_key: string, effect: () => unknown) => {
      effect()
      return () => {}
    }),
  }
}

function fakeSidebar() {
  return { registerTab: vi.fn((_descriptor: { id: string }) => () => {}) }
}

/** Minimal reactive-inject context: callbacks run only for available services. */
function fakeCtx(available: Record<string, unknown>): {
  ctx: never
  slots: ReturnType<typeof fakeSlots> | undefined
  sidebar: ReturnType<typeof fakeSidebar> | undefined
} {
  const slots = available['slots'] as ReturnType<typeof fakeSlots> | undefined
  const sidebar = available['betterSidebar'] as ReturnType<typeof fakeSidebar> | undefined
  const scopeFor = (): Record<string, unknown> => ({
    ...available,
    effect: (fn: () => unknown) => fn(),
    inject: () => ({}),
  })
  const ctx = {
    ...available,
    effect: (fn: () => unknown) => fn(),
    inject: (deps: readonly string[], callback: (scope: never) => void) => {
      if (deps.every((dep) => available[dep] !== undefined)) callback(scopeFor() as never)
      return {}
    },
  }
  return { ctx: ctx as never, slots, sidebar }
}

describe('client module dependency shape', () => {
  it('declares no hard service dependency', () => {
    expect(inject).toEqual([])
  })

  it('registers the chat entries and the native workbench when only slots exists', () => {
    const { ctx, slots, sidebar } = fakeCtx({ slots: fakeSlots() })
    apply(ctx)

    expect(slots?.register).toHaveBeenCalledTimes(4)
    expect(slots?.register.mock.calls.map((call) => (call[0] as { name: string }).name)).toEqual([
      'conversation.chat.assistant-actions',
      'conversation.input.left',
      'main',
      'sidebar.panellist',
    ])
    // The workbench panel keys `main` and the rail icon shares the same id.
    expect(slots?.register.mock.calls[2]?.[0]).toMatchObject({ name: 'main', key: 'workmate' })
    expect(slots?.register.mock.calls[3]?.[0]).toMatchObject({ name: 'sidebar.panellist', id: 'workmate' })
    expect(sidebar).toBeUndefined()
  })

  it('registers the tab when only better-sidebar exists (no slot registry)', () => {
    const { ctx, slots, sidebar } = fakeCtx({ betterSidebar: fakeSidebar() })
    apply(ctx)

    expect(sidebar?.registerTab).toHaveBeenCalledTimes(1)
    expect(slots).toBeUndefined()
  })

  it('registers the tab plus the slots entries when both services exist', () => {
    const { ctx, slots, sidebar } = fakeCtx({ slots: fakeSlots(), betterSidebar: fakeSidebar() })
    apply(ctx)

    expect(sidebar?.registerTab).toHaveBeenCalledTimes(1)
    expect(slots?.register).toHaveBeenCalledTimes(4)
    expect(sidebar?.registerTab.mock.calls[0]?.[0]).toMatchObject({ id: 'workmate:proposals' })
  })
})
