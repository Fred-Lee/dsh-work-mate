/**
 * Lifecycle state-machine integration (change add-lifecycle-worktree-wiki):
 * the eight-state chain from `state-machine.ts` with real preconditions —
 * git merge facts for branch states, worktree creation as the
 * ready→implementing side effect, wiki type-coverage before merging, and the
 * archive orchestration behind archiving→archived. Adjacent backward
 * transitions stay free (the lifecycle remains fully reversible); jumping is
 * impossible by construction.
 */
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  checkTransition,
  nextState,
  STATE_HINTS,
  type ProposalState,
} from '../proposal/state-machine.ts'
import type { Proposal } from '../proposal/store.ts'
import type { ProposalService } from '../proposal/service.ts'
import { WorktreeManager } from '../worktree/manager.ts'
import { branchExists, isMergedInto } from '../worktree/git.ts'
import {
  checkCoverage,
  readWikiTasks,
  renderCommitsMd,
  renderWikiMd,
} from '../wiki/links.ts'
import type { OrchestrationResult, OrchestrationTarget } from './orchestrate.ts'
import type { EventActor } from '../proposal/events.ts'
import { CONFIG_DEFAULTS } from '../../config.ts'

/** Target state → the gate whose refusal blocks it (event-log `gate` value). */
const GATE_BY_STATE: Record<ProposalState, string> = {
  draft: 'backward-free',
  proposing: 'proposal-file',
  reviewing: 'proposal-branch',
  ready: 'branch-merged',
  implementing: 'project-root',
  merging: 'wiki-coverage',
  archiving: 'feature-branch',
  archived: 'review-gate',
}

export class InvalidTransitionError extends Error {
  readonly code = 'INVALID_TRANSITION'
  constructor(message: string) {
    super(message)
    this.name = 'InvalidTransitionError'
  }
}

export interface LifecycleDeps {
  proposals: ProposalService
  worktree: WorktreeManager
  /** Archive orchestration behind archiving→archived (review gate etc.). */
  orchestrate(
    proposal: Proposal,
    targets: OrchestrationTarget[],
    options: {
      openspecRoot: string
      reviewGate?: boolean
      tasksGate?: boolean
      planDriftGate?: boolean
      signal?: AbortSignal
    },
  ): Promise<OrchestrationResult>
  /** Reverse orchestration behind archived→archiving (change dirs moved back). */
  reopen?(
    proposal: Proposal,
    targets: OrchestrationTarget[],
    options: { openspecRoot: string; signal?: AbortSignal },
  ): Promise<OrchestrationResult>
  /** Resolves the proposal's associated project names into per-project roots. */
  resolveProjectRoots?(proposal: Proposal): Promise<OrchestrationTarget[]>
  /** OpenSpec root relative to the target project (`Config.openspecRoot`). @default 'openspec' */
  openspecRoot?: string
  /**
   * States that require a human approval to enter (change `add-approval-records`).
   * `Config.approvalsRequired`; empty disables the gate.
   */
  approvalsRequired?: string[]
  /** Let the agent actor cross gated states (`Config.allowAgentApproval`). */
  allowAgentApproval?: boolean
  /** Fail archiving on undeclared changes (`Config.planDriftGate`). */
  planDriftGate?: boolean
  /** Extra states a HIGH-risk proposal needs a human approval for (`Config.highRiskExtraGates`). */
  highRiskExtraGates?: string[]
  /**
   * When the judgement layer is on, an UNASSESSED risk must not silently pass a gated state
   * (a real bypass: `proposal.risk === undefined` made the high-risk gate a no-op).
   */
  riskGateEnabled?: boolean
  now?: () => Date
}

export interface LifecycleState {
  status: ProposalState
  hint: string
  next?: ProposalState
  worktreePath?: string
  portRange?: number[]
}

