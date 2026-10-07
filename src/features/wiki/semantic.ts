/**
 * Semantic vault search with a lexical-first policy (change `semantic-vault-search`).
 *
 * Policy, not accident:
 *   1. lexical (grep) hits are preferred — they are explainable and exact;
 *   2. semantic search runs only when lexical finds nothing (or the caller asks for it),
 *      which is exactly the "different words, same meaning" case embeddings are for;
 *   3. semantic hits cite the **chunk's starting line**, never a made-up precise line.
 *
 * Embeddings come from local Ollama (verified on this machine: 768-dim, `/api/embeddings`).
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { EmbeddingCache, cosine, embedChunks, embedText } from './embeddings.ts'
import { searchVault, type VaultSearchResult } from './search.ts'

export interface Chunk {
  file: string
  line: number
  text: string
}

/** Split one note into chunks on H2 boundaries, capped so a chunk stays comparable. */
export function chunkNote(content: string, file: string, maxLines = 60): Chunk[] {
  // YAML front-matter is metadata, not prose: embedding it dilutes every chunk.
  const body = content.replace(/^---\n[\s\S]*?\n---\n/, '')
  const lines = body.split('\n')
  const chunks: Chunk[] = []
  let start = 0
  let buffer: string[] = []
  const flush = (): void => {
    const text = buffer.join('\n').trim()
    if (text.length >= 40) chunks.push({ file, line: start + 1, text })
    buffer = []
  }
  for (const [index, line] of lines.entries()) {
    const isBoundary = /^##\s/.test(line)
    if ((isBoundary && buffer.length > 0) || buffer.length >= maxLines) {
      flush()
      start = index
    } else if (buffer.length === 0) {
      start = index
    }
    buffer.push(line)
  }
  flush()
  return chunks
}

async function walkMarkdown(dir: string, acc: string[] = []): Promise<string[]> {
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
      if (!entry.startsWith('.')) await walkMarkdown(full, acc)
    } else if (entry.endsWith('.md')) {
      // Structural notes (index/changelog/views) are generated hub pages: they repeat
      // every module name, so embedding them makes them win unrelated queries. They stay
      // available to lexical search, which is where they belong.
      if (/^(index|changelog|views|_views)\.md$/.test(entry)) continue
      acc.push(full)
    }
  }
  return acc
}

export interface SemanticOptions {
  vaultPath: string
  subdir?: string
  project?: string
  query: string
  model: string
  baseUrl?: string
  cachePath: string
  limit?: number
  maxFresh?: number
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  /** Test seam: replace lexical+embedding with fixed results. */
  lexical?: (query: string) => Promise<VaultSearchResult>
}

export interface SmartSearchResult extends VaultSearchResult {
  /** Which engine produced the returned hits. */
  engine: 'lexical' | 'semantic' | 'none'
  indexed?: number
  cached?: number
}

/**
 * Lexical first, semantic only as a fallback. Returns the engine used so the caller can
 * tell the user how the answer was found (and so nothing pretends to be semantic).
 */
export async function searchVaultSmart(options: SemanticOptions): Promise<SmartSearchResult> {
  const lexicalResult =
    options.lexical !== undefined
      ? await options.lexical(options.query)
      : await searchVault({
          vaultPath: options.vaultPath,
          ...(options.subdir !== undefined ? { subdir: options.subdir } : {}),
          ...(options.project !== undefined ? { project: options.project } : {}),
          query: options.query,
          ...(options.limit !== undefined ? { limit: options.limit } : {}),
        })

  if (lexicalResult.hits.length > 0 || options.model === '') {
    return { ...lexicalResult, engine: lexicalResult.hits.length > 0 ? 'lexical' : 'none' }
  }

  const subdir = options.subdir ?? 'WorkMate'
  const root = join(options.vaultPath, subdir, options.project ?? '')
  const files = await walkMarkdown(root)
  if (files.length === 0) return { ...lexicalResult, engine: 'none' }

  const queryEmbedding = await embedText(options.query, {
    model: options.model,
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  })
  if (queryEmbedding.vector === undefined) {
    return { ...lexicalResult, engine: 'none', note: `语义检索不可用：${queryEmbedding.note ?? '未知原因'}` }
  }

  const chunks: Chunk[] = []
  for (const file of files) {
    const content = await readFile(file, 'utf8').catch(() => '')
    if (content === '') continue
    chunks.push(...chunkNote(content, relative(options.vaultPath, file)))
  }

  const cache = new EmbeddingCache(options.cachePath)
  const indexed = await embedChunks(chunks, {
    model: options.model,
    cache,
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    ...(options.maxFresh !== undefined ? { maxFresh: options.maxFresh } : {}),
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  })

  const scored = indexed.chunks
    .map((chunk) => ({ chunk, score: cosine(queryEmbedding.vector as number[], chunk.vector) }))
    .sort((left, right) => right.score - left.score)
    .slice(0, options.limit ?? 20)

  const hits = scored.map(({ chunk, score }) => ({
    file: chunk.file,
    line: chunk.line,
    text: chunk.text.replace(/\s+/g, ' ').slice(0, 240),
    score: Number(score.toFixed(4)),
  }))

  return {
    hits,
    scannedFiles: files.length,
    engine: hits.length > 0 ? 'semantic' : 'none',
    indexed: indexed.fresh,
    cached: indexed.cached,
    ...(indexed.note !== undefined ? { note: indexed.note } : {}),
    ...(hits.length > 0
      ? { note: `语义检索（${hits.length} 条，行号为分块起始行；模型 ${options.model}）` }
      : { note: indexed.note ?? '语义检索无命中' }),
  }
}
