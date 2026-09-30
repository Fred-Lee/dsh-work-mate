/**
 * Project quality-asset syncer (change add-proposal-quality-gates, design D1;
 * split into OpenSpec / Claude sets by `adopt-dsh-native-config-and-guidance`):
 * writes the OpenSpec constraint config + the workmate-review schema and, when
 * enabled, the Claude Code workflow assets into the TARGET project —
 * idempotently. An existing file is never overwritten (Helmsman presets
 * discipline: "synced 0" is correct behaviour, not a failure). The one merge
 * case is `.claude/settings.json`, whose hooks array is deduplicated by the
 * hook command string so user hooks survive untouched.
 *
 * Why the split: DSH never reads `.claude/**` (the only reader is the
 * first-party `@deepseek-ai/dsh-hooks-claude-code` bridge, which this profile
 * does not load) — those files serve people running Claude Code in the same
 * repository, so they are behind `Config.claudeAssetsEnabled`. The OpenSpec
 * assets are the ones the review gate depends on and always ship.
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
  /** Also distribute the Claude Code asset set. @default true */
  claudeAssets?: boolean
}

/** Runtime asset root: <dist>/assets/quality (build.mjs copies assets/ there). */
export function defaultAssetsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'assets', 'quality')
}

const HOOK_ENTRY = {
  matcher: 'Bash(git commit*)',
  hooks: [{ type: 'command', command: 'bash .claude/hooks/check-proposal-tag.sh' }],
} as const

/** OpenSpec-side assets: the review gate depends on these, so they always ship. */
const OPENSPEC_COPIES: Array<{ from: string; to: string; mode?: number }> = [
  { from: 'openspec/config.default.yaml', to: 'openspec/config.yaml' },
  { from: 'openspec/schemas/workmate-review/schema.yaml', to: 'openspec/schemas/workmate-review/schema.yaml' },
  { from: 'openspec/schemas/workmate-review/templates/proposal.md', to: 'openspec/schemas/workmate-review/templates/proposal.md' },
  { from: 'openspec/schemas/workmate-review/templates/spec.md', to: 'openspec/schemas/workmate-review/templates/spec.md' },
  { from: 'openspec/schemas/workmate-review/templates/design.md', to: 'openspec/schemas/workmate-review/templates/design.md' },
  { from: 'openspec/schemas/workmate-review/templates/review.md', to: 'openspec/schemas/workmate-review/templates/review.md' },
  { from: 'openspec/schemas/workmate-review/templates/tasks.md', to: 'openspec/schemas/workmate-review/templates/tasks.md' },
]

/** Claude Code assets: only meaningful under Claude Code (see the module doc). */
const CLAUDE_COPIES: Array<{ from: string; to: string; mode?: number }> = [
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
 * Sync the quality assets into the target project. Per-file errors are
 * collected into the note — one unreadable asset must not abort the rest.
 */
export async function syncProjectAssets(projectRoot: string, options: SyncOptions = {}): Promise<SyncResult> {
  const root = validateProjectRoot(projectRoot)
  const assets = options.assetsDir ?? defaultAssetsDir()
  const claudeAssets = options.claudeAssets !== false
  const result: SyncResult = { written: [], skipped: [] }
  const copies = claudeAssets ? [...OPENSPEC_COPIES, ...CLAUDE_COPIES] : OPENSPEC_COPIES

  for (const copy of copies) {
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

  if (!claudeAssets) {
    result.note = `${result.note ?? ''}claudeAssetsEnabled=false — .claude/** 未分发（DSH 侧由内置 skill 代替）; `
    return result
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
