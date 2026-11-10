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
import type { ApprovalRecord, Proposal, ProposalTarget } from '../proposal/store.ts'
import { computePlanFingerprint, type PlanFingerprint } from '../proposal/plan.ts'
import { effectiveTargets } from '../proposal/targets.ts'
import { isOccupying } from '../proposal/isolation.ts'
import { findWriteConflicts, readProposalWriteScopes, type WriteClaim } from '../proposal/writes.ts'
import { checkTaskEvidence } from './task-evidence.ts'
import { collectExecutorIdentities } from './orchestrate.ts'
import type { ProposalService } from '../proposal/service.ts'
import { WorktreeManager } from '../worktree/manager.ts'
import { branchExists, isMergedInto, mergeBranch } from '../worktree/git.ts'
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
  /**
   * `ready→implementing`（superagent 模式）的交接钩子：写实现待办。
   * 由 index.ts 注入，避免生命周期服务直接依赖任务存储。
   */
  onImplementing?(
    proposal: Proposal,
    targets: ReadonlyArray<{ project: string; baseBranch: string }>,
  ): Promise<unknown>
  /** OpenSpec root relative to the target project (`Config.openspecRoot`). @default 'openspec' */
  openspecRoot?: string
  /**
   * The integration trunk the git gates compare against and the proposal worktree is
   * cut from (`Config.lifecycleMainBranch`). Defaults to `'main'`, which is right for
   * a standalone repository; a project developed on a long-lived feature line must set
   * it, otherwise `implementing` branches off a stale `main` and `archiving` can never
   * see the feature branch as merged.
   * @default 'main'
   */
  mainBranch?: string
  /**
   * States that require a human approval to enter (change `add-approval-records`).
   * `Config.approvalsRequired`; empty disables the gate.
   */
  approvalsRequired?: string[]
  /** Let the agent actor cross gated states (`Config.allowAgentApproval`). */
  allowAgentApproval?: boolean
  /** Fail archiving on undeclared changes (`Config.planDriftGate`). */
  planDriftGate?: boolean
  /**
   * Let the agent actor pass `force: true` to the archive run (change
   * `harden-archive-gates`). Default false: skipping the review/tasks/drift gates is a
   * human decision, captured as an approval record rather than an invisible shortcut.
   */
  allowAgentForceArchive?: boolean
  /** Reviewer-independence mode for the archive gate (`Config.reviewerIndependence`). */
  reviewerIndependence?: 'off' | 'warn' | 'block'
  /** Citation-probe mode for the archive gate (`Config.reviewEvidenceGate`). */
  reviewEvidenceGate?: 'off' | 'warn' | 'block'
  /** `TEST.md` / `TEAM-REVIEW.md` required for changes with `TASKS.json` (`Config.teamEvidenceGate`). */
  teamEvidenceGate?: 'off' | 'warn' | 'block'
  /** `Config.weknoraEnabled`：false 时整条 wiki 关联校验关闭。 */
  weknoraEnabled?: boolean
  /** `Config.weknoraWikiRequired`：true 时缺 wiki 页面阻断 merging；默认只记录。 */
  weknoraWikiRequired?: boolean
  /** block | warn | off for cross-proposal write-scope conflicts. @default 'block' */
  writeConflictGate?: 'block' | 'warn' | 'off'
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
  /**
   * Gates this approval waived via `force` (change `harden-archive-gates`). Absent for
   * an ordinary state approval; `runArchive` fills it before recording the forced run.
   */
  forcedGates?: string[]
}

export interface ArchiveOptions extends TransitionOptions {
  /**
   * Skip the review / tasks / drift gates (change `harden-archive-gates`). A human
   * decision: the agent actor is refused unless `allowAgentForceArchive` is set.
   */
  force?: boolean
}

export interface TransitionOutcome {
  proposal: Proposal
  /** Set when the transition created the worktree (ready→implementing). */
  worktree?: { worktreePath: string; portRange: number[]; install: string; targets?: ProposalTarget[] }
  orchestration?: OrchestrationResult
  /**
   * True when the archive run skipped a gate via `force` (change `harden-archive-gates`).
   * Mirrors `OrchestrationResult.forced` so a caller holding only the outcome still knows.
   */
  forced?: boolean
}

