/**
 * VaultStore — the Helmsman Tolaria vault's filesystem access.
 *
 * The vault is a plain markdown folder (one note per `*.md`, YAML frontmatter),
 * owned by Helmsman and optionally managed by the Tolaria app on the same
 * directory. We deliberately do NOT depend on the tolaria MCP server: read and
 * write go straight to files, so archive/retrieval works offline with zero
 * runtime deps. (Design §3/§5: knowledge-tolaria is a VaultStore facade.)
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { composeNote, parseFrontmatter } from './frontmatter.ts'
import type { Note, NoteKind, NoteMeta, SearchHit } from './types.ts'

const KIND_DIRS: Record<NoteKind, string> = { research: 'notes', prd: 'prds', design: 'designs' }

/** Note ids are filenames under the vault: strict charset, no traversal. */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/

export function assertValidId(id: string): void {
  if (!ID_RE.test(id)) throw new Error(`invalid note id: ${JSON.stringify(id)}`)
}

export interface VaultStoreOptions {
  rootDir?: string
  /** Whether to `git init` an empty vault on first use. @default true */
  gitInit?: boolean
}

export function kindDirOf(kind: NoteKind): string {
  return KIND_DIRS[kind]
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[-]+|[-]+$/g, '')
    .slice(0, 48)
}

