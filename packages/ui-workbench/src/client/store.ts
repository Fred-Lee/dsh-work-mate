/**
 * Module-level toggle store shared by the sidebar footer button and the
 * shell.overlay drawer. The two are separate slot registrations with separate
 * component trees, so the open state must live outside React.
 *
 * Both registrations are currently removed (the sidebar entry was dropped, and
 * it was the drawer's only opener), so nothing sets this store today — it is
 * kept so restoring the pair is a two-line change.
 */
let open = false
const listeners = new Set<() => void>()

export const workbenchOpen = {
  get: (): boolean => open,
  set(value: boolean): void {
    if (value === open) return
    open = value
    for (const fn of [...listeners]) fn()
  },
  toggle(): void {
    this.set(!open)
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  },
}