export class LifecycleServiceImpl {
  constructor(private readonly deps: LifecycleDeps) {}

  /** Configured OpenSpec directory name; the single source for every path below. */
  private get openspecRoot(): string {
    return this.deps.openspecRoot ?? 'openspec'
  }

  /** Integration trunk for the git gates and the proposal worktree. */
  private get mainBranch(): string {
    return this.deps.mainBranch ?? 'main'
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
        // G5: one human approval covers merge + archive. Merging here makes the
        // archiving precondition (each feature merged into its base) true.
        if (to === 'archiving' && proposal.status === 'merging') {
          await this.mergeTargets(proposal, options)
        }
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
        `推进到 ${to} 前必须先判定风险：调用 workmate_assess_risk。` +
          `若判断层只给出 review 档（置信不足，工具按设计不写入风险），则需要人工在面板点「推进到 ${to}」` +
          `——该守卫只约束 agent，人类不受限制。`,
      )
      await this.recordGateFailure(proposal, to, unassessed, actor, 'risk-unassessed')
      throw unassessed
    }

    const reason = this.gateReason(to, proposal)
    if (reason === undefined || this.deps.allowAgentApproval === true) return
    // 写码者（agent）不得批准，但**插件自己的编排**（system，如自动推进调度器）可以——
    // 那是有意设计：机器推进要能跑通，同时必须在事件流与面板上看得见。
    // 透明度由 recordApproval 保证（actor=system + machineAdvanced 标记），
    // 面板在审批记录里显式标「机器推进」，不伪装成人批的。
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
      // system 身份过门必须留痕可辨：面板据此标「机器推进」而不是人批。
      ...(actor === 'system' ? { machineAdvanced: true } : {}),
      ...(options.rationale !== undefined ? { rationale: options.rationale } : {}),
      ...(commit !== undefined ? { commit } : {}),
      ...(options.forcedGates !== undefined && options.forcedGates.length > 0
        ? { forcedGates: options.forcedGates }
        : {}),
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
        const fingerprint = await computePlanFingerprint(root, this.openspecRoot, proposal.openspecChangeId, proposal.targets)
        if (fingerprint.hash !== undefined) return
        // Legacy proposal-branch flow remains valid but is no longer required.
        const branch = proposal.proposalBranch
        if (branch !== undefined && (await branchExists(root, branch))) return
        throw new InvalidTransitionError(
          `方案工件不完整：缺 ${fingerprint.missing.join(', ')} — 补齐 proposal.md/design.md/tasks.md`,
        )
      }
      case 'ready': {
        const fingerprint = await computePlanFingerprint(root, this.openspecRoot, proposal.openspecChangeId, proposal.targets)
        // The latest G2 decision is authoritative: a later reject (G5 plan issue)
        // invalidates an earlier approve even when the plan hash is unchanged.
        const approvals = (proposal.approvals ?? []).filter((approval) => approval.gate === 'ready')
        const latest = approvals[approvals.length - 1]
        if (
          fingerprint.hash !== undefined &&
          latest?.decision === 'approve' &&
          latest.planHash === fingerprint.hash
        ) {
          return
        }
        // A plan rejection deliberately sends the proposal back to ready for a
        // fresh G1/G2; the next implementing entry still requires a new approve.
        if (latest?.decision === 'reject' && proposal.status === 'implementing') return
        // Legacy branch merge keeps old proposals advancing.
        if (proposal.proposalBranch !== undefined && (await isMergedInto(root, proposal.proposalBranch, this.mainBranch))) return
        throw new InvalidTransitionError(
          fingerprint.hash === undefined
            ? `方案工件不完整，无法生成 planHash — 缺 ${fingerprint.missing.join(', ')}`
            : `G2 方案未确认：先在面板确认 planHash ${fingerprint.hash.slice(0, 12)}…（方案变更会使其失效）`,
        )
      }
      case 'implementing':
        await this.assertCurrentPlanApproval(proposal)
        await this.assertWriteScopes(proposal)
        return // worktree is created as the side effect; failures surface there
      case 'merging': {
        if (root === undefined) return
        // `weknoraEnabled=false` 时整条 wiki 关联流程关闭：不再校验覆盖。
        // `weknoraWikiRequired` 控制「缺页面是否阻断」——此前两者都是死配置，
        // 校验无条件执行，于是 README 承诺的「false 时自动降级」并不存在（实测 2026-11-10）。
        if (this.deps.weknoraEnabled === false) return
        const tasks = await readWikiTasks(root, this.openspecRoot, proposal.openspecChangeId)
        if (tasks.length === 0) return
        const coverage = checkCoverage(tasks, proposal.wikiLinks ?? [])
        if (!coverage.ok) {
          const detail = coverage.missing
            .map((m) => `${m.task.slice(0, 40)}（缺 ${m.missingTypes.join('/')}）`)
            .join('；')
          const message =
            `Wiki 关联未完成 — 以下任务缺少对应 WeKnora 页面类型：${detail}。` +
            `先经 WeKnora 工具更新页面，再用 workmate_wiki_link 登记。`
          // 默认 false：只提示不阻断（与 Config 描述一致）。设 true 才拦归档。
          if (this.deps.weknoraWikiRequired === true) throw new InvalidTransitionError(message)
          await this.deps.proposals.recordEvent({
            at: this.deps.now?.().toISOString() ?? new Date().toISOString(),
            proposalId: proposal.id,
            kind: 'gate-failed',
            to: 'merging',
            actor: 'system',
            gate: 'wiki-coverage',
            reason: message,
            detail: 'weknoraWikiRequired=false：只记录，不阻断',
          })
        }
        return
      }
      case 'archiving': {
        await this.assertTaskEvidence(root, proposal)
        // Legacy single-target proposals keep the original one-branch check.
        if (proposal.targets === undefined || proposal.targets.length === 0) {
          if (proposal.featureBranch === undefined) return
          const trunk = this.mainBranch
          if (!(await isMergedInto(root, proposal.featureBranch, trunk))) {
            throw new InvalidTransitionError(
              `实现分支 ${proposal.featureBranch} 尚未合并进 ${trunk} — 先完成实现合并再归档`,
            )
          }
          return
        }
        const roots = (await this.deps.resolveProjectRoots?.(proposal)) ?? []
        const rootByProject = new Map(roots.map((entry) => [entry.project, entry.root]))
        const unmerged: string[] = []
        const missing: string[] = []
        for (const target of proposal.targets) {
          const projectRoot = rootByProject.get(target.project)
          if (projectRoot === undefined) continue
          if (target.featureBranch === undefined) {
            missing.push(target.project)
            continue
          }
          if (!(await isMergedInto(projectRoot, target.featureBranch, target.baseBranch))) {
            unmerged.push(`${target.project}: ${target.featureBranch} → ${target.baseBranch}`)
          }
        }
        if (missing.length > 0) {
          throw new InvalidTransitionError(`以下 target 缺少实现分支：${missing.join(', ')} — 先完成实现再归档`)
        }
        if (unmerged.length > 0) {
          throw new InvalidTransitionError(
            `实现分支尚未合并进各自基线：${unmerged.join('；')} — 先完成实现合并再归档`,
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
      let targets = effectiveTargets(proposal, this.mainBranch)
      const roots = (await this.deps.resolveProjectRoots?.(proposal)) ?? []
      // Legacy/headless records may have neither `targets` nor `projects` but a
      // resolver that still knows the root (the pre-target tests rely on this).
      if (targets.length === 0 && roots.length > 0) {
        targets = roots.map((entry) => ({ project: entry.project, baseBranch: this.mainBranch }))
      }
      if (targets.length === 0) {
        // 面板没有「给已有提案补关联项目」的入口（只有创建弹窗能勾），
        // 所以别让文案把人指向一个不存在的按钮（真机 2026-11-10）。
        // 可行路径是用 workmate_proposal_create 带 targets 重跑一次（按 id upsert）。
        throw new InvalidTransitionError(
          '提案没有关联任何项目根 — 无法校验基线分支。' +
            '补关联请用 workmate_proposal_create 以同一个 id 带 targets（project + baseBranch）重跑，' +
            '或在面板新建提案时勾选项目',
        )
      }
      const rootByProject = new Map(roots.map((entry) => [entry.project, entry.root]))
      const missing = targets.filter((target) => !rootByProject.has(target.project)).map((target) => target.project)
      if (missing.length > 0) {
        throw new InvalidTransitionError(`项目根未注册：${missing.join(', ')} — 先在面板注册项目`)
      }

      // Super-agent 是唯一执行器：只校验基线分支并保留 targets，不建目录。
      // 目录由 `executor.prepare` 在首次 launch 时创建；这里若抢建，prepare 会因
      // "目录已存在"而跳过初始化（design D10b）。
      const planned: ProposalTarget[] = []
      for (const target of targets) {
        const projectRoot = rootByProject.get(target.project) as string
        const exists = await branchExists(projectRoot, target.baseBranch)
        if (!exists) {
          throw new InvalidTransitionError(
            `基线分支不存在：${target.project}@${target.baseBranch} — 先创建或改选基线分支`,
          )
        }
        planned.push({ ...target })
      }
      await this.deps.proposals.patchFields(proposal.id, { targets: planned })
      // G2 交接：写实现待办（幂等）。失败不回滚状态——待办只是人的意图，
      // 真实执行由 Super-agent 的 Eval 决定；写失败时把原因抛给调用方。
      await this.deps.onImplementing?.(proposal, planned)
      return { worktreePath: '', portRange: [], install: 'skipped', targets: planned }
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
   * `force` skips all four gates (review / tasks / plan-drift / team-evidence) — never the CLI steps.
   */
  /** Compute the plan fingerprint for a proposal (G2 approval covers this hash). */
  async planFingerprint(id: string): Promise<PlanFingerprint> {
    const proposal = await this.mustGet(id)
    const root = await this.primaryRoot(proposal)
    if (root === undefined) {
      throw new InvalidTransitionError(
        '提案没有关联任何项目根 — 无法计算 planHash。' +
          '请用 workmate_proposal_create 以同一个 id 带 targets 重跑以补关联',
      )
    }
    return computePlanFingerprint(root, this.openspecRoot, proposal.openspecChangeId, proposal.targets)
  }

  /** Human G2 approval of one exact plan revision. */
  async approvePlan(
    id: string,
    options: { rationale?: string; actor?: 'human' | 'system' } = {},
  ): Promise<{ approval: ApprovalRecord; fingerprint: PlanFingerprint }> {
    const proposal = await this.mustGet(id)
    const fingerprint = await this.planFingerprint(id)
    if (fingerprint.hash === undefined) {
      throw new InvalidTransitionError(`方案工件不完整，无法确认 — 缺 ${fingerprint.missing.join(', ')}`)
    }
    const approval = await this.deps.proposals.addApproval(id, {
      gate: 'ready',
      actor: options.actor ?? 'human',
      decision: 'approve',
      ...(options.rationale !== undefined && options.rationale !== '' ? { rationale: options.rationale } : {}),
      planHash: fingerprint.hash,
    })
    return { approval, fingerprint }
  }

  /**
   * G5 rejection (change `autonomous-agent-team`, T2-2.6): send the proposal back
   * to implementing with an explicit approval record. `plan` additionally appends
   * a G2 reject, so the old plan approval no longer counts and the next `ready`
   * needs a fresh `approvePlan` of the revised planHash.
   */
  async rejectMerge(
    id: string,
    options: { category: 'plan' | 'implementation'; rationale: string; actor?: 'human' },
  ): Promise<{ approval: ApprovalRecord; proposal: Proposal }> {
    const proposal = await this.mustGet(id)
    if (proposal.status !== 'merging') {
      throw new InvalidTransitionError(`只有 merging 可以被 G5 退回（当前 ${proposal.status}）`)
    }
    if (options.rationale.trim() === '') throw new InvalidTransitionError('G5 拒绝必须写理由')
    const approval = await this.deps.proposals.addApproval(id, {
      gate: 'merging',
      actor: options.actor ?? 'human',
      decision: 'reject',
      rationale: `[${options.category}] ${options.rationale}`,
    })
    if (options.category === 'plan') {
      await this.deps.proposals.addApproval(id, {
        gate: 'ready',
        actor: 'human',
        decision: 'reject',
        rationale: `G5 认定方案问题：${options.rationale}`,
      })
    }
    const implementing = await this.transition(id, 'implementing', {
      actor: options.actor ?? 'human',
      rationale: `G5 拒绝（${options.category}）：${options.rationale}`,
    })
    if (options.category === 'plan') {
      // Spec: a plan-direction rejection goes back to ready, where a fresh
      // planHash approval is required before implementing again.
      const ready = await this.transition(id, 'ready', {
        actor: options.actor ?? 'human',
        rationale: `G5 方案问题，退回 ready 重走 G1/G2：${options.rationale}`,
      })
      return { approval, proposal: ready.proposal }
    }
    return { approval, proposal: implementing.proposal }
  }

  /**
   * Evidence-driven authoring advance: draft → proposing → reviewing → ready.
   * Stops at the first missing evidence or gate (G2 approval of the current
   * planHash); never crosses a human gate. Idempotent.
   */
  async reconcile(
    id: string,
  ): Promise<{ proposal: Proposal; transitions: Array<{ from: ProposalState; to: ProposalState }>; blocked?: string }> {
    const transitions: Array<{ from: ProposalState; to: ProposalState }> = []
    for (let step = 0; step < 3; step += 1) {
      const proposal = await this.mustGet(id)
      if (proposal.status === 'ready') {
        const root = await this.primaryRoot(proposal)
        const fingerprint =
          root === undefined ? { hash: undefined } : await computePlanFingerprint(root, this.openspecRoot, proposal.openspecChangeId, proposal.targets)
        const approvals = (proposal.approvals ?? []).filter((approval) => approval.gate === 'ready')
        const latest = approvals[approvals.length - 1]
        if (fingerprint.hash !== undefined && latest?.planHash !== fingerprint.hash) {
          const outcome = await this.transition(id, 'reviewing', { actor: 'system' })
          transitions.push({ from: 'ready', to: 'reviewing' })
          if (transitions.length >= 3) return { proposal: outcome.proposal, transitions }
          continue
        }
        return { proposal, transitions }
      }
      const next: ProposalState | undefined =
        proposal.status === 'draft'
          ? 'proposing'
          : proposal.status === 'proposing'
            ? 'reviewing'
            : proposal.status === 'reviewing'
              ? 'ready'
              : undefined
      if (next === undefined) return { proposal, transitions }
      try {
        await this.transition(id, next, { actor: 'system' })
        transitions.push({ from: proposal.status, to: next })
      } catch (error) {
        return {
          proposal: await this.mustGet(id),
          transitions,
          blocked: error instanceof Error ? error.message : String(error),
        }
      }
    }
    return { proposal: await this.mustGet(id), transitions }
  }

  async runArchive(id: string, options: ArchiveOptions = {}): Promise<TransitionOutcome> {
    const proposal = await this.mustGet(id)
    if (proposal.status !== 'archiving') {
      throw new InvalidTransitionError(
        `proposal ${id} is ${proposal.status} — advance to archiving first（先合并实现分支进 main）`,
      )
    }
    // Re-check team evidence at the archive entry point: a proposal may already
    // be in `archiving`, so the merging-transition check is not enough (a planned
    // Run or a deleted TASKS.json could otherwise slip through).
    const targets = (await this.deps.resolveProjectRoots?.(proposal)) ?? []
    if (options.force !== true && targets[0]?.root !== undefined) {
      await this.assertTaskEvidence(targets[0].root, proposal)
    }
    await this.assertApproval(proposal, 'archived', options)
    if (options.force === true) await this.assertForceAllowed(proposal, options)
    const orchestration = await this.deps.orchestrate(proposal, targets, {
      openspecRoot: this.openspecRoot,
      reviewGate: options.force !== true,
      tasksGate: options.force !== true,
      planDriftGate: this.deps.planDriftGate === true && options.force !== true,
      ...(this.deps.reviewerIndependence !== undefined ? { reviewerIndependence: this.deps.reviewerIndependence } : {}),
      ...(this.deps.reviewEvidenceGate !== undefined ? { reviewEvidenceGate: this.deps.reviewEvidenceGate } : {}),
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
    const cleanupTargets = effectiveTargets(proposal, this.mainBranch)
    if (cleanupTargets.length > 0) {
      const roots = (await this.deps.resolveProjectRoots?.(proposal)) ?? []
      const rootByProject = new Map(roots.map((entry) => [entry.project, entry.root]))
      const summaries: string[] = []
      for (const target of cleanupTargets) {
        if (target.worktreePath === undefined) continue
        const root = rootByProject.get(target.project)
        if (root === undefined) continue
        const removed = await this.deps.worktree.remove({
          projectRoot: root,
          project: target.project,
          proposalId: proposal.id,
          baseBranch: target.baseBranch,
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        })
        summaries.push(`${target.project}: ${removed.summary}`)
      }
      cleanup = summaries.length > 0 ? summaries.join(' | ') : undefined
    } else if (proposal.worktreePath !== undefined) {
      const root = await this.primaryRoot(proposal)
      if (root !== undefined) {
        const removed = await this.deps.worktree.remove({
          projectRoot: root,
          proposalId: proposal.id,
          // MED-6（systemone 审查）：legacy 单 target 记录没有 targets 可给
          // baseBranch，必须显式透传配置主干，否则守卫落回字面 'main'，
          // 主干配置为其他分支时已归档提案的 worktree 永远收不回。
          mainBranch: this.mainBranch,
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
    // Only a successful archive leaves the forced-run record: a failed run must not
    // look like a decision that was carried out (change `harden-archive-gates`, D4).
    if (options.force === true) await this.recordForcedArchive(id, options)
    // Re-read so the returned record carries the forced-run approval it just wrote —
    // `updated` is the snapshot taken before that write.
    const returned = options.force === true ? ((await this.deps.proposals.get(id)) ?? updated) : updated
    return {
      proposal: returned,
      orchestration:
        cleanup !== undefined
          ? {
              ...orchestration,
              steps: [...orchestration.steps, { step: 'worktree-cleanup' as const, status: 'ok' as const, summary: cleanup }],
            }
          : orchestration,
      ...(orchestration.forced === true || options.force === true ? { forced: true } : {}),
    }
  }

  /**
   * Skipping a gate is a human decision, not an agent parameter (change
   * `harden-archive-gates`, design D1). The panel/API path keeps working; the agent
   * path is refused unless the operator opted in with `allowAgentForceArchive`.
   * A refusal is data: it is recorded as a `gate-failed` event before it is thrown.
   */
  private async assertForceAllowed(proposal: Proposal, options: ArchiveOptions): Promise<void> {
    if (options.actor !== 'agent') return
    if (this.deps.allowAgentForceArchive === true) return
    const error = new InvalidTransitionError(
      'agent 不得用 force 跳过归档门禁（审查门 / 任务门 / 计划漂移门 / 团队证据门）——' +
        `请在 WorkMate 面板对提案 ${proposal.id} 点「强制归档（跳过四道门）」并由人确认，` +
        '或把 Config.allowAgentForceArchive 设为 true（那会放弃这条分离）',
    )
    await this.recordGateFailure(proposal, 'archived', error, options.actor, 'force-archive')
    throw error
  }

  /**
   * A forced archive leaves a record even when it succeeded: who decided it, and which
   * gates were actually bypassed (change `harden-archive-gates`, design D4). The gate
   * list lands in the existing `rationale` field so no store shape changes.
   */
  private async recordForcedArchive(id: string, options: ArchiveOptions): Promise<void> {
    const proposal = await this.deps.proposals.get(id)
    if (proposal === undefined) return
    // Derived from what this call actually disabled: the service — not the nested
    // orchestrator's step log — is the authority on which gates `force` turned off.
    // The drift gate only exists when it is configured on, so it is only listed then.
    const forcedGates = [
      'review-gate',
      'tasks',
      'team-evidence',
      ...(this.deps.planDriftGate === true ? ['plan-drift'] : []),
    ]
    const rationale =
      (options.rationale !== undefined && options.rationale !== '' ? `${options.rationale}；` : '') +
      `force 跳过：${forcedGates.join(' / ')}`
    await this.recordApproval(proposal, 'archived', { ...options, rationale, forcedGates })
  }

  private async mustGet(id: string): Promise<Proposal> {
    const proposal = await this.deps.proposals.get(id)
    if (!proposal) throw new Error(`proposal not found: ${id}`)
    return proposal
  }

  /**
   * `TEST.md` / `TEAM-REVIEW.md` 只在变更目录里有 `TASKS.json` 时必需
   * （change `remove-team-executor`：判据从"有没有团队 Run"改成"有没有任务清单"）。
   *
   * 独立性判定只看工件本身：`TEAM-REVIEW.md` 的 reviewer 标记与标记提交的作者比较。
   * 拿不到 git 事实时按 `reviewerIndependence` 降级，不静默通过。
   */
  private async assertTaskEvidence(root: string, proposal: Proposal): Promise<void> {
    const gate = this.deps.teamEvidenceGate ?? 'block'
    if (gate === 'off') return
    const result = await checkTaskEvidence(root, this.openspecRoot, proposal.openspecChangeId)
    if (!result.managed) return

    const errors = [...result.errors]
    const independence = this.deps.reviewerIndependence ?? 'warn'
    if (result.reviewer !== undefined && independence !== 'off') {
      const authors = await this.markedCommitAuthors(root, proposal.id)
      if (authors.includes(result.reviewer)) {
        const message = `TEAM-REVIEW reviewer ${result.reviewer} 与标记提交的作者相同（same-as-author）`
        if (independence === 'block') errors.push(message)
        else console.warn(`[workmate] ${message} — reviewerIndependence=warn`)
      }
    }

    if (errors.length === 0) return
    const error = new InvalidTransitionError(`任务证据不完整 — ${errors.join('；')}`)
    if (gate === 'block') {
      await this.recordGateFailure(proposal, 'archiving', error, undefined, 'team-evidence')
      throw error
    }
    console.warn(`[workmate] task evidence warning for ${proposal.id}: ${errors.join('；')}`)
  }

  /**
   * 标记提交（`[proposal:<id>]`）的作者集合。
   * 复用 `orchestrate.ts` 的 `collectExecutorIdentities`：同一份 git 事实只读一次口径，
   * 避免两个门对同一个"作者"给出不同结论。非 git 根返回 `[]` → 调用方按 `undetermined` 降级。
   */
  private async markedCommitAuthors(root: string, proposalId: string): Promise<string[]> {
    return (await collectExecutorIdentities(root, proposalId)).flatMap((identity) =>
      [identity.name, identity.email].filter((value): value is string => typeof value === 'string' && value !== ''),
    )
  }

  /** Merge every declared target's feature branch into its base (idempotent). */
  private async mergeTargets(proposal: Proposal, options: TransitionOptions): Promise<void> {
    const targets = effectiveTargets(proposal, this.mainBranch)
    if (targets.length === 0) return
    const roots = (await this.deps.resolveProjectRoots?.(proposal)) ?? []
    const rootByProject = new Map(roots.map((entry) => [entry.project, entry.root]))
    for (const target of targets) {
      if (target.featureBranch === undefined) continue
      const root = rootByProject.get(target.project)
      if (root === undefined) continue
      if (await isMergedInto(root, target.featureBranch, target.baseBranch)) continue
      try {
        await mergeBranch(root, target.featureBranch, target.baseBranch, options.signal)
      } catch (error) {
        throw new InvalidTransitionError(
          `合并 ${target.project}:${target.featureBranch} → ${target.baseBranch} 失败 — ` +
            `${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  /**
   * G2 must still cover the current plan when implementation starts. Only
   * target-based proposals are enforced here; legacy scalar proposals keep
   * their historical flow (no targets/approval snapshot).
   */
  private async assertCurrentPlanApproval(proposal: Proposal): Promise<void> {
    const root = await this.primaryRoot(proposal)
    if (root === undefined) return
    const fingerprint = await computePlanFingerprint(root, this.openspecRoot, proposal.openspecChangeId, proposal.targets)
    // Headless/legacy target fixtures may have no plan artifacts; G2 is enforced
    // where a plan exists (reviewing/ready). Never fabricate a hash.
    if (fingerprint.hash === undefined) return
    const approvals = (proposal.approvals ?? []).filter((approval) => approval.gate === 'ready')
    const latest = approvals[approvals.length - 1]
    if (latest?.decision === 'approve' && latest.planHash === fingerprint.hash) return
    throw new InvalidTransitionError(
      `G2 方案已变化或未确认（当前 planHash ${fingerprint.hash.slice(0, 12)}…）— 重新确认方案后再进入 implementing`,
    )
  }

  /**
   * Declared write-scope overlap is a logical conflict that a worktree cannot
   * fix: two active proposals editing the same files in one project will
   * collide at merge time. Un-declared scopes are not checked here (no
   * evidence), only declarations are.
   */
  private async assertWriteScopes(proposal: Proposal): Promise<void> {
    const targets = effectiveTargets(proposal, this.mainBranch)
    if (targets.length === 0) return
    const roots = (await this.deps.resolveProjectRoots?.(proposal)) ?? []
    const rootByProject = new Map(roots.map((entry) => [entry.project, entry.root]))
    const projects = new Set(targets.map((target) => target.project))
    const claims: WriteClaim[] = []
    for (const target of targets) {
      const projectRoot = rootByProject.get(target.project)
      if (projectRoot === undefined) continue
      const writes = await readProposalWriteScopes(projectRoot, this.openspecRoot, proposal.openspecChangeId)
      if (writes.length > 0) claims.push({ proposalId: proposal.id, project: target.project, writes })
    }
    if (claims.length === 0) {
      console.warn(`[workmate] ${proposal.id} 未声明写域（<!-- writes: ... -->）— 无法机检并行冲突，按 warn 放行`)
      return
    }

    for (const other of await this.deps.proposals.list()) {
      // Only a proposal that is actively implementing can write concurrently;
      // proposing/reviewing/ready are planning states, and merging/archiving are
      // past the write phase. Treating them as occupying made historical proposals
      // block every new implementation forever.
      // 「已终止」只认 abandon 落盘形态（status=archived + abandonedAt）：
      // 残留 abandonedAt 不把活跃提案从写域冲突检查里跳过（与全库统一判据一致）。
      const otherTerminated = other.abandonedAt !== undefined && other.status === 'archived'
      if (other.id === proposal.id || otherTerminated || other.status !== 'implementing') continue
      const otherTargets = effectiveTargets(other, this.mainBranch).filter((target) => projects.has(target.project))
      if (otherTargets.length === 0) continue
      const otherRoots = (await this.deps.resolveProjectRoots?.(other)) ?? []
      const otherRootByProject = new Map(otherRoots.map((entry) => [entry.project, entry.root]))
      for (const target of otherTargets) {
        const projectRoot = otherRootByProject.get(target.project)
        if (projectRoot === undefined) continue
        const writes = await readProposalWriteScopes(projectRoot, this.openspecRoot, other.openspecChangeId)
        if (writes.length > 0) claims.push({ proposalId: other.id, project: target.project, writes })
      }
    }

    const conflicts = findWriteConflicts(claims).filter((conflict) => conflict.proposalIds.includes(proposal.id))
    const gate = this.deps.writeConflictGate ?? 'block'
    if (gate === 'off') return
    if (conflicts.length > 0 && gate === 'warn') {
      console.warn(`[workmate] write-scope conflicts (warn): ${conflicts.map((conflict) => conflict.project).join(', ')}`)
      return
    }
    if (conflicts.length > 0) {
      const detail = conflicts
        .map((conflict) => `${conflict.project}: ${conflict.proposalIds.join(' × ')} → ${conflict.scopes.join(', ')}`)
        .join('；')
      throw new InvalidTransitionError(`写域冲突 — ${detail}；先拆分写域或串行化这两个提案`)
    }
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
