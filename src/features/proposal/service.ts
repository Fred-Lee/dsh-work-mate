/**
 * The `workmate.proposal` service (design D2): the change-proposal middle
 * layer's domain face. M1 ships create-or-update / read; OpenSpec directory
 * generation, `[proposal:<id>]` commit association and the tool registration
 * arrive with M2.
 */
import {
  ProposalStore,
  type BlockerEntry,
  type DecisionEntry,
  type Proposal,
  type ApprovalRecord,
  type ProposalSource,
  type ProposalTarget,
  type Provenance,
} from './store.ts'
import { normalizeTargets } from './targets.ts'
import { EventLog, type EventActor, type ProposalEvent } from './events.ts'
import type { ProposalState } from './state-machine.ts'

/** Attribution for one status write (change `add-proposal-metrics`). */
export interface StatusMeta {
  /** Who drove the transition: the agent's tool, a human on the panel, or the plugin. */
  actor?: EventActor
  /** Why it happened (forwarded to the event log). */
  reason?: string
  /** Step-level detail (e.g. the archive failure summary). */
  detail?: string
}

export interface AddApprovalInput {
  gate: ProposalState
  actor: 'human' | 'system'
  decision?: 'approve' | 'reject'
  rationale?: string
  commit?: string
  /** Gates waived by `force` (change `harden-archive-gates`); absent for state approvals. */
  forcedGates?: string[]
  /** Plan fingerprint this approval covers (G2); recorded for `ready`. */
  planHash?: string
}

/** Fields the lifecycle layer may patch directly (manager outputs, branches, wiki refs). */
const PATCHABLE = new Set([
  'worktreePath',
  'portRange',
  'proposalBranch',
  'featureBranch',
  'targets',
  'wikiLinks',
  'archiveManifest',
  'risk',
  'abandonedAt',
  'abandonedReason',
  'autoAdvancedAt',
])

export interface UpsertProposalInput {
  id: string
  title: string
  projects?: string[]
  /** Per-project carriers; when supplied they define the associated projects. */
  targets?: ProposalTarget[]
  /** Project that owns the OpenSpec change directory (defaults to the first target). */
  primaryProject?: string
  /**
   * OpenSpec change directory name; defaults to the proposal id so that
   * `workmate_proposal_create` can seed `openspec/changes/<id>/` (M2).
   */
  openspecChangeId?: string
  /** See `Proposal.source` (change `add-feedback-loop`). */
  source?: ProposalSource
  sourceRef?: string
  relatesTo?: string[]
  provenance?: Provenance
}

export interface AddDecisionInput {
  decision: string
  rationale: string
  /** Explicitly overturned earlier entry; must exist. */
  supersedes?: string
}

export interface BlockInput {
  question: string
  tried?: string
}

export interface ProposalService {
  /** Deliberate exit without the archive orchestration; `actor` keeps the audit honest. */
  abandon(id: string, reason: string, actor?: EventActor): Promise<Proposal>
  rootDir(): string
  list(): Promise<Proposal[]>
  get(id: string): Promise<Proposal | undefined>
  upsert(input: UpsertProposalInput): Promise<Proposal>
  /**
   * Transition `status` with a single read-modify-write, appending one
   * `transition` event to the proposal event log.
   */
  setStatus(id: string, status: Proposal['status'], meta?: StatusMeta): Promise<Proposal>
  /** Append one raw process event (gate refusals, orchestration outcomes). */
  recordEvent(event: ProposalEvent): Promise<void>
  /** Append a gate approval (human/system only — the gate refuses agents). */
  addApproval(id: string, input: AddApprovalInput): Promise<ApprovalRecord>
  /** Append a materialized decision; `supersedes` must reference an existing entry. */
  addDecision(id: string, input: AddDecisionInput): Promise<DecisionEntry>
  /** Escalate a blocker (open) — the finite human round-trip replaces endless thinking. */
  block(id: string, input: BlockInput): Promise<BlockerEntry>
  /** Answer and resolve one blocker. */
  unblock(id: string, blockerId: string, answer: string): Promise<BlockerEntry>
  /** Patch lifecycle-owned fields (worktree/branches/wiki links). */
  patchFields(id: string, patch: Partial<Proposal>): Promise<Proposal>
}