export interface TransitionOptions {
  /** Forwarded to git / package-manager / CLI subprocesses so a caller can abort. */
  signal?: AbortSignal
  /** Who drove the transition (agent tool / human panel / internal), recorded in the event log. */
  actor?: EventActor
  /** Why the approver crossed the gate; stored on the approval record. */
  rationale?: string
}

export interface ArchiveOptions extends TransitionOptions {
  /** Skip the review gate only (review.md presence + unresolved CRITICAL). */
  force?: boolean
}

export interface TransitionOutcome {
  proposal: Proposal
  /** Set when the transition created the worktree (ready→implementing). */
  worktree?: { worktreePath: string; portRange: number[]; install: string }
  orchestration?: OrchestrationResult
}

export class LifecycleServiceImpl {
  constructor(private readonly deps: LifecycleDeps) {}

  /** Configured OpenSpec directory name; the single source for every path below. */
  private get openspecRoot(): string {
    return this.deps.openspecRoot ?? 'openspec'
  }

  async getState(id: string): Promise<LifecycleState> {
    const proposal = await this.mustGet(id)
    const next = nextState(proposal.status)
    return {
      status: proposal.status,
      hint: STATE_HINTS[proposal.status],
      ...(next !== undefined ? { next } : {}),
      ...(proposal.worktreePath !== undefined ? { worktreePath: proposal.worktreePath } : {}),
      ...(proposal.portRange !== undefined ? { portRange: proposal.portRange } : {}),
    }
  }

  /** Move one state forward, checking that state's preconditions. */
  async advance(id: string, options: TransitionOptions = {}): Promise<TransitionOutcome> {
    const proposal = await this.mustGet(id)
    const next = nextState(proposal.status)
    if (next === undefined) throw new InvalidTransitionError(`proposal ${id} is already archived (terminal)`)
    return this.transition(id, next, options)
  }

  /** Move to an adjacent state (forward: preconditions; backward: free). */
  async transition(id: string, to: ProposalState, options: TransitionOptions = {}): Promise<TransitionOutcome> {
    const proposal = await this.mustGet(id)
    const check = checkTransition(proposal.status, to)
    if (!check.ok) throw new InvalidTransitionError(check.reason ?? 'invalid transition')

    if (check.direction === 'forward') {
      await this.assertApproval(proposal, to, options)
      try {
        await this.checkPreconditions(proposal, to)
      } catch (error) {
        await this.recordGateFailure(proposal, to, error, options.actor)
        throw error
      }
      const worktree = await this.applySideEffects(proposal, to, options)
      if (this.gateReason(to, proposal) !== undefined) await this.recordApproval(proposal, to, options)
      const updated = await this.deps.proposals.setStatus(id, to, { actor: options.actor ?? 'system' })
      return { proposal: updated, ...(worktree !== undefined ? { worktree } : {}) }
    }

    // Backward from archived: the change directories moved under
    // changes/archive/ when the pipeline ran, so roll the filesystem back too
    // (the status field alone would leave a "reopened" proposal with no dir).
    const orchestration =
      proposal.status === 'archived' && this.deps.reopen !== undefined
        ? await this.deps.reopen(proposal, (await this.deps.resolveProjectRoots?.(proposal)) ?? [], {
            openspecRoot: this.openspecRoot,
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
          })
        : undefined
    const updated = await this.deps.proposals.setStatus(id, to, { actor: options.actor ?? 'system' })
    return { proposal: updated, ...(orchestration !== undefined ? { orchestration } : {}) }
  }

  /**
   * A refused gate is data, not noise: record it (with the reason the caller is
   * about to receive) and rethrow unchanged, so control flow and error types are
   * exactly as before (design D4).
   */
  /**
   * Why entering `state` needs a human approval, or undefined when it does not.
   * `approvalsRequired` and the high-risk extras are a UNION: turning on the risk
   * gate must never relax the configured one (design D4).
   */
  private gateReason(state: ProposalState, proposal: Proposal): 'approvalsRequired' | 'high-risk' | undefined {
    // Omitting the config must not silently disable the gate: fall back to the
    // product default, and let tests opt out explicitly with `[]`.
    if ((this.deps.approvalsRequired ?? CONFIG_DEFAULTS.approvalsRequired).includes(state)) return 'approvalsRequired'
    if (proposal.risk === 'high' && (this.deps.highRiskExtraGates ?? CONFIG_DEFAULTS.highRiskExtraGates).includes(state)) {
      return 'high-risk'
    }
    return undefined
  }

