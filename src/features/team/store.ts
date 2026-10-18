/**
 * Durable team runs (change `autonomous-agent-team`, task 1.2). One JSON file
 * under `$DSH_HOME/workmate/team-runs.json`, atomic tmp+rename, corruption
 * fail-closed like the proposal store — a damaged team log must never be
 * silently replaced with an empty one.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ProposalStore, StoreCorruptError } from '../proposal/store.ts'
import { DEFAULT_TEAM_BUDGET, type TeamRun } from './types.ts'

export interface TeamRunStoreOptions {
  homeRoot?: string
  subdir: string
}

const isNodeError = (error: unknown): error is { code?: string } =>
  error instanceof Error && typeof (error as { code?: string }).code === 'string'

const normalize = (run: TeamRun): TeamRun => ({
  ...run,
  tasks: run.tasks ?? [],
  dispatches: run.dispatches ?? [],
  budget: { ...DEFAULT_TEAM_BUDGET, ...(run.budget ?? {}) },
})

export class TeamRunStore {
  readonly rootDir: string
  private readonly file: string

  constructor(options: TeamRunStoreOptions) {
    const store = new ProposalStore(options)
    this.rootDir = store.rootDir
    this.file = join(store.rootDir, 'team-runs.json')
  }

  paths(): { file: string } {
    return { file: this.file }
  }

  async load(): Promise<TeamRun[]> {
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return []
      throw error
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new StoreCorruptError('team-runs.json is not valid JSON', error)
    }
    if (!Array.isArray(parsed)) {
      throw new StoreCorruptError('team-runs.json must contain a JSON array', parsed)
    }
    return (parsed as TeamRun[]).map(normalize)
  }

  async save(runs: readonly TeamRun[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    await writeFile(tmp, `${JSON.stringify(runs, null, 2)}\n`, 'utf8')
    await rename(tmp, this.file)
  }

  async list(): Promise<TeamRun[]> {
    return this.load()
  }

  async get(id: string): Promise<TeamRun | undefined> {
    return (await this.load()).find((run) => run.id === id)
  }

  /** Insert or replace one run; `createdAt` is preserved for an existing id. */
  async upsert(run: TeamRun, now: () => Date = () => new Date()): Promise<TeamRun> {
    const runs = await this.load()
    const timestamp = now().toISOString()
    const existing = runs.find((entry) => entry.id === run.id)
    if (existing !== undefined) {
      const next = normalize({ ...run, createdAt: existing.createdAt, updatedAt: timestamp })
      runs[runs.indexOf(existing)] = next
      await this.save(runs)
      return next
    }
    const created = normalize({ ...run, updatedAt: timestamp })
    runs.push(created)
    await this.save(runs)
    return created
  }

  async patch(id: string, patch: Partial<TeamRun>, now: () => Date = () => new Date()): Promise<TeamRun> {
    const runs = await this.load()
    const existing = runs.find((entry) => entry.id === id)
    if (existing === undefined) throw new Error(`team run not found: ${id}`)
    const next = normalize({ ...existing, ...patch, id, updatedAt: now().toISOString() })
    runs[runs.indexOf(existing)] = next
    await this.save(runs)
    return next
  }
}
