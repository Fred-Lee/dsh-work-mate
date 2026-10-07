/**
 * Local embeddings via Ollama + a content-hash vector cache (change `semantic-vault-search`).
 *
 * Verified on this machine: `POST http://127.0.0.1:11434/api/embeddings {model, prompt}`
 * → `{embedding: number[768]}`; batching works through `/api/embed {input: [...]}`.
 *
 * Why a hash cache instead of a vector database: the vault is hundreds of notes, so a
 * cosine scan over cached vectors is milliseconds — no native dependency, no index drift.
 * Embeddings are keyed by `sha256(model + text)`, so editing a note re-embeds only that
 * chunk, and a changed model never mixes vectors from two models.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface EmbeddingOptions {
  model: string
  baseUrl?: string
  timeoutMs?: number
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

export interface EmbeddingResult {
  vector?: number[]
  note?: string
}

/** One embedding call. Failures are returned as a note: callers degrade, never throw. */
export async function embedText(text: string, options: EmbeddingOptions): Promise<EmbeddingResult> {
  const baseUrl = (options.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/+$/, '')
  const call = options.fetchImpl ?? fetch
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 20_000)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal])
  try {
    const response = await call(`${baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: options.model, prompt: text }),
      signal,
    })
    if (!response.ok) return { note: `ollama responded ${response.status}` }
    const payload = (await response.json()) as { embedding?: unknown }
    const vector = Array.isArray(payload.embedding)
      ? payload.embedding.filter((value): value is number => typeof value === 'number')
      : []
    return vector.length > 0 ? { vector } : { note: 'ollama 返回了空向量' }
  } catch (error) {
    return { note: `ollama 调用失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** Cosine similarity; zero-norm vectors score 0 instead of NaN. */
export function cosine(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] as number
    const b = right[index] as number
    dot += a * b
    leftNorm += a * a
    rightNorm += b * b
  }
  if (leftNorm === 0 || rightNorm === 0) return 0
  return dot / Math.sqrt(leftNorm * rightNorm)
}

export const embeddingKey = (model: string, text: string): string =>
  createHash('sha256').update(`${model}\u0000${text}`).digest('hex')

interface CacheFile {
  version: 1
  model?: string
  entries: Record<string, number[]>
}

/**
 * Vector cache on disk. Like the decision cache: a performance layer, so an unreadable
 * or unwritable file degrades to "no cache" and never blocks a search.
 */
export class EmbeddingCache {
  private entries: Record<string, number[]> = {}
  private loaded = false

  constructor(
    private readonly file: string,
    private readonly max = 5_000,
  ) {}

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as CacheFile
      this.entries = parsed.entries ?? {}
    } catch {
      this.entries = {}
    }
  }

  async get(key: string): Promise<number[] | undefined> {
    await this.load()
    const vector = this.entries[key]
    return Array.isArray(vector) && vector.length > 0 ? vector : undefined
  }

  async put(key: string, vector: number[]): Promise<void> {
    await this.load()
    this.entries[key] = vector
    const keys = Object.keys(this.entries)
    if (keys.length > this.max) {
      for (const stale of keys.slice(0, keys.length - this.max)) delete this.entries[stale]
    }
    try {
      await mkdir(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp-${process.pid}`
      await writeFile(tmp, JSON.stringify({ version: 1, entries: this.entries }), 'utf8')
      await rename(tmp, this.file)
    } catch {
      /* cache writes are best-effort */
    }
  }

  async size(): Promise<number> {
    await this.load()
    return Object.keys(this.entries).length
  }
}

export interface EmbeddedChunk {
  file: string
  line: number
  text: string
  vector: number[]
}

export interface IndexOptions {
  model: string
  baseUrl?: string
  cache: EmbeddingCache
  /** Hard cap on fresh embeddings per run (a search must not become a 10-minute job). */
  maxFresh?: number
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

export interface IndexResult {
  chunks: EmbeddedChunk[]
  fresh: number
  cached: number
  note?: string
}

/**
 * Embed chunks, reusing cached vectors. `chunks` are `{file, line, text}` produced by the
 * caller's chunker, so chunking policy stays next to the search it serves.
 */
export async function embedChunks(
  chunks: readonly { file: string; line: number; text: string }[],
  options: IndexOptions,
): Promise<IndexResult> {
  const embedded: EmbeddedChunk[] = []
  let fresh = 0
  let cached = 0
  const budget = options.maxFresh ?? 400

  for (const chunk of chunks) {
    const key = embeddingKey(options.model, chunk.text)
    const hit = await options.cache.get(key)
    if (hit !== undefined) {
      cached += 1
      embedded.push({ ...chunk, vector: hit })
      continue
    }
    if (fresh >= budget) {
      return { chunks: embedded, fresh, cached, note: `达到本轮嵌入上限 ${budget} 条，剩余分块未索引` }
    }
    const result = await embedText(chunk.text, {
      model: options.model,
      ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
      ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    })
    if (result.vector === undefined) {
      return {
        chunks: embedded,
        fresh,
        cached,
        note: `嵌入中断：${result.note ?? '未知原因'}（已索引 ${embedded.length} 块）`,
      }
    }
    fresh += 1
    await options.cache.put(key, result.vector)
    embedded.push({ ...chunk, vector: result.vector })
  }
  return { chunks: embedded, fresh, cached }
}
