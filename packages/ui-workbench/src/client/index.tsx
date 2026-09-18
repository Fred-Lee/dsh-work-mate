/**
 * DSH client-module inject path — the browser half a third-party plugin uses
 * to add entries to the DSH web shell.
 *
 * Two registrations:
 *  `betterSidebar.registerTab` — the「🚀 Helmsman」tab in the right sidebar's
 *  `+` menu, beside the built-in Files / Terminal / Memory tabs
 *  (single-instance), rendering the full workbench view.
 *
 *  `slots` → `conversation.chat.assistant-actions` — the「💾 保存为任务」 action
 *  on an assistant message's action row (change `add-task-kanban-board` task
 *  5.4). It cuts a task card from the CURRENT conversation through the existing
 *  host route; see `SaveAsTaskAction.tsx` / `save-as-task.ts`.
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
 * exports['./client']). It mounts nothing on its own — both registrations are
 * declarative and wait for their registries to be present.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import './better-sidebar-types'
import './slot-types'
import { App as WorkbenchView } from './App'
import { SaveAsTaskAction } from './SaveAsTaskAction'
import type { TabDescriptor } from './better-sidebar-types'

/** Required service: the better-sidebar tab registry. */
export const inject = ['betterSidebar'] as const

/** The chat-message action row declared by ui-chat (list / session scope). */
const ASSISTANT_ACTIONS = 'conversation.chat.assistant-actions'

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

  // 「保存为任务」. `slots` is deliberately NOT in the module-level `inject`:
  // that declaration is a hard dependency, and a missing one parks the WHOLE
  // client half in PENDING — taking the Helmsman tab above down with it. This
  // local scope activates the registration only while the slot registry is
  // actually up, and removes it when the registry goes away.
  ctx.inject(['slots'], (scope: ClientContext) => {
    scope.effect(() =>
      scope.slots.inject(ASSISTANT_ACTIONS, () =>
        scope.slots.register(
          {
            name: ASSISTANT_ACTIONS,
            // A fresh id: reusing a host entry's id at the same priority throws.
            id: 'helmsman:save-as-task',
            order: 20,
            // Session-scoped slot ⇒ the framework hands us the resolved session.
            inject: (sessionId: string) => ({ sessionId }),
          },
          SaveAsTaskAction,
        ),
      ),
    )
  })
}
