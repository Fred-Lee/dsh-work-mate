/**
 * DSH client-module entry (ModuleLoader CJS bundle). Registers the
 * better-sidebar tab 「🛠 WorkMate」 rendering the same ProposalPanel the
 * standalone page uses (design D5).
 *
 * `betterSidebar` is the module-level inject (hard dep, workbench-proven);
 * the component defers data errors to its own inline states, so a REST hiccup
 * renders as a message, never a blank tab.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import './better-sidebar-types'
import { ProposalPanel } from './App'

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
  console.log('[workmate/client] better-sidebar tab registered')
}
