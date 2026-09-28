/**
 * WeKnora bridge — HTTP retrieval (design D3: the wire contract is B-grade
 * evidence until a real WeKnora deployment verifies it; parse defensively and
 * degrade to a note instead of throwing).
 */
import { validateProjectRoot } from '../proposal/openspec.ts'

export interface WeknoraResult {
  /** Top-K retrieved fragments, each trimmed to 4000 chars. */
  fragments: string[]
  note?: string
}

export interface WeknoraClient {
  search(projectRoot: string, query: string, topK?: number): Promise<WeknoraResult>
}

interface FetchLike {
  (url: string, init: RequestInit & { signal: AbortSignal }): Promise<{
    ok: boolean
    status: number
    json(): Promise<unknown>
  }>
}

/**
 * Extracts readable text fragments from an unknown response shape: accepts
 * `{data: [...]}` / bare arrays, items with `content` / `contentWithTq` /
 * `text` fields, falling back to JSON dumps of the items themselves.
 */
export function extractFragments(payload: unknown, topK: number): string[] {
  const items = Array.isArray(payload)
    ? payload
    : payload !== null && typeof payload === 'object' && Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : []
  const fragments: string[] = []
  for (const item of items.slice(0, topK)) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const text = record['content'] ?? record['contentWithTq'] ?? record['text']
    if (typeof text === 'string' && text.trim() !== '') {
      fragments.push(text.trim().slice(0, 4000))
    }
  }
  return fragments
}

export function createWeknoraClient(baseUrl: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): WeknoraClient {
  return {
    async search(projectRoot, query, topK = 3): Promise<WeknoraResult> {
      validateProjectRoot(projectRoot)
      const endpoint = `${baseUrl.replace(/\/+$/, '')}/api/v1/retrieval/search`
      const signal = AbortSignal.timeout(10_000)
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query, topK }),
          signal,
        })
        if (!response.ok) {
          return { fragments: [], note: `weknora responded ${response.status}` }
        }
        const payload = await response.json()
        const fragments = extractFragments(payload, topK)
        return fragments.length > 0
          ? { fragments }
          : { fragments: [], note: 'weknora returned no readable fragments' }
      } catch (error) {
        return { fragments: [], note: `weknora search failed: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  }
}