  /**
   * Separation of duties (change `add-approval-records`): the agent that produced
   * the change has no way to approve the states listed in `approvalsRequired`.
   * A human (panel/API) or the plugin's own orchestration passes; `force` never
   * bypasses this gate (design D3).
   */
  private async assertApproval(
    proposal: Proposal,
    to: ProposalState,
    options: TransitionOptions,
  ): Promise<void> {
    const gatedByRisk = (this.deps.highRiskExtraGates ?? CONFIG_DEFAULTS.highRiskExtraGates).includes(to)
    const actor = options.actor ?? 'system'
    // Close the bypass: with the judgement layer on, an agent must not slip into a risk-gated
    // state while the risk is still unknown — assess it first (humans may still decide).
    if (
      gatedByRisk &&
      this.deps.riskGateEnabled === true &&
      proposal.risk === undefined &&
      actor === 'agent' &&
      this.deps.allowAgentApproval !== true
    ) {
      const unassessed = new InvalidTransitionError(
        `推进到 ${to} 前必须先判定风险：调用 workmate_assess_risk（高风险会在 approvalsRequired 之外追加人工批准门）`,
      )
      await this.recordGateFailure(proposal, to, unassessed, actor, 'risk-unassessed')
      throw unassessed
    }

    const reason = this.gateReason(to, proposal)
    if (reason === undefined || this.deps.allowAgentApproval === true) return
    if (actor !== 'agent') return
    const error = new InvalidTransitionError(
      reason === 'high-risk'
        ? `${to} 需要人工批准：该提案被判为高风险（由 Config.highRiskExtraGates 追加）——请在面板点「推进到 ${to}` +
            `」，或调整 highRiskExtraGates / 把风险等级改回 medium 以下`
        : `${to} 需要人工批准（写码者不得批准）：请在 WorkMate 面板点「推进到 ${to}」` +
            `，或把 Config.approvalsRequired 里的 '${to}' 去掉` +
            `（设 allowAgentApproval=true 亦可，但那会放弃这条分离）`,
    )
    await this.recordGateFailure(proposal, to, error, options.actor, 'approval')
    throw error
  }

  /** Record a gate crossing on the proposal and in the event stream. */
  private async recordApproval(
    proposal: Proposal,
    to: ProposalState,
    options: TransitionOptions,
  ): Promise<void> {
    const actor: 'human' | 'system' = options.actor === 'human' ? 'human' : 'system'
    const commit = proposal.commits.at(-1)
    const at = this.deps.now?.().toISOString() ?? new Date().toISOString()
    await this.deps.proposals.addApproval(proposal.id, {
      gate: to,
      actor,
      decision: 'approve',
      ...(options.rationale !== undefined ? { rationale: options.rationale } : {}),
      ...(commit !== undefined ? { commit } : {}),
    })
    await this.deps.proposals.recordEvent({
      at,
      proposalId: proposal.id,
      kind: 'approval',
      to,
      actor,
      decision: 'approve',
      ...(options.rationale !== undefined && options.rationale !== '' ? { reason: options.rationale } : {}),
    })
  }

  private async recordGateFailure(
    proposal: Proposal,
    to: ProposalState,
    error: unknown,
    actor: EventActor | undefined,
    gateOverride?: string,
  ): Promise<void> {
    const gate =
      gateOverride ??
      (error instanceof InvalidTransitionError ? (GATE_BY_STATE[to] ?? String(to)) : 'archive-orchestration')
    await this.deps.proposals.recordEvent({
      at: this.deps.now?.().toISOString() ?? new Date().toISOString(),
      proposalId: proposal.id,
      kind: 'gate-failed',
      to,
      actor: actor ?? 'system',
      gate,
      reason: error instanceof Error ? error.message : String(error),
    })
  }

