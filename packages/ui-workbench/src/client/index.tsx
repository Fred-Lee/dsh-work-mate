/**
 * DSH client-module inject path — the browser half a third-party plugin uses
 * to add an entry + panel to the DSH web shell (T0.4, verified against the
 * DSH slot contracts).
 *
 * Two additive registrations, matching the official pattern (ui-brand-official
 * / ui-layout contracts):
 *  1. `sidebar.footer.action` (list, declared by ui-sidebar) — the「🚀 Helmsman」
 *     entry button beside Settings at the sidebar foot.
 *  2. `shell.overlay` (list, declared by ui-layout) — the frame-wide floating
 *     layer; our entry is a self-drawn right-side drawer (position:fixed, own
 *     chrome, pointer-events:auto on its own box only), NOT a bare component:
 *     the overlay layer is click-through and unstyled, so a panel there must
 *     bring its own container.
 *
 * This file is the entry DSH's module-loader activates (dsh.client →
 * exports['./client']). It mounts nothing on its own — slot registration is
 * declarative and the registry waits for slot declarations.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import './slot-types'
import './better-sidebar-types'
import { App as WorkbenchView, WorkbenchDrawer, WorkbenchToggle } from './App'
import type { TabDescriptor } from './better-sidebar-types'

/** Required services: the UI slot registry + the better-sidebar tab registry. */
export const inject = ['slots', 'betterSidebar'] as const

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.footer.action', function* () {
    yield ctx.slots.register(
      { name: 'sidebar.footer.action', id: 'helmsman:workbench-toggle', label: 'Helmsman' },
      WorkbenchToggle,
    )
  })
  ctx.slots.inject('shell.overlay', function* () {
    yield ctx.slots.register(
      { name: 'shell.overlay', id: 'helmsman:workbench-panel' },
      WorkbenchDrawer,
    )
  })
  // Mount the workbench as a better-sidebar tab too — the same place the
  // built-in Files/Terminal/Memory tabs live (single-instance, + menu).
  ctx.effect(() => ctx.betterSidebar.registerTab({
    id: 'helmsman:workbench',
    title: '🚀 Helmsman',
    single: true,
    order: 40,
    component: () => <WorkbenchView />,
  } satisfies TabDescriptor))
}
