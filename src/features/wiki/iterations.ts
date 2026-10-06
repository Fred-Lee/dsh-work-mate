/**
 * Derive iterations from OpenSpec archives (change `derive-iterations-from-archive`).
 *
 * A project that never used WorkMate proposals still has a history: every archived
 * OpenSpec change is an iteration. The archive directory name carries the date, the
 * proposal body carries a one-line Why (summary) and an Impact section (touched code),
 * and `[proposal:<id>]` commit marks tie an iteration to real commits.
 *
 * What is DECLARED vs DERIVED is kept explicit: `depends_on` only ever comes from a
 * declared `relatesTo`; the predecessor link is `sequence`, flagged `derived: true`.
 * Nothing is invented to make the graph look fuller.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { VaultIterationInput } from './vault.ts'

export interface ArchivedIteration extends VaultIterationInput {
  date: string
}

/** `2026-01-30-add-option-percent-statistics` → date + id. */
export function parseArchiveDirName(name: string): { date: string; id: string } | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})-(.+)$/.exec(name)
  if (match === null) return undefined
  const [, date, id] = match
  return date !== undefined && id !== undefined && id !== '' ? { date, id } : undefined
}

/** kebab slug → readable title (`add-option-percent-statistics` → `Add option percent statistics`). */
export function humanizeSlug(slug: string): string {
  const words = slug.split(/[-_]+/).filter((word) => word !== '')
  return words.length === 0 ? slug : words[0]!.charAt(0).toUpperCase() + [words[0]!.slice(1), ...words.slice(1)].join(' ')
}

/** First meaningful line of a `## Why` section, trimmed to fit one index cell. */
export function extractSummary(proposal: string): string | undefined {
  const whyIndex = proposal.search(/^##\s*(Why|背景|为什么)/m)
  if (whyIndex < 0) return undefined
  const rest = proposal.slice(whyIndex).split('\n').slice(1)
  for (const line of rest) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (trimmed.startsWith('#')) return undefined
    const clean = trimmed.replace(/^[-*\d.\s]+/, '').replace(/[*`]/g, '').trim()
    if (clean !== '') return clean.length > 120 ? `${clean.slice(0, 119)}…` : clean
  }
  return undefined
}

/** Backticked code paths listed under `## Impact` (their Impact bullets mention them). */
export function extractTouches(proposal: string): string[] {
  const impactIndex = proposal.search(/^##\s*(Impact|影响)/m)
  if (impactIndex < 0) return []
  // The split consumes the leading `## `, so the section body is the second element.
  const section = proposal.slice(impactIndex).split(/^##\s/m)[1] ?? ''
  const paths = new Set<string>()
  for (const match of section.matchAll(/`([^`\n]+)`/g)) {
    const value = match[1]?.trim()
    if (value === undefined || value === '') continue
    // Keep things that look like paths or file names, skip symbols/short identifiers.
    if (/[./]/.test(value) || /\.(java|ts|tsx|js|vue|xml|sql|md)$/i.test(value)) paths.add(value)
  }
  return [...paths]
}

/** `[proposal:<id>]` marks: one git scan, indexed by id. */
export function indexCommitMarks(log: string): Map<string, string[]> {
  const byId = new Map<string, string[]>()
  for (const line of log.split('\n')) {
    const [hash, subject] = line.split('\t')
    if (hash === undefined || subject === undefined) continue
    for (const match of subject.matchAll(/\[proposal:([^\]]+)\]/g)) {
      const id = match[1]?.trim()
      if (id === undefined || id === '') continue
      const list = byId.get(id) ?? []
      list.push(hash.slice(0, 8))
      byId.set(id, list)
    }
  }
  return byId
}

export interface CollectArchiveOptions {
  projectRoot: string
  /** `Config.openspecRoot`. @default 'openspec' */
  openspecRoot?: string
  /** Commit log (`%h%x09%s` lines); injectable so tests need no repository. */
  gitLog?: (projectRoot: string) => Promise<string>
}

/**
 * Read every archived change as an iteration, oldest first, with a derived
 * chronological predecessor link (`sequence`) — never a fabricated dependency.
 */
export async function collectArchivedIterations(options: CollectArchiveOptions): Promise<ArchivedIteration[]> {
  const openspecRoot = options.openspecRoot ?? 'openspec'
  const archiveDir = join(options.projectRoot, openspecRoot, 'changes', 'archive')
  let entries: string[]
  try {
    entries = await readdir(archiveDir)
  } catch {
    return []
  }

  const marks = options.gitLog !== undefined ? indexCommitMarks(await options.gitLog(options.projectRoot)) : new Map()

  const iterations: ArchivedIteration[] = []
  for (const entry of entries) {
    const parsed = parseArchiveDirName(entry)
    if (parsed === undefined) continue
    let proposal = ''
    try {
      proposal = await readFile(join(archiveDir, entry, 'proposal.md'), 'utf8')
    } catch {
      proposal = ''
    }
    const titleMatch = /^#\s+(.+)$/m.exec(proposal)
    const title = titleMatch?.[1]?.trim() ?? humanizeSlug(parsed.id)
    const summary = extractSummary(proposal)
    const touches = extractTouches(proposal)
    iterations.push({
      id: parsed.id,
      title,
      status: 'archived',
      archived: true,
      dependsOn: [],
      supersedes: [],
      commits: marks.get(parsed.id) ?? [],
      origin: 'archive',
      date: parsed.date,
      ...(summary !== undefined ? { summary } : {}),
      ...(touches.length > 0 ? { touches } : {}),
    })
  }

  iterations.sort((left, right) => left.date.localeCompare(right.date) || left.id.localeCompare(right.id))
  // Derived lineage: the previous iteration in time. Labelled as derived, not as a claim.
  for (let index = 1; index < iterations.length; index += 1) {
    const previous = iterations[index - 1]
    const current = iterations[index]
    if (previous !== undefined && current !== undefined) current.sequence = previous.id
  }
  return iterations
}

/** Merge proposal-driven and archive-driven iterations; proposals win on id collision. */
export function mergeIterations(
  proposals: readonly VaultIterationInput[],
  archived: readonly VaultIterationInput[],
): VaultIterationInput[] {
  const seen = new Set(proposals.map((iteration) => iteration.id))
  return [...proposals, ...archived.filter((iteration) => !seen.has(iteration.id))]
}