export class ProposalServiceImpl implements ProposalService {
  constructor(
    private readonly store: ProposalStore,
    private readonly now: () => Date = () => new Date(),
    /** Append-only process log; omitted in read-only embeddings. */
    private readonly events?: EventLog,
  ) {}

  /** 聚合写互斥：同进程内的 load→mutate→save 段串行（change `harden-write-races`）。 */
  private writeLock: Promise<unknown> = Promise.resolve()

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeLock.then(fn, fn)
    this.writeLock = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  rootDir(): string {
    return this.store.rootDir
  }

  list(): Promise<Proposal[]> {
    return this.store.load()
  }

  async get(id: string): Promise<Proposal | undefined> {
    return (await this.store.load()).find((proposal) => proposal.id === id)
  }

  async upsert(input: UpsertProposalInput): Promise<Proposal> {
    return this.serialize(() => this.upsertLocked(input))
  }

  private async upsertLocked(input: UpsertProposalInput): Promise<Proposal> {
    const id = input.id.trim()
    if (!id) throw new Error('proposal id must be a non-empty string')
    // 首字符必须是字母数字：挡掉 `..`、隐藏目录与任何以符号开头的怪 id；
    // 不允许 `/`、`\` 与空白，保证 openspec/changes/<id> 永远是单个安全路径段
    // （review 2026-11-08：id 此前无校验，`../../x` 可经 generateChangeDir 在项目外建目录）。
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
      throw new Error(`proposal id 只允许字母、数字与 . _ -（不能含路径分隔符）: ${JSON.stringify(id)}`)
    }

    const proposals = await this.store.load()
    const timestamp = this.now().toISOString()
    const existing = proposals.find((proposal) => proposal.id === id)

    if (existing) {
      existing.title = input.title
      if (input.projects !== undefined) existing.projects = [...input.projects]
      if (input.targets !== undefined) {
        const targets = normalizeTargets(input.targets)
        existing.targets = targets
        if (input.projects === undefined) existing.projects = targets.map((target) => target.project)
        const first = targets[0]?.project
        if (existing.primaryProject === undefined && first !== undefined) existing.primaryProject = first
      }
      if (input.primaryProject !== undefined) existing.primaryProject = input.primaryProject
      if (input.openspecChangeId !== undefined) existing.openspecChangeId = input.openspecChangeId
      // Only explicitly supplied provenance overwrites: a re-run of create must
      // not wipe where the proposal actually came from.
      if (input.source !== undefined) existing.source = input.source
      if (input.sourceRef !== undefined) existing.sourceRef = input.sourceRef
      if (input.relatesTo !== undefined) existing.relatesTo = [...input.relatesTo]
      if (input.provenance !== undefined) existing.provenance = { ...input.provenance }
      existing.updatedAt = timestamp
      await this.store.save(proposals)
      return existing
    }

    const targets = input.targets === undefined ? undefined : normalizeTargets(input.targets)
    const created: Proposal = {
      id,
      title: input.title,
      status: 'draft',
      projects: input.projects ? [...input.projects] : (targets?.map((target) => target.project) ?? []),
      commits: [],
      openspecChangeId: input.openspecChangeId ?? id,
      ...(targets !== undefined ? { targets } : {}),
      ...(input.primaryProject !== undefined
        ? { primaryProject: input.primaryProject }
        : targets?.[0] !== undefined
          ? { primaryProject: targets[0]!.project }
          : {}),
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.sourceRef !== undefined ? { sourceRef: input.sourceRef } : {}),
      ...(input.relatesTo !== undefined ? { relatesTo: [...input.relatesTo] } : {}),
      ...(input.provenance !== undefined ? { provenance: { ...input.provenance } } : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    proposals.push(created)
    await this.store.save(proposals)
    return created
  }

