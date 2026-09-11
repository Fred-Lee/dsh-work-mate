import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ArtifactStore, HelmsmanArtifactError, MAX_ARTIFACT_BYTES } from './store.ts'

let dir: string
let store: ArtifactStore

const encoder = new TextEncoder()
const bytesOf = (s: string): Uint8Array => encoder.encode(s)
const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  Buffer.from(a).equals(Buffer.from(b))

const DRAFT = bytesOf('# 工作台草稿\n\n进度说明。\n')

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'helmsman-artifacts-'))
  store = new ArtifactStore({ rootDir: join(dir, 'store') })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('ArtifactStore register/resolve/list', () => {
  it('round-trips a registration through resolve and list', async () => {
    const result = await store.register({ type: 'draft', fileName: '工作台草稿.md', bytes: DRAFT })

    expect(result.duplicate).toBe(false)
    expect(result.id).toBe(sha256Hex(DRAFT))

    const resolved = await store.resolve(result.id)
    expect(resolved).not.toBeNull()
    expect(resolved!.meta.id).toBe(result.id)
    expect(resolved!.meta.type).toBe('draft')
    expect(resolved!.meta.fileName).toBe('工作台草稿.md')
    expect(resolved!.meta.mime).toBe('text/markdown')
    expect(resolved!.meta.size).toBe(DRAFT.byteLength)
    expect(sameBytes(resolved!.bytes, DRAFT)).toBe(true)

    const listed = await store.list()
    expect(listed).toHaveLength(1)
    const [entry] = listed
    expect(entry!.id).toBe(result.id)
    expect(entry!.fileName).toBe('工作台草稿.md')
    expect(entry!.producers).toEqual([])
  })

  it('starts empty and resolves null for unknown ids', async () => {
    expect(await store.list()).toEqual([])
    expect(await store.resolve('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')).toBeNull()
  })
})

describe('ArtifactStore dedupe', () => {
  it('dedupes identical bytes to the existing id without a second blob', async () => {
    const first = await store.register({ type: 'draft', fileName: 'note.md', bytes: DRAFT })
    const second = await store.register({ type: 'draft', fileName: 'renamed.md', bytes: DRAFT })

    expect(second.id).toBe(first.id)
    expect(second.duplicate).toBe(true)

    const blobs = await readdir(join(store.rootDir, 'blobs'))
    expect(blobs).toHaveLength(1)
    expect(blobs[0]).toBe(first.id)

    // First registration metadata is preserved for downloads.
    const resolved = await store.resolve(first.id)
    expect(resolved!.meta.fileName).toBe('note.md')
    expect(resolved!.meta.mime).toBe('text/markdown')
  })

  it('stores only distinct content even when re-registered', async () => {
    const a = bytesOf('AAAA')
    const b = bytesOf('BBBB')
    await store.register({ type: 'draft', fileName: 'a.txt', bytes: a })
    await store.register({ type: 'draft', fileName: 'b.txt', bytes: b })
    await store.register({ type: 'draft', fileName: 'a-again.txt', bytes: a })

    const listed = await store.list()
    expect(listed).toHaveLength(2)
    const blobs = await readdir(join(store.rootDir, 'blobs'))
    expect(blobs).toHaveLength(2)
  })
})

describe('ArtifactStore metadata + producers', () => {
  it('keeps first metadata and appends producer ids', async () => {
    await store.register({
      type: 'draft',
      fileName: 'note.md',
      bytes: DRAFT,
      meta: { producer: 'draft:abc', draftId: 'abc' },
    })
    const dup = await store.register({
      type: 'draft',
      fileName: 'renamed.md',
      bytes: DRAFT,
      meta: { producer: 'task:xyz', taskId: 'xyz' },
    })
    expect(dup.duplicate).toBe(true)

    const [entry] = await store.list()
    expect(entry!.type).toBe('draft')
    expect(entry!.fileName).toBe('note.md')
    // First registration's free-form meta is untouched…
    expect(entry!.meta).toEqual({ producer: 'draft:abc', draftId: 'abc' })
    // …but the producer list grows append-only.
    expect(entry!.producers).toEqual(['draft:abc', 'task:xyz'])
  })

  it('does not duplicate an already-known producer', async () => {
    const meta = { producer: 'draft:abc' }
    await store.register({ type: 'draft', fileName: 'note.md', bytes: DRAFT, meta })
    await store.register({ type: 'draft', fileName: 'again.md', bytes: DRAFT, meta })

    const [entry] = await store.list()
    expect(entry!.producers).toEqual(['draft:abc'])
  })

  it('records no producer when meta.producer is absent or blank', async () => {
    await store.register({ type: 'draft', fileName: 'plain.md', bytes: DRAFT, meta: { taskId: 't1' } })
    await store.register({ type: 'draft', fileName: 'blank.md', bytes: DRAFT, meta: { producer: '  ' } })

    const [entry] = await store.list()
    expect(entry!.producers).toEqual([])
  })

  it('overwrites stored metadata when keepMeta is false (D2)', async () => {
    await store.register({ type: 'draft', fileName: 'note.md', bytes: DRAFT, meta: { producer: 'draft:abc' } })
    await store.register({
      type: 'archived-note',
      fileName: 'archive.md',
      bytes: DRAFT,
      meta: { producer: 'task:xyz' },
      keepMeta: false,
    })

    const [entry] = await store.list()
    expect(entry!.fileName).toBe('archive.md')
    expect(entry!.type).toBe('archived-note')
    expect(entry!.meta).toEqual({ producer: 'task:xyz' })
    // id/size/createdAt stay tied to the content; producers remain append-only.
    expect(entry!.id).toBe(sha256Hex(DRAFT))
    expect(entry!.size).toBe(DRAFT.byteLength)
    expect(entry!.producers).toEqual(['draft:abc', 'task:xyz'])
  })
})

