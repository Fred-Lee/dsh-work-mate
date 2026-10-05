/**
 * Proposal persistence: a single `proposals.json` under
 * `<DSH home>/<workmateHome>/` — zero external dependencies, grep-able.
 *
 * Write discipline inherited from the Helmsman line: every write goes through
 * tmp + rename (atomic on the same filesystem), and a corrupt file must fail
 * closed — `load` throws, `save` is only ever reached through a successful
 * `load`, so a broken file is reported at boot and never overwritten.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { migrateStatus, type ProposalState } from './state-machine.ts'

export interface DecisionEntry {
  id: string
  decision: string
  rationale: string
  /** Explicitly overturned earlier entry — silent reversals are forbidden. */
  supersedes?: string
  at: string
}

export interface BlockerEntry {
  id: string
  question: string
  /** What the agent already tried before escalating. */
  tried?: string
  answer?: string
  status: 'open' | 'resolved'
  at: string
  answeredAt?: string
}

export interface WikiLink {
  url: string
  pageType: 'concept' | 'synthesis' | 'entity'
  version?: number
  commit?: string
  taskId?: string
  registeredAt: string
}

/** Where a proposal came from (change `add-feedback-loop`). */
export type ProposalSource = 'spec' | 'incident' | 'review-finding' | 'metric-regression' | 'maintenance'

/** Capture facts for input derived outside the repository. */
export interface Provenance {
  /** When the source material was captured (ISO). */
  capturedAt: string
  /** Content hash of the captured material, when available. */
  contentHash?: string
  /**
   * The source is external text (ticket, log, web page): data, never
   * instructions. Visibility only — it changes no gate by itself.
   */
  untrusted?: boolean
}

/** One gate crossing by a human/system approver (separation of duties). */
export interface ApprovalRecord {
  /** The state this approval authorized entering. */
  gate: ProposalState
  /** Who approved: `human` (panel/API), `system` (plugin orchestration). */
  actor: 'human' | 'system'
  decision: 'approve' | 'reject'
  rationale?: string
  at: string
  /** Implementation-branch HEAD the approval covers, when git was available. */
  commit?: string
}

export interface Proposal {
  /** Slug-style identifier, e.g. "batch-grading-v2". */
  id: string
  title: string
  status: ProposalState
  /** Worktree created at ready→implementing (auto, design D3). */
  worktreePath?: string
  /** Port segment allocated for this proposal's worktree. */
  portRange?: number[]
  /** Proposal branch (created at proposing). */
  proposalBranch?: string
  /** Implementation branch inside the worktree. */
  featureBranch?: string
  /** WeKnora page references registered by the agent. */
  wikiLinks?: WikiLink[]
  /** Associated project identifiers. */
  projects: string[]
  /** Associated Git commit hashes (tag-proposal association, M2). */
  commits: string[]
  /** OpenSpec change directory name this proposal drives. */
  openspecChangeId: string
  /** Materialized directional choices (supersedes chain, auditor-checked). */
  decisions?: DecisionEntry[]
  /** Escalated blockers awaiting an answer (open) with resolutions. */
  blockers?: BlockerEntry[]
  /** Origin of the proposal; absent means it was not declared. */
  source?: ProposalSource
  /** External reference for `source` (ticket id, alert id, URL). */
  sourceRef?: string
  /** Related proposals (rework of an earlier one, same incident). */
  relatesTo?: string[]
  /** Capture facts for externally derived input. */
  provenance?: Provenance
  /** Gate approvals (change `add-approval-records`). */
  approvals?: ApprovalRecord[]
  createdAt: string
  updatedAt: string
}

export class StoreCorruptError extends Error {
  readonly code = 'STORE_CORRUPT'
  constructor(message: string, readonly cause: unknown) {
    super(message)
    this.name = 'StoreCorruptError'
  }
}

/**
 * DSH home resolution: explicit value (tests) wins, then `$DSH_HOME`,
 * then the platform default `~/.dsh`. The env var name is still to be
 * confirmed against the host's `dsh-home-paths` (design D8, checked at M2).
 */
export function resolveDshHome(explicit?: string): string {
  return resolve(explicit ?? process.env['DSH_HOME'] ?? join(homedir(), '.dsh'))
}

export interface ProposalStoreOptions {
  /** Overrides `$DSH_HOME` entirely (tests / embedding). */
  homeRoot?: string
  /** Subdirectory name under the DSH home, from `Config.workmateHome`. */
  subdir: string
}

export class ProposalStore {
  readonly rootDir: string
  private readonly proposalsFile: string

  constructor(options: ProposalStoreOptions) {
    this.rootDir = join(resolveDshHome(options.homeRoot), options.subdir)
    this.proposalsFile = join(this.rootDir, 'proposals.json')
  }

  paths(): { root: string; proposals: string } {
    return { root: this.rootDir, proposals: this.proposalsFile }
  }

  async ensureRoot(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true })
  }

  /** Missing file reads as "no proposals yet"; unparsable content throws. */
  async load(): Promise<Proposal[]> {
    let raw: string
    try {
      raw = await readFile(this.proposalsFile, 'utf8')
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return []
      throw error
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) {
        throw new StoreCorruptError('proposals.json must contain a JSON array', parsed)
      }
      // Normalize records written before newer fields existed, and migrate
      // the pre-eight-state status onto the lifecycle chain.
      return (parsed as Proposal[]).map((proposal) => ({
        ...proposal,
        status: migrateStatus(proposal.status),
        decisions: proposal.decisions ?? [],
        blockers: proposal.blockers ?? [],
        wikiLinks: proposal.wikiLinks ?? [],
      }))
    } catch (error) {
      if (error instanceof StoreCorruptError) throw error
      throw new StoreCorruptError('proposals.json is not valid JSON', error)
    }
  }

  async save(proposals: Proposal[]): Promise<void> {
    await this.ensureRoot()
    const tmp = this.proposalsFile + '.tmp'
    await writeFile(tmp, JSON.stringify(proposals, null, 2) + '\n', 'utf8')
    await rename(tmp, this.proposalsFile)
  }
}

interface NodeError extends Error {
  code?: string
}

function isNodeError(error: unknown): error is NodeError {
  return error instanceof Error && typeof (error as NodeError).code === 'string'
}
