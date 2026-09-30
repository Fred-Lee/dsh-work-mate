/**
 * Port allocator (change add-lifecycle-worktree-wiki): each worktree gets a
 * disjoint segment `basePort + index * portStep` (segmentSize ports wide),
 * tracked in `$DSH_HOME/workmate/ports.json`. Allocation picks the first free
 * index so concurrent worktrees never collide; removal releases the record.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { ProposalStore } from '../proposal/store.ts'

export interface PortAllocation {
  base: number
  ports: number[]
}

export interface PortTable {
  [proposalId: string]: PortAllocation
}

export interface PortAllocatorOptions {
  homeRoot?: string
  subdir: string
}

export class PortAllocator {
  private readonly file: string
  private readonly segmentSize: number

  constructor(options: PortAllocatorOptions, private readonly basePort: number, private readonly portStep: number) {
    const store = new ProposalStore(options)
    this.file = join(store.rootDir, 'ports.json')
    this.segmentSize = 5
  }

  paths(): { file: string } {
    return { file: this.file }
  }

  private async read(): Promise<PortTable> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file, 'utf8'))
      return parsed !== null && typeof parsed === 'object' ? (parsed as PortTable) : {}
    } catch {
      return {}
    }
  }

  private async write(table: PortTable): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    await writeFile(tmp, JSON.stringify(table, null, 2) + '\n', 'utf8')
    await rename(tmp, this.file)
  }

  /** First unused offset index given the live table. */
  private freeIndex(table: PortTable): number {
    const used = new Set(
      Object.values(table).map((allocation) => Math.round((allocation.base - this.basePort) / this.portStep)),
    )
    let index = 0
    while (used.has(index)) index += 1
    return index
  }

  /** Allocate a fresh segment for the proposal. Idempotent per proposal. */
  async allocate(proposalId: string): Promise<PortAllocation> {
    const table = await this.read()
    const existing = table[proposalId]
    if (existing !== undefined) return existing

    const index = this.freeIndex(table)
    const base = this.basePort + index * this.portStep
    const ports = Array.from({ length: this.segmentSize }, (_, offset) => base + offset)
    table[proposalId] = { base, ports }
    await this.write(table)
    return { base, ports }
  }

  /** Release the proposal's segment. Returns whether a record was removed. */
  async release(proposalId: string): Promise<boolean> {
    const table = await this.read()
    if (table[proposalId] === undefined) return false
    delete table[proposalId]
    await this.write(table)
    return true
  }

  async get(proposalId: string): Promise<PortAllocation | undefined> {
    return (await this.read())[proposalId]
  }
}
