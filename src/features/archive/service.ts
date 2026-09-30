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
    options: { openspecRoot: string },
  ): Promise<OrchestrationResult>
  /** Resolves the proposal's associated project names into per-project roots. */
  resolveProjectRoots?(proposal: Proposal): Promise<OrchestrationTarget[]>
  gitnexusEnabled?: boolean
  now?: () => Date
}

export interface LifecycleState {
  status: ProposalState
  hint: string
  next?: ProposalState
  worktreePath?: string
  portRange?: number[]
}

export interface TransitionOutcome {
  proposal: Proposal
  /** Set when the transition created the worktree (ready→implementing). */
  worktree?: { worktreePath: string; portRange: number[]; install: string }
  orchestration?: OrchestrationResult
}

export class LifecycleServiceImpl {
  constructor(private readonly deps: LifecycleDeps) {}

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
  async advance(id: string): Promise<TransitionOutcome> {
    const proposal = await this.mustGet(id)
    const next = nextState(proposal.status)
    if (next === undefined) throw new InvalidTransitionError(`proposal ${id} is already archived (terminal)`)
    return this.transition(id, next)
  }

  /** Move to an adjacent state (forward: preconditions; backward: free). */
  async transition(id: string, to: ProposalState): Promise<TransitionOutcome> {
    const proposal = await this.mustGet(id)
    const check = checkTransition(proposal.status, to)
    if (!check.ok) throw new InvalidTransitionError(check.reason ?? 'invalid transition')

    if (check.direction === 'forward') {
      await this.checkPreconditions(proposal, to)
      const worktree = await this.applySideEffects(proposal, to)
      const updated = await this.deps.proposals.setStatus(id, to)
      return { proposal: updated, ...(worktree !== undefined ? { worktree } : {}) }
    }
    return { proposal: await this.deps.proposals.setStatus(id, to) }
  }

  private async checkPreconditions(proposal: Proposal, to: ProposalState): Promise<void> {
    const root = await this.primaryRoot(proposal)
    // Headless proposals (no associated project root) skip project-side facts.
    if (root === undefined) return
    switch (to) {
      case 'proposing': {
        try {
          await stat(join(root, 'openspec', 'changes', proposal.openspecChangeId, 'proposal.md'))
        } catch {
          throw new InvalidTransitionError(
            `openspec/changes/${proposal.openspecChangeId}/proposal.md 不存在 — 先生成提案文件`,
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
        const tasks = await readWikiTasks(root, 'openspec', proposal.openspecChangeId)
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
  ): Promise<TransitionOutcome['worktree'] | undefined> {
    if (to === 'implementing') {
      const root = await this.primaryRoot(proposal)
      if (root === undefined) {
        throw new InvalidTransitionError('无关联项目根 — 无法创建 worktree；先在面板关联项目')
      }
      const created = await this.deps.worktree.create({ projectRoot: root, proposalId: proposal.id })
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
      const changeDir = join(root, 'openspec', 'changes', proposal.openspecChangeId)
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
   */
  async runArchive(id: string): Promise<TransitionOutcome> {
    const proposal = await this.mustGet(id)
    if (proposal.status !== 'archiving') {
      throw new InvalidTransitionError(
        `proposal ${id} is ${proposal.status} — advance to archiving first（先合并实现分支进 main）`,
      )
    }
    const targets = (await this.deps.resolveProjectRoots?.(proposal)) ?? []
    const orchestration = await this.deps.orchestrate(proposal, targets, { openspecRoot: 'openspec' })
    if (!orchestration.ok) {
      return { proposal, orchestration }
    }

    let cleanup: string | undefined
    if (proposal.worktreePath !== undefined) {
      const root = await this.primaryRoot(proposal)
      if (root !== undefined) {
        const removed = await this.deps.worktree.remove({ projectRoot: root, proposalId: proposal.id })
        cleanup = removed.summary
      }
    }

    const updated = await this.deps.proposals.setStatus(id, 'archived')
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
