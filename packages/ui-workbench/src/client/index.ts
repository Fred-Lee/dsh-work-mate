/**
 * DSH client-module inject path — this is what a third-party plugin uses to add
 * a panel/entry to the DSH web shell.
 *
 * NOTE (T0.4): this file is the browser half that a DSH client bundle would
 * host. It registers the workbench view into the `shell.overlay` slot via
 * `ctx.slots`/`ctx.slots.inject`. Whether the DSH web shell actually loads a
 * third-party client bundle is the T0.4 spike; this file documents the exact
 * inject surface we target so the spike has a concrete shape.
 */
import type { App } from './App'

// The `slots` service is provided by the DSH client shell at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SlotCtx = any

export const inject = ['slots', 'layout'] as const

export function apply(ctx: SlotCtx): void {
  // `shell.overlay` is a list-type slot; add our panel as an additive entry.
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'helmsman:workbench',
        label: '🚀 Helmsman',
      },
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      () => import('./App') as unknown as typeof App,
    ),
  )
}
