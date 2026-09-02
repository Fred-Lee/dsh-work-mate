/**
 * TopologyStore — persists one JSON file per project group under
 * `~/.helmsman/topologies/` (override with HELMSMAN_HOME env or config).
 * Writes are atomic-ish (single writeFile); reads are normalized so a
 * corrupted or hand-edited file can never crash the host.
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { normalizeTopology, type ProjectTopology } from './types.ts'

export class TopologyStore {
  readonly rootDir: string

  constructor(opts: { rootDir?: string } = {}) {
    const base = process.env.HELMSMAN_HOME ?? join(homedir(), '.helmsman')
    this.rootDir = opts.rootDir ?? join(base, 'topologies')
  }

  private fileFor(group: string): string {
    return join(this.rootDir, `${encodeURIComponent(group)}.json`)
  }

  async listGroups(): Promise<string[]> {
    if (!existsSync(this.rootDir)) return []
    const entries = await readdir(this.rootDir)
    return entries
      .filter((f) => f.endsWith('.json'))
      .map((f) => decodeURIComponent(f.slice(0, -'.json'.length)))
      .sort()
  }

  async load(group: string): Promise<ProjectTopology | null> {
    const file = this.fileFor(group)
    if (!existsSync(file)) return null
    try {
      return normalizeTopology(JSON.parse(await readFile(file, 'utf8')))
    } catch {
      return null
    }
  }

  async save(topology: ProjectTopology): Promise<void> {
    await mkdir(this.rootDir, { recursive: true })
    const normalized = normalizeTopology(topology)
    await writeFile(this.fileFor(normalized.projectGroupId), JSON.stringify(normalized, null, 2), 'utf8')
  }

  async delete(group: string): Promise<boolean> {
    const file = this.fileFor(group)
    if (!existsSync(file)) return false
    await rm(file)
    return true
  }
}
