/**
 * DSH client-module entry (ModuleLoader CJS bundle). Three registrations, each
 * behind its OWN optional dependency:
 *
 *  1. better-sidebar tab 「🛠 WorkMate」 — the full kanban panel
 *  2. assistant-message action row 「🚀 转为提案」 — the scene switch at the end
 *     of a brainstorm reply
 *  3. input tool area 「🚀 转为提案」 — the same switch beside the attach button
 *     (`conversation.input.left`)
 *  4. NATIVE WORKBENCH: the `main` central panel keyed `workmate` plus the
 *     matching `sidebar.panellist` rail icon — the host's own "panel selected by
 *     sidebar entry id" model, so WorkMate is a workbench in the centre rather
 *     than one more tab in the right dock.
 *
 * No hard `inject`: `betterSidebar` is a THIRD-PARTY service
 * (`dsh-better-sidebar`), so declaring it at module level would park the whole
 * client half — including the two `slots` entries that only need the
 * first-party slot registry — whenever that plugin is absent or disabled.
 * Everything is registered through reactive `ctx.inject([...], …)` instead.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import './slot-types'
import './better-sidebar-types'
import { ProposalPanel } from './App'
import { ChatProposalAction } from './ChatProposalAction'
import { WorkmatePanelIcon } from './PanelIcon'
import {
  ASSISTANT_ACTIONS,
  INPUT_LEFT,
  MAIN_PANEL,
  SIDEBAR_PANELLIST,
  WORKMATE_PANEL_ID,
} from './slot-types'

/** Optional services only: the module itself has no hard dependency. */
export const inject = [] as const

export function apply(ctx: ClientContext): void {
  ctx.inject(['betterSidebar'], (scope: ClientContext) => {
    scope.effect(() =>
      scope.betterSidebar.registerTab({
        id: 'workmate:proposals',
        title: '🛠 WorkMate',
        single: true,
        order: 45,
        component: () => <ProposalPanel />,
      }),
    )
  })

  ctx.inject(['slots'], (scope: ClientContext) => {
    scope.effect(() =>
      scope.slots.inject(ASSISTANT_ACTIONS, () =>
        scope.slots.register(
          {
            name: ASSISTANT_ACTIONS,
            id: 'workmate:save-as-proposal',
            order: 25,
            inject: (sessionId: string) => ({ sessionId }),
          },
          ChatProposalAction,
        ),
      ),
    )
    scope.effect(() =>
      scope.slots.inject(INPUT_LEFT, () =>
        scope.slots.register(
          {
            name: INPUT_LEFT,
            id: 'workmate:input-trigger',
            order: 10,
          },
          ChatProposalAction,
        ),
      ),
    )

    // Native workbench: registering the `main` key makes WorkMate a central
    // panel; the `sidebar.panellist` entry with the same id is the rail button
    // the shell resolves that key from. Both are independent effects, so a host
    // that ships only one of the two slots still gets what it has.
    scope.effect(() =>
      scope.slots.inject(MAIN_PANEL, () =>
        scope.slots.register(
          {
            name: MAIN_PANEL,
            key: WORKMATE_PANEL_ID,
          },
          ProposalPanel,
        ),
      ),
    )
    scope.effect(() =>
      scope.slots.inject(SIDEBAR_PANELLIST, () =>
        scope.slots.register(
          {
            name: SIDEBAR_PANELLIST,
            id: WORKMATE_PANEL_ID,
            order: 20,
            label: () => 'WorkMate',
          },
          WorkmatePanelIcon,
        ),
      ),
    )
  })

  console.log('[workmate/client] tab + chat entries + workbench panel registered')
}