  private async checkPreconditions(proposal: Proposal, to: ProposalState): Promise<void> {
    const root = await this.primaryRoot(proposal)
    // Headless proposals (no associated project root) skip project-side facts.
    if (root === undefined) return
    switch (to) {
      case 'proposing': {
        try {
          await stat(join(root, this.openspecRoot, 'changes', proposal.openspecChangeId, 'proposal.md'))
        } catch {
          throw new InvalidTransitionError(
            `${this.openspecRoot}/changes/${proposal.openspecChangeId}/proposal.md 不存在 — 先生成提案文件`,
          )
        }
        return
      }
      case 'reviewing': {
        const branch = proposal.proposalBranch ?? `proposal/${proposal.id}`
        if (!(await branchExists(root, branch))) {
          throw new InvalidTransitionError(
            `提案分支 ${branch} 不存在 — 先创建分支并提交提案文件（提交信息携带 [proposal:${proposal.id}]）`,
          )
        }
        return
      }
      case 'ready': {
        if (proposal.proposalBranch === undefined) return
        if (!(await isMergedInto(root, proposal.proposalBranch, 'main'))) {
          throw new InvalidTransitionError(
            `提案分支 ${proposal.proposalBranch} 尚未合并进 main — 等待提案评审合并`,
          )
        }
        return
      }
      case 'implementing':
        return // worktree is created as the side effect; failures surface there
      case 'merging': {
        if (root === undefined) return
        const tasks = await readWikiTasks(root, this.openspecRoot, proposal.openspecChangeId)
        if (tasks.length === 0) return
        const coverage = checkCoverage(tasks, proposal.wikiLinks ?? [])
        if (!coverage.ok) {
          const detail = coverage.missing
            .map((m) => `${m.task.slice(0, 40)}（缺 ${m.missingTypes.join('/')}）`)
            .join('；')
          throw new InvalidTransitionError(
            `Wiki 关联未完成 — 以下任务缺少对应 WeKnora 页面类型：${detail}。先经 WeKnora 工具更新页面，再用 workmate_wiki_link 登记。`,
          )
        }
        return
      }
      case 'archiving': {
        if (proposal.featureBranch === undefined) return
        if (!(await isMergedInto(root, proposal.featureBranch, 'main'))) {
          throw new InvalidTransitionError(
            `实现分支 ${proposal.featureBranch} 尚未合并进 main — 先完成实现合并再归档`,
          )
        }
        return
      }
      case 'archived':
        throw new InvalidTransitionError('archived 由归档编排成功后自动达成 — 使用归档端点而非直接转换')
      default:
        return
    }
  }

  /** Heavy work bound to a forward transition. */
  private async applySideEffects(
    proposal: Proposal,
    to: ProposalState,
    options: TransitionOptions = {},
  ): Promise<TransitionOutcome['worktree'] | undefined> {
    if (to === 'implementing') {
      const root = await this.primaryRoot(proposal)
      if (root === undefined) {
        throw new InvalidTransitionError('无关联项目根 — 无法创建 worktree；先在面板关联项目')
      }
      const created = await this.deps.worktree.create({
        projectRoot: root,
        proposalId: proposal.id,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      })
      await this.deps.proposals.patchFields(proposal.id, {
        worktreePath: created.worktreePath,
        portRange: created.portRange,
        featureBranch: created.featureBranch,
      })
      return { worktreePath: created.worktreePath, portRange: created.portRange, install: created.install }
    }
    if (to === 'archiving') {
      // wiki.md + commits.md land in the change dir BEFORE openspec archive
      // moves it under changes/archive/<date>-<id>/
      const root = await this.primaryRoot(proposal)
      if (root === undefined) return undefined
      const changeDir = join(root, this.openspecRoot, 'changes', proposal.openspecChangeId)
      await writeFile(join(changeDir, 'wiki.md'), renderWikiMd(proposal.wikiLinks ?? []), 'utf8')
      const { listProposalCommits } = await import('../proposal/git.ts')
      const scan = await listProposalCommits(root, proposal.openspecChangeId)
      await writeFile(join(changeDir, 'commits.md'), renderCommitsMd(scan.commits), 'utf8')
      return undefined
    }
    return undefined
  }

