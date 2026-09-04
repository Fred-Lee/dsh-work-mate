import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { VaultStore } from './vault.ts'
import { parseFrontmatter, composeNote, serializeFrontmatter } from './frontmatter.ts'
import type { Note } from './types.ts'

let dir: string
let store: VaultStore

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vault-'))
  store = new VaultStore({ rootDir: join(dir, 'vault'), gitInit: false })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function note(partial: Partial<Note> = {}): Note {
  return {
    id: partial.id ?? 'n1',
    title: partial.title ?? '研究笔记',
    kind: partial.kind ?? 'research',
    createdAt: partial.createdAt ?? '2026-09-01T00:00:00.000Z',
    body: partial.body ?? '## 市场现状\n作业批改 SaaS 市场规模。',
    frontmatter: partial.frontmatter ?? {},
    ...partial.linkedProjects !== undefined ? { linkedProjects: partial.linkedProjects } : {},
  }
}

describe('VaultStore', () => {
  it('archives a note as markdown with frontmatter and re-reads it', async () => {
    const { id, path } = await store.archive(note({ linkedProjects: ['作业服务'] }))
    const raw = await readFile(path, 'utf8')
    expect(raw).toContain('---')
    expect(raw).toContain('kind: "research"')
    expect(raw).toContain('## 市场现状')

    const full = await store.get(id)
    expect(full).not.toBeNull()
    expect(full!.title).toBe('研究笔记')
    expect(full!.kind).toBe('research')
    expect(full!.linkedProjects).toEqual(['作业服务'])
  })

  it('lists metadata across kinds', async () => {
    await store.archive(note({ id: 'r1', kind: 'research' }))
    await store.archive(note({ id: 'p1', kind: 'prd', title: '批改系统 PRD' }))
    const all = await store.list()
    expect(all.length).toBe(2)
    const kinds = all.map((m) => m.kind).sort()
    expect(kinds).toEqual(['prd', 'research'])
  })

  it('search matches title and body', async () => {
    await store.archive(note({ id: 'r1', body: 'OCR 引擎选型 PaddleOCR 对比 Tesseract。' }))
    await store.archive(note({ id: 'p1', kind: 'prd', title: '学情分析 PRD', body: '数据看板。' }))

    const titleHit = await store.search('学情')
    expect(titleHit.length).toBe(1)
    expect(titleHit[0].id).toBe('p1')
    expect(titleHit[0].matchedField).toBe('title')

    const bodyHit = await store.search('paddleocr')
    expect(bodyHit.length).toBe(1)
    expect(bodyHit[0].id).toBe('r1')
    expect(bodyHit[0].matchedField).toBe('body')
  })

  it('returns empty for a blank or no-match query', async () => {
    await store.archive(note())
    expect(await store.search('')).toEqual([])
    expect(await store.search('zzz-not-there')).toEqual([])
  })
})

describe('frontmatter codec', () => {
  it('round-trips scalar and array values', () => {
    const input: Record<string, unknown> = { title: 'T', kind: 'prd', linkedProjects: ['a', 'b'], archivedAt: '2026-01-01' }
    const text = composeNote(input, 'body')
    const { frontmatter, body } = parseFrontmatter(text)
    expect(frontmatter.title).toBe('T')
    expect(frontmatter.kind).toBe('prd')
    expect(frontmatter.linkedProjects).toEqual(['a', 'b'])
    expect(body).toBe('body')
  })

  it('returns body unchanged when no frontmatter', () => {
    expect(parseFrontmatter('plain body').frontmatter).toEqual({})
    expect(parseFrontmatter('plain body').body).toBe('plain body')
  })

  it('serializes a bare metadata block', () => {
    expect(serializeFrontmatter({ a: 1, b: true })).toBe('---\na: 1\nb: true\n---')
  })
})
