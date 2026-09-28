/**
 * DSH client-module entry (ModuleLoader CJS bundle). Three registrations:
 *
 *  1. better-sidebar tab 「🛠 WorkMate」 — the full kanban panel (workbench-proven)
 *  2. assistant-message action row 「🚀 转为提案」 — the scene switch at the end
 *     of a brainstorm reply (ui-workbench「保存为任务」-proven)
 *  3. input tool area 「🚀 转为提案」 — the same switch beside the attach button
 *     (`conversation.input.left`, Codingns4DSH quick-phrase position)
 *
 * The tab registry is the module-level inject (hard dep). `slots` is OPTIONAL
 * by design: declared nowhere in module-level inject, activated through
 * `ctx.inject(['slots'], …)` so a missing slot registry can never park the
 * client half — and take the tab down with it.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import './slot-types'
import './better-sidebar-types'
import { ProposalPanel } from './App'
import { ChatProposalAction } from './ChatProposalAction'
import { ASSISTANT_ACTIONS, INPUT_LEFT } from './slot-types'

/** Required service: the better-sidebar tab registry. */
export const inject = ['betterSidebar'] as const

export function apply(ctx: ClientContext): void {
  ctx.effect(() =>
    ctx.betterSidebar.registerTab({
      id: 'workmate:proposals',
      title: '🛠 WorkMate',
      single: true,
      order: 45,
      component: () => <ProposalPanel />,
    }),
  )

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
  })

  console.log('[workmate/client] tab + chat entries registered')
}