/** Random suffix keeps ids unique under same-millisecond archives (no silent overwrite). */
export function makeId(title: string): string {
  const slug = slugify(title)
  return `${slug}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}` || `note-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
}

export function defaultVaultDir(): string {
  const base = process.env.HELMSMAN_HOME ?? join(homedir(), '.helmsman')
  return join(base, 'vault')
}

export class VaultStore {
  readonly rootDir: string
  private readonly gitInit: boolean

  constructor(opts: VaultStoreOptions = {}) {
    this.rootDir = opts.rootDir ?? defaultVaultDir()
    this.gitInit = opts.gitInit ?? true
  }

  /** Ensure the vault dirs exist and (optionally) `git init` once. */
  async ensure(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true })
    for (const sub of new Set<string>(Object.values(KIND_DIRS))) {
      await mkdir(join(this.rootDir, sub), { recursive: true })
    }
    if (this.gitInit && !existsSync(join(this.rootDir, '.git'))) {
      await new Promise<void>((resolve) => {
        execFile('git', ['init'], { cwd: this.rootDir }, (err) => {
          if (err !== null && typeof (err as NodeJS.ErrnoException).code !== 'undefined') {
            console.warn(`[knowledge-tolaria] git init failed (vault still usable without git): ${err.message}`)
          }
          resolve()
        })
      })
    }
  }

  private dirFor(kind: NoteKind): string {
    return join(this.rootDir, KIND_DIRS[kind])
  }

  private fileFor(kind: NoteKind, id: string): string {
    return join(this.dirFor(kind), `${id}.md`)
  }

  /** Archive a finalized note into the vault (create/overwrite by id). */
  async archive(note: Note): Promise<{ id: string; path: string }> {
    await this.ensure()
    const id = note.id || makeId(note.title)
    assertValidId(id)
    const now = new Date().toISOString()
    const meta: Record<string, unknown> = {
      kind: note.kind,
      title: note.title,
      createdAt: note.createdAt || now,
      archivedAt: note.archivedAt || now,
      source: 'helmsman',
      ...note.frontmatter,
    }
    if (note.linkedProjects?.length) meta.linkedProjects = note.linkedProjects
    const path = this.fileFor(note.kind, id)
    await writeFile(path, composeNote(meta, note.body), 'utf8')
    return { id, path }
  }

  /** List note metadata (optionally only one kind). */
  async list(kind?: NoteKind): Promise<NoteMeta[]> {
    await this.ensure()
    const scanned: NoteMeta[] = []
    const dirs = kind ? [{ kind, dir: this.dirFor(kind) }] : allKindDirs(this.rootDir)
    for (const { kind: k, dir } of dirs) {
      for (const m of await this.scanDir(dir, k)) scanned.push(m)
    }
    return scanned.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
  }

  /** Fetch a full note by id across all kind dirs. */
  async get(id: string): Promise<Note | null> {
    assertValidId(id)
    await this.ensure()
    for (const { kind: k, dir } of allKindDirs(this.rootDir)) {
      const path = join(dir, `${id}.md`)
      if (existsSync(path)) {
        const { frontmatter, body } = parseFrontmatter(await readFile(path, 'utf8'))
        const meta = await this.readMeta(path, id, k)
        return { ...meta, body, frontmatter }
      }
    }
    return null
  }

  /** Full-text retrieval over filename/frontmatter/body (case-insensitive). */
  async search(query: string, opts: { kinds?: NoteKind[] } = {}): Promise<SearchHit[]> {
    const q = query.toLowerCase().trim()
    if (!q) return []
    await this.ensure()
    const dirs = opts.kinds?.length
      ? opts.kinds.map((kind) => ({ kind, dir: this.dirFor(kind) }))
      : allKindDirs(this.rootDir)
    const hits: SearchHit[] = []
    for (const { kind, dir } of dirs) {
      for (const meta of await this.scanDir(dir, kind)) {
        // One full read per file: scanDir's readMeta already consumed the
        // frontmatter, this pass takes the body for snippet matching.
        const { frontmatter, body } = parseFrontmatter(await readFile(meta.path, 'utf8'))
        const title = meta.title.toLowerCase()
        const keywords = (Array.isArray(frontmatter.keywords) ? frontmatter.keywords : []).map(String).join(' ').toLowerCase()
        const projects = (meta.linkedProjects ?? []).join(' ').toLowerCase()
        const lowerBody = body.toLowerCase()
        const at = lowerBody.indexOf(q)
        if (title.includes(q)) {
          hits.push({ ...meta, snippet: clip(body), matchedField: 'title' })
        } else if (keywords.includes(q)) {
          hits.push({ ...meta, snippet: clip(body), matchedField: 'keywords' })
        } else if (projects.includes(q)) {
          hits.push({ ...meta, snippet: clip(body), matchedField: 'projects' })
        } else if (at !== -1) {
          hits.push({ ...meta, snippet: clip(body, at), matchedField: 'body' })
        }
      }
    }
    return hits
  }

  private async readMeta(full: string, id: string, kind: NoteKind): Promise<NoteMeta & { path: string }> {
    const { frontmatter } = parseFrontmatter(await readFile(full, 'utf8'))
    const kindOf = (frontmatter.kind as NoteKind | undefined) ?? kind
    return {
      id,
      title: String(frontmatter.title ?? id),
      kind: validKind(kindOf),
      createdAt: String(frontmatter.createdAt ?? ''),
      ...(frontmatter.archivedAt !== undefined ? { archivedAt: String(frontmatter.archivedAt) } : {}),
      ...(Array.isArray(frontmatter.linkedProjects) ? { linkedProjects: frontmatter.linkedProjects.map(String) } : {}),
      path: full,
    }
  }

  private async scanDir(dir: string, kind: NoteKind): Promise<Array<NoteMeta & { path: string }>> {
    if (!existsSync(dir)) return []
    const out: Array<NoteMeta & { path: string }> = []
    for (const f of await readdir(dir)) {
      if (!f.endsWith('.md')) continue
      out.push(await this.readMeta(join(dir, f), f.slice(0, -3), kind))
    }
    return out
  }
}

function allKindDirs(rootDir: string): Array<{ kind: NoteKind; dir: string }> {
  return (Object.entries(KIND_DIRS) as Array<[NoteKind, string]>).map(([kind, sub]) => ({ kind, dir: join(rootDir, sub) }))
}

function validKind(v: NoteKind): NoteKind {
  return v === 'prd' || v === 'design' || v === 'research' ? v : 'research'
}

/** Clip a snippet around the first match position (index computed on the SAME collapsed text). */
function clip(body: string, at = 0): string {
  const text = body.replace(/\s+/g, ' ').trim()
  if (text.length <= 160) return text
  const collapsed = at > 0
    ? body.slice(0, at).replace(/\s+/g, ' ').length
    : 0
  const start = Math.max(0, collapsed - 60)
  return `${start > 0 ? '…' : ''}${text.slice(start, start + 160)}${start + 160 < text.length ? '…' : ''}`
}
