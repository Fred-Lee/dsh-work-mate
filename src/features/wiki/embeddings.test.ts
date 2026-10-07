import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { EmbeddingCache, cosine, embedChunks, embedText, embeddingKey } from './embeddings.ts'
import { chunkNote } from './semantic.ts'

const fakeFetch = (vector: number[], ok = true): typeof fetch =>
  vi.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => ({ embedding: vector }) })) as unknown as typeof fetch

describe('local embeddings (semantic-vault-search)', () => {
  it('calls the Ollama endpoint and returns the vector', async () => {
    const spy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ embedding: [0.1, 0.2, 0.3] }) }))
    const result = await embedText('批改并发', {
      model: 'nomic-embed-text',
      fetchImpl: spy as unknown as typeof fetch,
    })

    expect(result.vector).toEqual([0.1, 0.2, 0.3])
    expect(String(spy.mock.calls[0]?.[0])).toContain('/api/embeddings')
    expect(JSON.parse(String((spy.mock.calls[0]?.[1] as { body?: string }).body))).toEqual({
      model: 'nomic-embed-text',
      prompt: '批改并发',
    })
  })

  it('degrades to a note when Ollama is unreachable or answers badly', async () => {
    const down = await embedText('x', {
      model: 'm',
      fetchImpl: vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      }) as unknown as typeof fetch,
    })
    expect(down.vector).toBeUndefined()
    expect(down.note).toContain('ollama 调用失败')

    const bad = await embedText('x', { model: 'm', fetchImpl: fakeFetch([], false) })
    expect(bad.note).toContain('ollama responded 500')

    const empty = await embedText('x', { model: 'm', fetchImpl: fakeFetch([]) })
    expect(empty.note).toContain('空向量')
  })

  it('computes cosine similarity and never returns NaN', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1)
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0)
    expect(cosine([], [1])).toBe(0)
    expect(cosine([0, 0], [1, 1])).toBe(0)
  })

  it('caches by model+text so repeats cost nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wm-emb-'))
    const cache = new EmbeddingCache(join(dir, 'v.json'))
    const fetchImpl = fakeFetch([1, 2, 3])
    const chunks = [{ file: 'a.md', line: 1, text: '批改锁竞争' }]

    const first = await embedChunks(chunks, { model: 'm', cache, fetchImpl })
    const second = await embedChunks(chunks, { model: 'm', cache, fetchImpl })

    expect(first.fresh).toBe(1)
    expect(first.cached).toBe(0)
    expect(second.fresh).toBe(0)
    expect(second.cached).toBe(1)
    expect(second.chunks[0]?.vector).toEqual([1, 2, 3])
    // A different model never reuses the other model's vectors.
    expect(embeddingKey('m1', 'x')).not.toBe(embeddingKey('m2', 'x'))
    await rm(dir, { recursive: true, force: true })
  })

  it('stops at the fresh-embedding budget instead of running away', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wm-emb2-'))
    const cache = new EmbeddingCache(join(dir, 'v.json'))
    const result = await embedChunks(
      [
        { file: 'a.md', line: 1, text: 'one' },
        { file: 'a.md', line: 2, text: 'two' },
      ],
      { model: 'm', cache, maxFresh: 1, fetchImpl: fakeFetch([1]) },
    )

    expect(result.fresh).toBe(1)
    expect(result.note).toContain('达到本轮嵌入上限')
    await rm(dir, { recursive: true, force: true })
  })

  it('ignores YAML front-matter when chunking', () => {
    const note = ['---', 'title: x', 'type: moc', '---', '## 正文', '内容'.repeat(30)].join('\n')
    const chunks = chunkNote(note, 'a.md')

    expect(chunks).toHaveLength(1)
    expect(chunks[0]?.text).not.toContain('type: moc')
    expect(chunks[0]?.text).toContain('## 正文')
  })

  it('chunks notes on H2 boundaries with the right starting lines', () => {
    const content = ['# 标题', '', '## 第一节', '正文一'.repeat(30), '', '## 第二节', '正文二'.repeat(30)].join('\n')
    const chunks = chunkNote(content, 'a.md')

    expect(chunks).toHaveLength(2)
    // The short H1 preface is dropped (a chunk needs substance), so the first chunk
    // starts at the first H2.
    expect(chunks[0]?.line).toBe(3)
    expect(chunks[1]?.line).toBe(6)
    expect(chunkNote('太短', 'b.md')).toEqual([])
  })
})

describe('rerank contract (llm-rerank-vault-search)', () => {
  it('moves the pick to the front and annotates it', async () => {
    const { applyRerank } = await import('./semantic.ts')
    const hits = ['a', 'b', 'c']

    const applied = applyRerank(hits, 2)

    expect(applied.hits).toEqual(['c', 'a', 'b'])
    expect(applied.note).toContain('第 3 位')
  })

  it('leaves order untouched for missing or out-of-range picks', async () => {
    const { applyRerank } = await import('./semantic.ts')

    expect(applyRerank(['a', 'b'], undefined)).toEqual({ hits: ['a', 'b'], note: '' })
    expect(applyRerank(['a', 'b'], 0)).toEqual({ hits: ['a', 'b'], note: '' })
    expect(applyRerank(['a', 'b'], 9)).toEqual({ hits: ['a', 'b'], note: '' })
  })
})
