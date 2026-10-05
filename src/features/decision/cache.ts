/**
 * Decision cache (change `add-decision-cache`, design D1–D4).
 *
 * The agent judge costs a real model call per judgement; the questions repeat
 * heavily (the same finding, the same diff, the same decision pair — re-asked by a
 * retried archive, a panel refresh, a repeated tool call). This layer answers a
 * repeated question from disk, which is what makes a DeepSeek judge economically
 * comparable to a purpose-built decision model.
 *
 * Hard boundary (D3): the cache is a PERFORMANCE layer, never a correctness one.
 * An unreadable, unparsable or unwritable file is treated as "no cache" and the
 * judgement proceeds — a broken cache must never block a gate.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DecisionQuestion } from './types.ts'

export interface CachedDecision {
  choice: string
  certainty: number
  samples?: number
  provider: string
  model?: string
  /** ISO timestamp of the answer; used for eviction. */
  at: string
}

interface CacheFile {
  version: 1
  entries: Record<string, CachedDecision>
}

/** Stable key: same question, same options, same provider/model, same samples. */
export function cacheKey(
  question: DecisionQuestion,
  route: { provider: string; model?: string; samples?: number },
): string {
  const material = [
    question.node,
    question.state,
    question.question,
    [...question.options].join('|'),
    route.provider,
    route.model ?? '',
    String(route.samples ?? 1),
  ].join('\u0000')
  return createHash('sha256').update(material).digest('hex')
}

export class DecisionCache {
  constructor(
    private readonly file: string,
    private readonly max = 500,
  ) {}

  private async read(): Promise<CacheFile> {
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (parsed === null || typeof parsed !== 'object') return { version: 1, entries: {} }
      const entries = (parsed as { entries?: unknown }).entries
      if (entries === null || typeof entries !== 'object') return { version: 1, entries: {} }
      return { version: 1, entries: entries as Record<string, CachedDecision> }
    } catch {
      // Missing or broken: an empty cache, never an error (design D3).
      return { version: 1, entries: {} }
    }
  }

  async get(key: string): Promise<CachedDecision | undefined> {
    const cached = (await this.read()).entries[key]
    return cached !== undefined && typeof cached.choice === 'string' ? cached : undefined
  }

  async put(key: string, value: CachedDecision): Promise<void> {
    try {
      const cache = await this.read()
      cache.entries[key] = value
      const keys = Object.keys(cache.entries)
      if (keys.length > this.max) {
        const ordered = keys
          .map((entryKey) => ({ key: entryKey, at: cache.entries[entryKey]?.at ?? '' }))
          .sort((left, right) => left.at.localeCompare(right.at))
        for (const stale of ordered.slice(0, keys.length - this.max)) delete cache.entries[stale.key]
      }
      await mkdir(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp-${process.pid}`
      await writeFile(tmp, `${JSON.stringify(cache)}\n`, 'utf8')
      await rename(tmp, this.file)
    } catch {
      // Cache writes are best-effort: a failure only costs the next call.
    }
  }

  /** Diagnostic counter for tooling/tests. */
  async size(): Promise<number> {
    return Object.keys((await this.read()).entries).length
  }
}
