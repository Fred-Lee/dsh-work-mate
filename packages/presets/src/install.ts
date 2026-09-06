/**
 * installPresets — copy this package's `presets/` dirs into the preset roster
 * root so DSH's agent-preset discovery (T0.2, user/trusted roots) picks them
 * up. Synchronous (cpSync) so plugin `apply` is deterministic and testable —
 * no fire-and-forget race with teardown. A copy/config error never blocks apply.
 */
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export const PRESET_NAMES = ['helmsman-research', 'helmsman-prd', 'helmsman-decompose', 'helmsman-require-analyze'] as const

export function defaultPresetRoot(): string {
  // DSH's agent-preset discovery scans <DSH_HOME>/.agent-presets as the
  // writable user root (USER_PRESET_DIR) — presets copied there are picked up
  // without restart-free roster changes (discovery is unmemoized).
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(dshHome, '.agent-presets')
}

export function bundlePresetDir(): string {
  // dist/index.js bundled → package root /presets
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'presets')
}

/** Copy the bundled presets into the target roster root. Returns synced paths.
 *
 * The roster root is USER-EDITABLE (DSH treats `.agent-presets` as the
 * copy-only authoring root), so existing preset dirs are NEVER overwritten —
 * clobbering would silently destroy a user's customized persona. New presets
 * and directories whose contents are missing are installed; to force-reinstall
 * a preset, delete its directory first.
 */
export function installPresets(target = defaultPresetRoot()): string[] {
  const src = bundlePresetDir()
  if (!existsSync(src)) return []
  mkdirSync(target, { recursive: true })
  const synced: string[] = []
  for (const name of PRESET_NAMES) {
    const fromDir = join(src, name)
    if (!existsSync(fromDir)) continue
    const toDir = join(target, name)
    if (existsSync(toDir)) {
      // Never clobber user-authored presets. Only backfill missing files
      // (e.g. a preset dir exists but agent.cordis.yml was deleted).
      const marker = join(toDir, 'agent.cordis.yml')
      if (existsSync(marker)) continue
      cpSync(join(fromDir, 'agent.cordis.yml'), marker)
    } else {
      cpSync(fromDir, toDir, { recursive: true })
    }
    synced.push(toDir)
  }
  return synced
}
