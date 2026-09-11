/**
 * ArtifactStore — the content-addressed artifact registry (design.md D1/D2).
 *
 * Layout (HELMSMAN_HOME-aware; default `~/.helmsman/artifacts`):
 *   <root>/blobs/<sha256-hex>   raw bytes, named by their content hash
 *   <root>/manifest.json        delivery metadata per artifact (atomic tmp+rename)
 *
 * An artifact's id IS the sha256 hex of its bytes, so identical
 * re-registrations dedupe structurally: `register` returns the existing id
 * with `duplicate: true` and the manifest keeps the FIRST registration's
 * metadata while producers are appended (D2). A manifest that fails to parse
 * is rebuilt by re-hashing every blob in `blobs/`; blobs are written
 * atomically as well so a crash can never leave a half-blob claiming a hash.
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mimeForFileName } from './download-headers.ts'

/** Register payload cap — typical drafts/diffs are KB-scale (design.md risks). */
export const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024

export type ArtifactErrorCode = 'PAYLOAD_TOO_LARGE' | 'INVALID_INPUT'

/** Typed error so hosts/tests can branch on `code` instead of message text. */
export class HelmsmanArtifactError extends Error {
  readonly code: ArtifactErrorCode

  constructor(code: ArtifactErrorCode, message: string) {
    super(message)
    this.name = 'HelmsmanArtifactError'
    this.code = code
  }
}

/** Delivery metadata recorded per stored artifact. */
export interface ArtifactMeta {
  /** Stable content id: sha256 hex of the bytes. */
  id: string
  /** Artifact category (draft | archived-note | topology | task-bundle | …). */
  type: string
  /** Original file name from the FIRST registration. */
  fileName: string
  /** MIME type derived from fileName at registration (D4 table). */
  mime: string
  /** Byte length of the stored blob. */
  size: number
  /** ISO-8601 timestamp of the first registration. */
  createdAt: string
  /** Free-form producer metadata from the first registration (D2). */
  meta: Record<string, unknown>
  /** Append-only ordered producer ids, each taken from `meta.producer`. */
  producers: string[]
}

export interface RegisterInput {
  type: string
  fileName: string
  bytes: Uint8Array
  /** Optional producer / free-form metadata recorded with the artifact. */
  meta?: Record<string, unknown>
  /**
   * Duplicate policy (D2). Default `true`: re-registering identical bytes
   * keeps the first registration's metadata. Pass `false` to replace it with
   * this registration's metadata (fileName/type/meta) while producers stay
   * append-only.
   */
  keepMeta?: boolean
}

export interface RegisterResult {
  /** Content id (sha256 hex of the bytes) — existing id on duplicate. */
  id: string
  /** True when identical bytes were already registered (no new blob). */
  duplicate: boolean
}

export interface ResolveResult {
  meta: ArtifactMeta
  bytes: Uint8Array
}

export class ArtifactStore {
  readonly rootDir: string
  private readonly blobsDir: string
  private readonly manifestFile: string
  /** Serializes mutations so concurrent registers can't lose updates. */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(opts: { rootDir?: string } = {}) {
    const base = process.env.HELMSMAN_HOME ?? join(homedir(), '.helmsman')
    this.rootDir = opts.rootDir ?? join(base, 'artifacts')
    this.blobsDir = join(this.rootDir, 'blobs')
    this.manifestFile = join(this.rootDir, 'manifest.json')
  }

  register(input: RegisterInput): Promise<RegisterResult> {
    return this.exclusive(async () => this.registerInner(input))
  }

  async resolve(id: string): Promise<ResolveResult | null> {
    const entries = await this.loadManifest()
    const meta = entries.get(id)
    if (!meta) return null
    let bytes: Uint8Array
    try {
      bytes = await readFile(join(this.blobsDir, id))
    } catch {
      return null
    }
    return { meta, bytes }
  }

