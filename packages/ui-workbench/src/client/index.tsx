/**
 * DSH client-module inject path — the browser half a third-party plugin uses
 * to add an entry + panel to the DSH web shell (T0.4, verified against the
 * DSH slot contracts).
 *
 * One registration:
 *  `betterSidebar.registerTab` — the「🚀 Helmsman」tab in the right sidebar's
 *  `+` menu, beside the built-in Files / Terminal / Memory tabs
 *  (single-instance), rendering the full workbench view.
 *
 * The former LEFT-SIDEBAR entry (`sidebar.footer.action`, the「🚀 Helmsman」
 * button beside Settings) was removed on request. That button was the only
 * opener of the `shell.overlay` drawer, so the drawer registration went with
 * it — an overlay nothing can open is just dead weight. Both components are
 * still exported from `./App` (`WorkbenchToggle`, `WorkbenchDrawer`) along
 * with the shared `workbenchOpen` store, so restoring a sidebar entry is a
 * two-line change: re-register the slot and the overlay.
 *
 * This file is the entry DSH's module-loader activates (dsh.client →
 * exports['./client']). It mounts nothing on its own — the tab registration is
 * declarative and the registry waits for the tab registry to be present.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import './better-sidebar-types'
import { App as WorkbenchView } from './App'
import type { TabDescriptor } from './better-sidebar-types'

/** Required service: the better-sidebar tab registry. */
export const inject = ['betterSidebar'] as const

export function apply(ctx: ClientContext): void {
  // The workbench as a better-sidebar tab — the same place the built-in
  // Files/Terminal/Memory tabs live (single-instance, + menu).
  ctx.effect(() => ctx.betterSidebar.registerTab({
    id: 'helmsman:workbench',
    title: '🚀 Helmsman',
    single: true,
    order: 40,
    component: () => <WorkbenchView />,
  } satisfies TabDescriptor))
}