  async addDecision(id: string, input: AddDecisionInput): Promise<DecisionEntry> {
    return this.serialize(() => this.addDecisionLocked(id, input))
  }

  private async addDecisionLocked(id: string, input: AddDecisionInput): Promise<DecisionEntry> {
    const decision = input.decision.trim()
    const rationale = input.rationale.trim()
    if (!decision) throw new Error('decision must be a non-empty string')
    if (!rationale) throw new Error('rationale must be a non-empty string')

    const proposals = await this.store.load()
    const existing = proposals.find((proposal) => proposal.id === id)
    if (!existing) throw new Error(`proposal not found: ${id}`)
    if (input.supersedes !== undefined) {
      const superseded = (existing.decisions ?? []).some((entry) => entry.id === input.supersedes)
      if (!superseded) {
        throw new Error(`supersedes '${input.supersedes}' does not reference an existing decision of ${id}`)
      }
    }

    const entry: DecisionEntry = {
      id: `decision-${(existing.decisions ?? []).length + 1}`,
      decision,
      rationale,
      at: this.now().toISOString(),
      ...(input.supersedes !== undefined ? { supersedes: input.supersedes } : {}),
    }
    existing.decisions = [...(existing.decisions ?? []), entry]
    existing.updatedAt = entry.at
    await this.store.save(proposals)
    return entry
  }

  async block(id: string, input: BlockInput): Promise<BlockerEntry> {
    const question = input.question.trim()
    if (!question) throw new Error('question must be a non-empty string')

    const proposals = await this.store.load()
    const existing = proposals.find((proposal) => proposal.id === id)
    if (!existing) throw new Error(`proposal not found: ${id}`)

    const entry: BlockerEntry = {
      id: `blocker-${(existing.blockers ?? []).length + 1}`,
      question,
      status: 'open',
      at: this.now().toISOString(),
      ...(input.tried !== undefined && input.tried.trim() !== '' ? { tried: input.tried.trim() } : {}),
    }
    existing.blockers = [...(existing.blockers ?? []), entry]
    existing.updatedAt = entry.at
    await this.store.save(proposals)
    return entry
  }

  async unblock(id: string, blockerId: string, answer: string): Promise<BlockerEntry> {
    const trimmed = answer.trim()
    if (!trimmed) throw new Error('answer must be a non-empty string')

    const proposals = await this.store.load()
    const existing = proposals.find((proposal) => proposal.id === id)
    if (!existing) throw new Error(`proposal not found: ${id}`)
    const blocker = (existing.blockers ?? []).find((entry) => entry.id === blockerId)
    if (!blocker) throw new Error(`blocker not found: ${blockerId}`)
    if (blocker.status === 'resolved') throw new Error(`blocker ${blockerId} is already resolved`)

    blocker.status = 'resolved'
    blocker.answer = trimmed
    blocker.answeredAt = this.now().toISOString()
    existing.updatedAt = blocker.answeredAt
    await this.store.save(proposals)
    return blocker
  }

  async patchFields(id: string, patch: Partial<Proposal>): Promise<Proposal> {
    return this.serialize(() => this.patchFieldsLocked(id, patch))
  }

  private async patchFieldsLocked(id: string, patch: Partial<Proposal>): Promise<Proposal> {
    const proposals = await this.store.load()
    const existing = proposals.find((proposal) => proposal.id === id)
    if (!existing) throw new Error(`proposal not found: ${id}`)
    const normalized = patch.targets === undefined ? patch : { ...patch, targets: normalizeTargets(patch.targets) }
    for (const [key, value] of Object.entries(normalized)) {
      if (!PATCHABLE.has(key)) throw new Error(`field '${key}' is not patchable`)
      ;(existing as unknown as Record<string, unknown>)[key] = value
    }
    existing.updatedAt = this.now().toISOString()
    await this.store.save(proposals)
    return existing
  }