  /**
   * The archive endpoint: only a proposal already in `archiving` (all
   * preconditions passed, wiki.md/commits.md written) may run the
   * orchestration. Success stamps `archived` and reclaims the worktree.
   * `force` skips the review gate only — never the CLI steps.
   */
  async runArchive(id: string, options: ArchiveOptions = {}): Promise<TransitionOutcome> {
    const proposal = await this.mustGet(id)
    if (proposal.status !== 'archiving') {
      throw new InvalidTransitionError(
        `proposal ${id} is ${proposal.status} — advance to archiving first（先合并实现分支进 main）`,
      )
    }
    const targets = (await this.deps.resolveProjectRoots?.(proposal)) ?? []
    await this.assertApproval(proposal, 'archived', options)
    const orchestration = await this.deps.orchestrate(proposal, targets, {
      openspecRoot: this.openspecRoot,
      reviewGate: options.force !== true,
      tasksGate: options.force !== true,
      planDriftGate: this.deps.planDriftGate === true && options.force !== true,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    })
    if (!orchestration.ok) {
      const failed = orchestration.steps.find((step) => step.status === 'failed')
      await this.deps.proposals.recordEvent({
        at: this.deps.now?.().toISOString() ?? new Date().toISOString(),
        proposalId: proposal.id,
        kind: 'gate-failed',
        to: 'archived',
        actor: options.actor ?? 'system',
        gate: failed?.step ?? 'archive-orchestration',
        reason: failed?.summary ?? 'archive orchestration failed',
        detail: orchestration.steps.map((step) => `${step.step}:${step.status}`).join(' '),
      })
      return { proposal, orchestration }
    }

    let cleanup: string | undefined
    if (proposal.worktreePath !== undefined) {
      const root = await this.primaryRoot(proposal)
      if (root !== undefined) {
        const removed = await this.deps.worktree.remove({
          projectRoot: root,
          proposalId: proposal.id,
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        })
        cleanup = removed.summary
      }
    }

    if (orchestration.manifest !== undefined) {
      await this.deps.proposals.patchFields(id, { archiveManifest: orchestration.manifest })
    }
    const updated = await this.deps.proposals.setStatus(id, 'archived', {
      actor: options.actor ?? 'system',
      detail: cleanup ?? undefined,
    })
    return {
      proposal: updated,
      orchestration:
        cleanup !== undefined
          ? {
              ...orchestration,
              steps: [...orchestration.steps, { step: 'worktree-cleanup' as const, status: 'ok' as const, summary: cleanup }],
            }
          : orchestration,
    }
  }

  private async mustGet(id: string): Promise<Proposal> {
    const proposal = await this.deps.proposals.get(id)
    if (!proposal) throw new Error(`proposal not found: ${id}`)
    return proposal
  }

  private async primaryRoot(proposal: Proposal): Promise<string | undefined> {
    const targets = (await this.deps.resolveProjectRoots?.(proposal)) ?? []
    return targets[0]?.root
  }
}

/** Review-report read used by the detail aggregation (status.ts imports it indirectly). */
export async function readProposalFile(root: string, openspecRoot: string, changeId: string, file: string): Promise<string | undefined> {
  try {
    return await readFile(join(root, openspecRoot, 'changes', changeId, file), 'utf8')
  } catch {
    return undefined
  }
}
