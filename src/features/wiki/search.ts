/**
 * Vault search (change `wiki-search-in-vault`).
 *
 * The same markdown that humans read is what the AI should read — so retrieval is a
 * lexical scan over the vault with **file + line** citations, not an opaque index.
 * No embeddings: a grep-style result is explainable, cheap and always in sync with the
 * files on disk. Vector search can be layered on later without changing this contract.
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

export interface VaultHit {
  /** Path relative to the vault root. */
  file: string
  /** 1-based line number. */
  line: number
  text: string
  score: number
}

export interface VaultSearchResult {
  hits: VaultHit[]
  scannedFiles: number
  note?: string
}

async function collectMarkdown(dir: string, acc: string[] = []): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return acc
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    const info = await stat(full).catch(() => undefined)
    if (info === undefined) continue
    if (info.isDirectory()) {
      if (entry.startsWith('.')) continue
      await collectMarkdown(full, acc)
    } else if (entry.endsWith('.md')) {
      acc.push(full)
    }
  }
  return acc
}

/** Split a query into lowercase terms; CJK runs are kept whole, latin words split. */
export function queryTerms(query: string): string[] {
  const terms = new Set<string>()
  for (const raw of query.split(/[\s,，、。;；]+/)) {
    const term = raw.trim().toLowerCase()
    if (term !== '') terms.add(term)
  }
  return [...terms]
}

/**
 * Search the vault (optionally one project) for a query.
 * Scoring: every matched term counts, a first-line/front-matter hit weighs more, and a
 * line containing all terms outranks scattered hits — the usual "grep but ranked" shape.
 */
export async function searchVault(options: {
  vaultPath: string
  subdir?: string
  project?: string
  query: string
  limit?: number
}): Promise<VaultSearchResult> {
  const subdir = options.subdir ?? 'WorkMate'
  const root = join(options.vaultPath, subdir, options.project ?? '')
  const terms = queryTerms(options.query)
  const limit = options.limit ?? 20
  if (terms.length === 0) return { hits: [], scannedFiles: 0, note: '空查询' }

  const files = await collectMarkdown(root)
  if (files.length === 0) {
    return { hits: [], scannedFiles: 0, note: `vault 里没有可搜索的笔记（${root}）` }
  }

  const hits: VaultHit[] = []
  for (const file of files) {
    const content = await readFile(file, 'utf8').catch(() => '')
    if (content === '') continue
    const lines = content.split('\n')
    for (const [index, line] of lines.entries()) {
      const lower = line.toLowerCase()
      const matched = terms.filter((term) => lower.includes(term))
      if (matched.length === 0) continue
      const isHeading = line.trim().startsWith('#')
      const isMeta = index < 12 || line.includes(':')
      const score = matched.length * 2 + (isHeading ? 2 : 0) + (isMeta ? 1 : 0)
      hits.push({
        file: relative(options.vaultPath, file),
        line: index + 1,
        text: line.trim().slice(0, 240),
        score,
      })
    }
  }

  hits.sort((left, right) => right.score - left.score || left.file.localeCompare(right.file) || left.line - right.line)
  const kept = hits.slice(0, limit)
  return {
    hits: kept,
    scannedFiles: files.length,
    ...(hits.length > kept.length ? { note: `命中 ${hits.length} 行，已返回前 ${kept.length} 行` } : {}),
  }
}
