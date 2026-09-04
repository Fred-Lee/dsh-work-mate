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
  const base = process.env.HELMSMAN_HOME ?? join(homedir(), '.helmsman')
  return join(base, 'presets')
}

export function bundlePresetDir(): string {
  // dist/index.js bundled → package root /presets
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'presets')
}

/** Copy the bundled presets into the target roster root. Returns synced paths. */
export function installPresets(target = defaultPresetRoot()): string[] {
  const src = bundlePresetDir()
  if (!existsSync(src)) return []
  mkdirSync(target, { recursive: true })
  const synced: string[] = []
  for (const name of PRESET_NAMES) {
    const fromDir = join(src, name)
    if (!existsSync(fromDir)) continue
    cpSync(fromDir, join(target, name), { recursive: true, force: true })
    synced.push(join(target, name))
  }
  return synced
}
