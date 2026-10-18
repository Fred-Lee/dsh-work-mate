/**
 * Project registry: named projects with filesystem roots, persisted at
 * `$DSH_HOME/workmate/projects.json` (atomic tmp+rename). Proposals associate
 * project NAMES; every filesystem action (git scan, openspec archive) resolves
 * the name through this table. A missing entry is not an error — the proposal
 * detail simply marks the association as unresolved.
 *
 * Corruption is a different thing: like `ProposalStore`, a damaged file throws
 * (`StoreCorruptError`) instead of reading as empty, so no write path can ever
 * silently replace a registry the user hand-curated.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { validateProjectRoot } from '../proposal/openspec.ts'
import { ProposalStore, StoreCorruptError } from '../proposal/store.ts'

export interface RegisteredProject {
  name: string
  root: string
  /**
   * Branch a new proposal targets by default (`main` or `master` detected at
   * registration time when omitted). Absent means "not detected yet".
   */
  defaultBranch?: string
  /** Optional grouping label for the panel tree (e.g. the workspace directory). */
  workspace?: string
}

export interface ProjectUpsertOptions {
  /** `''` clears the stored value; `undefined` keeps whatever is already stored. */
  defaultBranch?: string
  /** `''` clears the stored value; `undefined` keeps whatever is already stored. */
  workspace?: string
}

const cleanOptional = (value: string, field: string): string => {
  const trimmed = value.trim()
  if (trimmed !== '' && /\s/.test(trimmed)) {
    throw new Error(`${field} must be a single token without whitespace`)
  }
  return trimmed
}

export interface RegistryOptions {
  homeRoot?: string
  subdir: string
}

export class ProjectRegistry {
  private readonly file: string

  constructor(options: RegistryOptions) {
    const store = new ProposalStore(options)
    this.file = join(store.rootDir, 'projects.json')
  }

  paths(): { file: string } {
    return { file: this.file }
  }

  /** Missing file reads as "no projects yet"; unparsable content throws. */
  private async read(): Promise<RegisteredProject[]> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return []
      throw error
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) {
        throw new StoreCorruptError('projects.json must contain a JSON array', parsed)
      }
      return parsed as RegisteredProject[]
    } catch (error) {
      if (error instanceof StoreCorruptError) throw error
      throw new StoreCorruptError('projects.json is not valid JSON', error)
    }
  }

  private async write(projects: RegisteredProject[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    await writeFile(tmp, JSON.stringify(projects, null, 2) + '\n', 'utf8')
    await rename(tmp, this.file)
  }

  async list(): Promise<RegisteredProject[]> {
    return this.read()
  }

  async get(name: string): Promise<RegisteredProject | undefined> {
    return (await this.read()).find((project) => project.name === name)
  }

  /**
   * Register or re-root a project. `name` is the identity, roots may move.
   * Optional fields are only touched when supplied: omitting them keeps the
   * stored value, passing `''` clears it.
   */
  async upsert(name: string, root: string, options: ProjectUpsertOptions = {}): Promise<RegisteredProject> {
    const cleanName = name.trim()
    if (!cleanName) throw new Error('project name must be a non-empty string')
    const resolvedRoot = validateProjectRoot(root.trim())
    const defaultBranch =
      options.defaultBranch === undefined ? undefined : cleanOptional(options.defaultBranch, 'defaultBranch')
    const workspace = options.workspace === undefined ? undefined : cleanOptional(options.workspace, 'workspace')

    const projects = await this.read()
    const existing = projects.find((project) => project.name === cleanName)
    const target: RegisteredProject = existing ?? { name: cleanName, root: resolvedRoot }
    if (existing === undefined) projects.push(target)
    target.root = resolvedRoot
    if (defaultBranch !== undefined) {
      if (defaultBranch === '') delete target.defaultBranch
      else target.defaultBranch = defaultBranch
    }
    if (workspace !== undefined) {
      if (workspace === '') delete target.workspace
      else target.workspace = workspace
    }
    await this.write(projects)
    return { ...target }
  }

  async remove(name: string): Promise<boolean> {
    const projects = await this.read()
    const next = projects.filter((project) => project.name !== name)
    if (next.length === projects.length) return false
    await this.write(next)
    return true
  }
}

interface NodeError extends Error {
  code?: string
}

function isNodeError(error: unknown): error is NodeError {
  return error instanceof Error && typeof (error as NodeError).code === 'string'
}
