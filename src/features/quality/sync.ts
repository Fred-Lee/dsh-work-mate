/**
 * Project quality-asset syncer (change add-proposal-quality-gates, design D1):
 * writes the OpenSpec constraint config, the workmate-review schema and the
 * Claude Code workflow assets into the TARGET project — idempotently. An
 * existing file is never overwritten (Helmsman presets discipline: "synced 0"
 * is correct behaviour, not a failure). The one merge case is
 * `.claude/settings.json`, whose hooks array is deduplicated by the hook
 * command string so user hooks survive untouched.
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateProjectRoot } from '../proposal/openspec.ts'

export interface SyncResult {
  written: string[]
  skipped: string[]
  note?: string
}

export interface SyncOptions {
  /** Absolute dir holding the packaged assets (defaults to dist/assets). */
  assetsDir?: string
}

/** Runtime asset root: <dist>/assets/quality (build.mjs copies assets/ there). */
export function defaultAssetsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'assets', 'quality')
}

const HOOK_ENTRY = {
  matcher: 'Bash(git commit*)',
  hooks: [{ type: 'command', command: 'bash .claude/hooks/check-proposal-tag.sh' }],
} as const

const FILE_COPIES: Array<{ from: string; to: string; mode?: number }> = [
  { from: 'openspec/config.default.yaml', to: 'openspec/config.yaml' },
  { from: 'openspec/schemas/workmate-review/schema.yaml', to: 'openspec/schemas/workmate-review/schema.yaml' },
  { from: 'openspec/schemas/workmate-review/templates/proposal.md', to: 'openspec/schemas/workmate-review/templates/proposal.md' },
  { from: 'openspec/schemas/workmate-review/templates/spec.md', to: 'openspec/schemas/workmate-review/templates/spec.md' },
  { from: 'openspec/schemas/workmate-review/templates/design.md', to: 'openspec/schemas/workmate-review/templates/design.md' },
  { from: 'openspec/schemas/workmate-review/templates/review.md', to: 'openspec/schemas/workmate-review/templates/review.md' },
  { from: 'openspec/schemas/workmate-review/templates/tasks.md', to: 'openspec/schemas/workmate-review/templates/tasks.md' },
  { from: 'claude/rules/knowledge-bridge.md', to: '.claude/rules/knowledge-bridge.md' },
  { from: 'claude/rules/archive.md', to: '.claude/rules/archive.md' },
  { from: 'claude/agents/proposal-auditor.md', to: '.claude/agents/proposal-auditor.md' },
  { from: 'claude/hooks/check-proposal-tag.sh', to: '.claude/hooks/check-proposal-tag.sh', mode: 0o755 },
]

async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path)
    return true
  } catch {
    return false
  }
}

/**
 * Sync all quality assets into the target project. Per-file errors are
 * collected into the note — one unreadable asset must not abort the rest.
 */
export async function syncProjectAssets(projectRoot: string, options: SyncOptions = {}): Promise<SyncResult> {
  const root = validateProjectRoot(projectRoot)
  const assets = options.assetsDir ?? defaultAssetsDir()
  const result: SyncResult = { written: [], skipped: [] }

  for (const copy of FILE_COPIES) {
    const target = join(root, copy.to)
    try {
      if (await exists(target)) {
        result.skipped.push(copy.to)
        continue
      }
      const source = join(assets, copy.from)
      const content = await readFile(source)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content)
      if (copy.mode !== undefined) await chmod(target, copy.mode)
      result.written.push(copy.to)
    } catch (error) {
      result.note = `${result.note ?? ''}${copy.to}: ${error instanceof Error ? error.message : String(error)}; `
    }
  }

  try {
    result.note = await mergeHookEntry(root, result.note)
  } catch (error) {
    result.note = `${result.note ?? ''}.claude/settings.json: ${error instanceof Error ? error.message : String(error)}; `
  }
  return result
}

/** Merge the PreToolUse proposal-tag hook into .claude/settings.json. */
async function mergeHookEntry(root: string, note: string | undefined): Promise<string | undefined> {
  const settingsPath = join(root, '.claude', 'settings.json')
  let settings: Record<string, unknown> = {}
  try {
    settings = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>
  } catch {
    settings = {}
  }

  const hooks = (settings['hooks'] ?? {}) as Record<string, unknown>
  const preList = Array.isArray(hooks['PreToolUse']) ? [...(hooks['PreToolUse'] as object[])] : []
  const already = preList.some((entry) => JSON.stringify(entry) === JSON.stringify(HOOK_ENTRY))
  if (!already) preList.push(HOOK_ENTRY)
  hooks['PreToolUse'] = preList
  settings['hooks'] = hooks

  await mkdir(dirname(settingsPath), { recursive: true })
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  if (already && note === undefined) return undefined
  return note
}