  async recordEvent(event: ProposalEvent): Promise<void> {
    await this.events?.append(event)
  }

  async addApproval(id: string, input: AddApprovalInput): Promise<ApprovalRecord> {
    return this.serialize(() => this.addApprovalLocked(id, input))
  }

  private async addApprovalLocked(id: string, input: AddApprovalInput): Promise<ApprovalRecord> {
    const proposals = await this.store.load()
    const existing = proposals.find((proposal) => proposal.id === id)
    if (!existing) throw new Error(`proposal not found: ${id}`)
    const record: ApprovalRecord = {
      gate: input.gate,
      actor: input.actor,
      decision: input.decision ?? 'approve',
      ...(input.rationale !== undefined && input.rationale !== '' ? { rationale: input.rationale } : {}),
      ...(input.forcedGates !== undefined && input.forcedGates.length > 0 ? { forcedGates: input.forcedGates } : {}),
      at: this.now().toISOString(),
      ...(input.commit !== undefined && input.commit !== '' ? { commit: input.commit } : {}),
      ...(input.planHash !== undefined && input.planHash !== '' ? { planHash: input.planHash } : {}),
    }
    existing.approvals = [...(existing.approvals ?? []), record]
    existing.updatedAt = record.at
    await this.store.save(proposals)
    return record
  }

  /**
   * Deliberate exit for a proposal that cannot go through the normal lifecycle — an
   * orphaned demo, a dead project root, or a change nobody will finish. It does NOT run the
   * archive orchestration (no openspec archive, no review gate): it records WHO decided and
   * WHY, and moves the proposal to the terminal state so the board stops showing it as work.
   */
  async abandon(id: string, reason: string, actor: EventActor = 'human'): Promise<Proposal> {
    const trimmed = reason.trim()
    if (trimmed === '') throw new Error('abandon 需要说明原因（便于审计）')
    const proposals = await this.store.load()
    const existing = proposals.find((proposal) => proposal.id === id)
    if (!existing) throw new Error(`proposal not found: ${id}`)
    if (existing.status === 'archived') throw new Error(`proposal ${id} 已归档，无需终止`)
    const from = existing.status
    const at = this.now().toISOString()
    existing.status = 'archived'
    existing.abandonedAt = at
    existing.abandonedReason = trimmed
    existing.updatedAt = at
    await this.store.save(proposals)
    if (this.events !== undefined) {
      await this.events.append({
        at,
        proposalId: id,
        kind: 'transition',
        from,
        to: 'archived',
        actor,
        reason: `abandoned: ${trimmed}`,
      })
    }
    return existing
  }

  async setStatus(id: string, status: Proposal['status'], meta: StatusMeta = {}): Promise<Proposal> {
    return this.serialize(() => this.setStatusLocked(id, status, meta))
  }

  private async setStatusLocked(id: string, status: Proposal['status'], meta: StatusMeta = {}): Promise<Proposal> {
    const proposals = await this.store.load()
    const existing = proposals.find((proposal) => proposal.id === id)
    if (!existing) throw new Error(`proposal not found: ${id}`)
    const from = existing.status
    existing.status = status
    existing.updatedAt = this.now().toISOString()
    await this.store.save(proposals)
    if (this.events !== undefined && from !== status) {
      await this.events.append({
        at: existing.updatedAt,
        proposalId: id,
        kind: 'transition',
        from,
        to: status,
        actor: meta.actor ?? 'system',
        ...(meta.reason !== undefined ? { reason: meta.reason } : {}),
        ...(meta.detail !== undefined ? { detail: meta.detail } : {}),
      })
    }
    return existing
  }
}
