/**
 * @helmsman/worktree — DSH plugin entry.
 *
 * Provides the `helmsman.worktree` cordis service. When the community plugin
 * `dsh-virtual-workspace` is present (service name `vws`), each created
 * worktree is additionally registered as a named virtual workspace so agents
 * can address it with `name:/relative/path` via the `vws` tool.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { WorktreeService } from './service.ts'

export const name = '@helmsman/worktree'
export const inject = [] as const

export interface Config {
  /** Directory that holds all Helmsman worktrees. @default ~/.helmsman/worktrees */
  rootDir?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    'helmsman.worktree': WorktreeService
  }
}

interface VwsLike {
  add?: (name: string, dirs: Array<string | { path: string; label?: string }>) => Promise<unknown>
  remove?: (name: string) => Promise<unknown>
}

export function apply(ctx: Context, config: Config = {}) {
  const service = new WorktreeService({ rootDir: config.rootDir ?? join(homedir(), '.helmsman', 'worktrees') })
  ctx.provide('helmsman.worktree', service)

  // Best-effort integration with dsh-virtual-workspace, resolved lazily so it
  // works regardless of plugin load order. Failure never blocks worktrees.
  const resolveVws = (): VwsLike | undefined => ctx.get('vws') as VwsLike | undefined
  const originalCreate = service.createWorktree.bind(service)
  const originalRemove = service.removeWorktree.bind(service)
  service.createWorktree = async (params) => {
    const record = await originalCreate(params)
    try {
      await resolveVws()?.add?.(record.id, [{ path: record.path, label: `helmsman:${record.agent}` }])
    } catch (err) {
      console.warn(`[helmsman/worktree] vws.add failed for ${record.id}:`, err instanceof Error ? err.message : err)
    }
    return record
  }
  service.removeWorktree = async (id) => {
    try {
      await resolveVws()?.remove?.(id)
    } catch {
      // best-effort
    }
    await originalRemove(id)
  }

  console.log(`[helmsman/worktree] service ready (root: ${service.rootDir})`)
}