describe('ArtifactStore persistence', () => {
  it('survives a fresh store instance (host restart)', async () => {
    const first = await store.register({
      type: 'draft',
      fileName: 'note.md',
      bytes: DRAFT,
      meta: { producer: 'draft:abc' },
    })
    const before = await store.list()

    const reopened = new ArtifactStore({ rootDir: store.rootDir })
    const after = await reopened.list()
    expect(after).toEqual(before)
    expect(after).toHaveLength(1)
    expect(after[0]!.fileName).toBe('note.md')

    const resolved = await reopened.resolve(first.id)
    expect(resolved).not.toBeNull()
    expect(sameBytes(resolved!.bytes, DRAFT)).toBe(true)
  })
})

describe('ArtifactStore corrupt-manifest rebuild', () => {
  it('rebuilds the manifest by hashing blobs when it fails to parse', async () => {
    const a = bytesOf('# note a')
    const b = bytesOf('{"kind": "topology"}')
    const ra = await store.register({ type: 'draft', fileName: 'a.md', bytes: a })
    await store.register({ type: 'topology', fileName: 'topo.json', bytes: b })

    await writeFile(join(store.rootDir, 'manifest.json'), '{ this is not valid json', 'utf8')

    const reopened = new ArtifactStore({ rootDir: store.rootDir })
    const listed = await reopened.list()
    expect(listed).toHaveLength(2)

    const ids = listed.map((m) => m.id).sort()
    expect(ids).toEqual([ra.id, sha256Hex(b)].sort())

    // Recovered blobs remain resolvable with their original bytes.
    const resolved = await reopened.resolve(ra.id)
    expect(resolved).not.toBeNull()
    expect(sameBytes(resolved!.bytes, a)).toBe(true)

    // The rebuilt manifest is valid JSON again.
    const manifestText = await readFile(join(store.rootDir, 'manifest.json'), 'utf8')
    expect(() => JSON.parse(manifestText)).not.toThrow()

    // Byte-only recovery cannot restore original names → degraded defaults.
    const degraded = listed.filter((m) => m.fileName === `${m.id}.bin`)
    expect(degraded).toHaveLength(2)
    expect(listed.every((m) => m.type === 'generic')).toBe(true)
  })

  it('treats a non-object manifest as corrupt and rebuilds', async () => {
    await store.register({ type: 'draft', fileName: 'a.md', bytes: DRAFT })
    await writeFile(join(store.rootDir, 'manifest.json'), '[1, 2, 3]', 'utf8')

    const reopened = new ArtifactStore({ rootDir: store.rootDir })
    const listed = await reopened.list()
    expect(listed).toHaveLength(1)
    expect(listed[0]!.id).toBe(sha256Hex(DRAFT))
  })
})

describe('ArtifactStore guards', () => {
  it('rejects payloads over 50 MB with a typed PAYLOAD_TOO_LARGE error', async () => {
    const oversized = new Uint8Array(MAX_ARTIFACT_BYTES + 1)
    const register = store.register({ type: 'draft', fileName: 'huge.bin', bytes: oversized })

    await expect(register).rejects.toBeInstanceOf(HelmsmanArtifactError)
    await expect(register).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' })
    expect(await store.list()).toEqual([])
  })

  it('rejects invalid input with INVALID_INPUT', async () => {
    const err1 = store.register({ type: 'draft', fileName: '', bytes: bytesOf('x') })
    await expect(err1).rejects.toMatchObject({ code: 'INVALID_INPUT' })

    const err2 = store.register({ type: '  ', fileName: 'x.md', bytes: bytesOf('x') })
    await expect(err2).rejects.toMatchObject({ code: 'INVALID_INPUT' })

    const err3 = store.register({ type: 'draft', fileName: 'x.md', bytes: null as unknown as Uint8Array })
    await expect(err3).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('accepts a zero-length artifact', async () => {
    const empty = new Uint8Array(0)
    const result = await store.register({ type: 'draft', fileName: 'empty.md', bytes: empty })
    expect(result.id).toBe(sha256Hex(empty))
    const resolved = await store.resolve(result.id)
    expect(resolved!.bytes.byteLength).toBe(0)
  })
})

describe('ArtifactStore home resolution', () => {
  it('defaults to $HELMSMAN_HOME/artifacts when HELMSMAN_HOME is set', async () => {
    const home = join(dir, 'helmsman-home')
    process.env.HELMSMAN_HOME = home
    try {
      const envStore = new ArtifactStore()
      expect(envStore.rootDir).toBe(join(home, 'artifacts'))

      await envStore.register({ type: 'draft', fileName: 'env.md', bytes: DRAFT })
      const reopened = new ArtifactStore()
      const listed = await reopened.list()
      expect(listed).toHaveLength(1)
      expect(listed[0]!.fileName).toBe('env.md')
    } finally {
      delete process.env.HELMSMAN_HOME
    }
  })
})
