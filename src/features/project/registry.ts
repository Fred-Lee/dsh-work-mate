/**
 * Project registry: named projects with filesystem roots, persisted at
 * `$DSH_HOME/workmate/projects.json` (atomic tmp+rename). Proposals associate
 * project NAMES; every filesystem action (git scan, openspec archive) resolves
 * the name through this table. A missing entry is not an error — the proposal
 * detail simply marks the association as unresolved.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { validateProjectRoot } from '../proposal/openspec.ts'
import { ProposalStore } from '../proposal/store.ts'

export interface RegisteredProject {
  name: string
  root: string
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

  private async read(): Promise<RegisteredProject[]> {
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed) ? (parsed as RegisteredProject[]) : []
    } catch {
      return []
    }
  }

  private async write(projects: RegisteredProject[]): Promise<void> {
    await mkdir(join(this.file, '..'), { recursive: true })
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

  /** Register or re-root a project. `name` is the identity, roots may move. */
  async upsert(name: string, root: string): Promise<RegisteredProject> {
    const cleanName = name.trim()
    if (!cleanName) throw new Error('project name must be a non-empty string')
    const resolvedRoot = validateProjectRoot(root.trim())
    const projects = await this.read()
    const existing = projects.find((project) => project.name === cleanName)
    if (existing) {
      existing.root = resolvedRoot
    } else {
      projects.push({ name: cleanName, root: resolvedRoot })
    }
    await this.write(projects)
    return { name: cleanName, root: resolvedRoot }
  }

  async remove(name: string): Promise<boolean> {
    const projects = await this.read()
    const next = projects.filter((project) => project.name !== name)
    if (next.length === projects.length) return false
    await this.write(next)
    return true
  }
}