  async list(): Promise<ArtifactMeta[]> {
    const entries = await this.loadManifest()
    return [...entries.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  private async registerInner(input: RegisterInput): Promise<RegisterResult> {
    assertValidRegister(input)
    const bytes = input.bytes
    const size = bytes.byteLength
    if (size > MAX_ARTIFACT_BYTES) {
      throw new HelmsmanArtifactError(
        'PAYLOAD_TOO_LARGE',
        `artifact "${input.fileName}" is ${size} bytes, exceeding the 50 MB registration cap`,
      )
    }

    const id = sha256Hex(bytes)
    const entries = await this.loadManifest()
    const existing = entries.get(id)
    if (existing) {
      // Duplicate: keep first metadata (unless keepMeta:false) and append the
      // new producer when meta.producer is provided (append-only, D2).
      const next: ArtifactMeta = { ...existing, producers: [...existing.producers] }
      const producer = producerOf(input.meta)
      if (producer !== undefined && !next.producers.includes(producer)) {
        next.producers.push(producer)
      }
      const producerAdded = next.producers.length !== existing.producers.length
      if (input.keepMeta === false) {
        entries.set(id, this.describe(input, id, existing.createdAt, next.producers))
      } else if (producerAdded) {
        entries.set(id, next)
      }
      if (input.keepMeta === false || producerAdded) await this.persist(entries)
      return { id, duplicate: true }
    }

    await this.writeBlobIfMissing(id, bytes)
    const producer = producerOf(input.meta)
    const entry = this.describe(input, id, new Date().toISOString(), producer === undefined ? [] : [producer])
    entries.set(id, entry)
    await this.persist(entries)
    return { id, duplicate: false }
  }

  /** Loads the manifest; a corrupt/unparseable one is rebuilt from blobs. */
  private async loadManifest(): Promise<Map<string, ArtifactMeta>> {
    let raw: string
    try {
      raw = await readFile(this.manifestFile, 'utf8')
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return this.rebuildIfBlobsExist() // fresh or crashed store
      throw err
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      console.warn(
        `[helmsman/artifacts] manifest.json unreadable (${errorMessage(err)}); rebuilding from blobs/`,
      )
      return this.rebuildAndPersist()
    }
    const entries = manifestFromParsed(parsed)
    if (!entries) {
      console.warn(
        `[helmsman/artifacts] manifest.json has an unexpected shape; rebuilding from blobs/`,
      )
      return this.rebuildAndPersist()
    }
    return entries
  }

  /** A genuinely fresh store has no blobs; anything else is a crash window
   * (blob written, manifest lost) and is repaired by re-hashing blobs. */
  private async rebuildIfBlobsExist(): Promise<Map<string, ArtifactMeta>> {
    if (!existsSync(this.blobsDir)) return new Map()
    const names = await readdir(this.blobsDir)
    if (!names.some((name) => !name.startsWith('.'))) return new Map()
    console.warn(
      '[helmsman/artifacts] manifest.json missing but blobs exist; rebuilding from blobs/',
    )
    const entries = await this.rebuildFromBlobs()
    await this.persist(entries)
    return entries
  }

  /** Re-hashes every blob and persists a fresh manifest. */
  private async rebuildAndPersist(): Promise<Map<string, ArtifactMeta>> {
    const entries = await this.rebuildFromBlobs()
    await this.persist(entries)
    return entries
  }

  private async rebuildFromBlobs(): Promise<Map<string, ArtifactMeta>> {
    const entries = new Map<string, ArtifactMeta>()
    if (!existsSync(this.blobsDir)) return entries
    const names = await readdir(this.blobsDir)
    for (const name of names) {
      if (name.startsWith('.')) continue // skip tmp leftovers from atomic writes
      const path = join(this.blobsDir, name)
      let bytes: Uint8Array
      try {
        bytes = await readFile(path)
      } catch {
        continue
      }
      const id = sha256Hex(bytes)
      const info = await stat(path).catch(() => undefined)
      entries.set(id, {
        id,
        // Original metadata lived only in the lost manifest; bytes alone
        // cannot recover fileName/type, so entries degrade to a .bin default.
        type: 'generic',
        fileName: `${id}.bin`,
        mime: 'application/octet-stream',
        size: bytes.byteLength,
        createdAt: info ? new Date(info.mtime).toISOString() : new Date(0).toISOString(),
        meta: {},
        producers: [],
      })
      if (name !== id) {
        // Self-heal a blob whose file name no longer matches its content hash.
        try {
          await rename(path, join(this.blobsDir, id))
        } catch {
          // best-effort; resolve only serves blobs whose name equals the id
        }
      }
    }
    return entries
  }

  /** Atomic manifest rewrite (tmp + rename), keys sorted for stable diffs. */
  private async persist(entries: Map<string, ArtifactMeta>): Promise<void> {
    await mkdir(this.rootDir, { recursive: true })
    const sorted = Object.fromEntries([...entries].sort(([a], [b]) => a.localeCompare(b)))
    const tmp = join(this.rootDir, `manifest.json.tmp-${randomUUID().slice(0, 8)}`)
    await writeFile(tmp, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8')
    await rename(tmp, this.manifestFile)
  }

  private async writeBlobIfMissing(id: string, bytes: Uint8Array): Promise<void> {
    const target = join(this.blobsDir, id)
    if (existsSync(target)) return
    await mkdir(this.blobsDir, { recursive: true })
    const tmp = join(this.blobsDir, `.${id}.tmp-${randomUUID().slice(0, 8)}`)
    await writeFile(tmp, bytes)
    await rename(tmp, target)
  }

  private describe(input: RegisterInput, id: string, createdAt: string, producers: string[]): ArtifactMeta {
    return {
      id,
      type: input.type,
      fileName: input.fileName,
      mime: mimeForFileName(input.fileName),
      size: input.bytes.byteLength,
      createdAt,
      meta: { ...(input.meta ?? {}) },
      producers,
    }
  }

  /** In-process mutex so interleaved registers serialize their read-modify-write. */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task, task)
    this.chain = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }
}

function assertValidRegister(input: RegisterInput): void {
  const invalid = (message: string): HelmsmanArtifactError =>
    new HelmsmanArtifactError('INVALID_INPUT', message)
  if (!input || typeof input !== 'object') throw invalid('register input must be an object')
  if (typeof input.type !== 'string' || input.type.trim() === '') {
    throw invalid('artifact type must be a non-empty string')
  }
  if (typeof input.fileName !== 'string' || input.fileName.trim() === '') {
    throw invalid('artifact fileName must be a non-empty string')
  }
  if (!(input.bytes instanceof Uint8Array)) {
    throw invalid('artifact bytes must be a Uint8Array')
  }
}

function producerOf(meta: Record<string, unknown> | undefined): string | undefined {
  if (!meta || typeof meta.producer !== 'string') return undefined
  const producer = meta.producer.trim()
  return producer === '' ? undefined : producer
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Accepts a record keyed by id; tolerates junk entries instead of crashing. */
function manifestFromParsed(parsed: unknown): Map<string, ArtifactMeta> | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const entries = new Map<string, ArtifactMeta>()
  for (const [key, value] of Object.entries(parsed)) {
    const entry = sanitizeArtifactMeta(value, key)
    if (entry) entries.set(entry.id, entry)
  }
  return entries
}

function sanitizeArtifactMeta(value: unknown, fallbackId: string): ArtifactMeta | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  const str = (x: unknown, fallback: string): string =>
    typeof x === 'string' && x.length > 0 ? x : fallback
  const num = (x: unknown, fallback: number): number =>
    typeof x === 'number' && Number.isFinite(x) ? x : fallback
  const id = str(v.id, fallbackId)
  return {
    id,
    type: str(v.type, 'generic'),
    fileName: str(v.fileName, `${id}.bin`),
    mime: str(v.mime, 'application/octet-stream'),
    size: num(v.size, 0),
    createdAt: str(v.createdAt, new Date(0).toISOString()),
    meta: isPlainObject(v.meta) ? (v.meta as Record<string, unknown>) : {},
    producers: Array.isArray(v.producers) ? v.producers.filter((p): p is string => typeof p === 'string') : [],
  }
}

function isPlainObject(x: unknown): boolean {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function isErrno(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === code
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
