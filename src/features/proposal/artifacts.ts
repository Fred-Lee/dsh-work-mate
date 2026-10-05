/**
 * Artifact ledger and plan drift (change `add-artifact-ledger`).
 *
 * Two questions this answers, both from the playbook's artifact chain:
 *   1. "does the merged diff still match what the plan declared?" — plan drift;
 *   2. "which version of which artifact was reviewed?" — content hashes.
 *
 * Declared scopes come from the artifacts themselves (`<!-- writes: ... -->` in
 * tasks.md, `<!-- files: ... -->` in design.md), actual files from the proposal's
 * marked commits, and the ledger hashes the files sitting in the archived change
 * directory. Pure helpers plus one fs-backed collector; git lives in orchestrate.
 */
import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

export interface DriftReport {
  declared: string[]
  actual: string[]
  /** Changed but not declared. */
  undeclared: string[]
  /** Declared but unchanged. */
  missing: string[]
  /** `undeclared / actual`, 0 when there is nothing to compare. */
  driftRatio: number
  /** Set when no declaration exists — drift is then unknowable, not zero. */
  note?: string
}

export interface ArtifactRecord {
  /** Path relative to the archived change directory when possible. */
  path: string
  sha256?: string
  bytes?: number
  /** Commit covered by the ledger, when one was resolved. */
  commit?: string
  note?: string
}

const WRITES_ANNOTATION = /<!--\s*writes:\s*([^>]*?)\s*-->/g
const FILES_ANNOTATION = /<!--\s*files:\s*([^>]*?)\s*-->/g

/** Collect every scope declared in a text body for the given annotation tag. */
function collectScopes(content: string, pattern: RegExp): string[] {
  const scopes: string[] = []
  for (const match of content.matchAll(pattern)) {
    for (const scope of (match[1] ?? '').split(',')) {
      const trimmed = scope.trim()
      if (trimmed !== '') scopes.push(trimmed)
    }
  }
  return scopes
}

/** Declared scopes from tasks.md (`writes`) and design.md (`files`), deduplicated. */
export function declaredScopes(artifacts: { tasksMd?: string; designMd?: string }): string[] {
  const scopes = [
    ...collectScopes(artifacts.tasksMd ?? '', WRITES_ANNOTATION),
    ...collectScopes(artifacts.designMd ?? '', FILES_ANNOTATION),
  ]
  return [...new Set(scopes)]
}

const normalize = (scope: string): string => scope.replace(/\/\*\*?$/, '').replace(/\/+$/, '')

/** Does a declared scope cover a concrete path? */
export function scopeCovers(scope: string, path: string): boolean {
  const base = normalize(scope)
  if (base === '') return false
  return path === base || path.startsWith(`${base}/`)
}

/** Compare the declared scopes with the files the proposal actually touched. */
export function computeDrift(declared: readonly string[], actual: readonly string[]): DriftReport {
  const files = [...new Set(actual)].sort()
  if (declared.length === 0) {
    return {
      declared: [],
      actual: files,
      undeclared: [],
      missing: [],
      driftRatio: 0,
      note: '未声明范围（tasks.md 无 writes、design.md 无 files），无法判定漂移',
    }
  }
  const undeclared = files.filter((path) => !declared.some((scope) => scopeCovers(scope, path)))
  const missing = declared.filter((scope) => !files.some((path) => scopeCovers(scope, path)))
  return {
    declared: [...declared],
    actual: files,
    undeclared,
    missing,
    driftRatio: files.length === 0 ? 0 : undeclared.length / files.length,
  }
}

const LEDGER_FILES = [
  'proposal.md',
  'design.md',
  'tasks.md',
  'review.md',
  'wiki.md',
  'commits.md',
  'rollback.md',
]

/**
 * Hash the known artifacts inside an archived change directory. Unreadable files
 * become a record with a note — a ledger entry must never fail the archive run.
 */
export async function collectArtifactLedger(
  changeDir: string,
  options: { commit?: string } = {},
): Promise<ArtifactRecord[]> {
  const records: ArtifactRecord[] = []
  let entries: string[]
  try {
    entries = await readdir(changeDir)
  } catch (error) {
    return [
      {
        path: changeDir,
        note: `cannot read change directory: ${error instanceof Error ? error.message : String(error)}`,
      },
    ]
  }
  // Known names first, then anything else the author added (specs/, other .md).
  const candidates = [...LEDGER_FILES, ...entries.filter((entry) => !LEDGER_FILES.includes(entry))]
  for (const name of candidates) {
    if (!entries.includes(name)) continue
    const full = join(changeDir, name)
    try {
      const info = await stat(full)
      if (info.isDirectory()) continue
      const content = await readFile(full)
      records.push({
        path: full,
        sha256: createHash('sha256').update(content).digest('hex'),
        bytes: content.byteLength,
        ...(options.commit !== undefined ? { commit: options.commit } : {}),
      })
    } catch (error) {
      records.push({ path: full, note: `unreadable: ${error instanceof Error ? error.message : String(error)}` })
    }
  }
  return records
}
