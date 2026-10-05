/**
 * Archive orchestration (M4): the five-step pipeline from the design doc —
 *   tasks snapshot → (swarm parallel run, D1: recorded skip) →
 *   openspec archive --yes → gitnexus analyze --force → status = archived.
 *
 * Failure semantics (D2): any CLI failure halts the pipeline, leaves the
 * proposal untouched and returns the step log for the caller to inspect.
 * Every step is idempotent, so archive can simply be retried.
 */
import { readFile, readdir, rename } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { readChangeState, validateProjectRoot } from '../proposal/openspec.ts'
import { gitnexusAnalyze } from '../knowledge-bridge/gitnexus.ts'
import { formatTally, parseReviewMd, reviewTally } from '../quality/review-parser.ts'
import type { Proposal } from '../proposal/store.ts'
import type { ArchiveManifest, ArchiveManifestEntry } from './manifest.ts'

export interface OrchestrationStep {
  step: 'review-gate' | 'tasks' | 'swarm' | 'openspec-archive' | 'gitnexus-analyze' | 'reopen-dir' | 'worktree-cleanup' | 'status'
  status: 'ok' | 'skipped' | 'failed'
  summary: string
}

export interface OrchestrationTarget {
  project: string
  root: string
}

export interface OrchestrationResult {
  ok: boolean
  steps: OrchestrationStep[]
  tasks?: { done: number; total: number; lines: string[] }
  /** Delivery summary, present when the archive run succeeded. */
  manifest?: ArchiveManifest
  proposal?: Proposal
}

export interface TaskSnapshot {
  done: number
  total: number
  lines: string[]
}

export function parseTasksMd(content: string): TaskSnapshot {
  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^- \[.\] /.test(line))
  const done = lines.filter((line) => /^- \[[xX]\] /.test(line)).length
  return { done, total: lines.length, lines }
}

function execCli(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      cmd,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, ...(signal !== undefined ? { signal } : {}) },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr?.trim() || error.message))
        else resolvePromise(stdout)
      },
    )
  })
}

/**
 * Move `changes/archive/<date>-<id>/` back to `changes/<id>/` (the reverse of
 * `openspec archive`, which has no un-archive command). Returns a summary of
 * what happened; never throws.
 */
export async function revertArchiveDir(
  projectRoot: string,
  openspecRoot: string,
  changeId: string,
): Promise<{ moved: boolean; summary: string }> {
  let root: string
  try {
    root = validateProjectRoot(projectRoot)
  } catch (error) {
    return { moved: false, summary: error instanceof Error ? error.message : String(error) }
  }
  const changesDir = join(root, openspecRoot, 'changes')
  const target = join(changesDir, changeId)
  try {
    if ((await readdir(target)).length >= 0) {
      return { moved: false, summary: 'changes/<id> already exists — nothing to move back' }
    }
  } catch {
    // target absent — proceed
  }
  let entries: string[]
  try {
    entries = await readdir(join(changesDir, 'archive'))
  } catch {
    return { moved: false, summary: 'no archive/ directory' }
  }
  const match = entries.find((entry) => entry.endsWith(`-${changeId}`))
  if (match === undefined) {
    return { moved: false, summary: `no archive entry ending with -${changeId}` }
  }
  try {
    await rename(join(changesDir, 'archive', match), target)
    return { moved: true, summary: `restored ${match} → changes/${changeId}` }
  } catch (error) {
    return {
      moved: false,
      summary: `failed to move back: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

export interface OrchestrateDeps {
  /** `openspec` CLI binary; overridable in tests. */
  openspecBin?: string
  runSwarmTasks?(tasks: TaskSnapshot, projectRoot: string): Promise<string>
}

export interface OrchestrateOptions {
  openspecRoot: string
  gitnexusAnalyzeEnabled?: boolean
  reviewGate?: boolean
  /**
   * Acceptance predicate (change `adopt-workdsh-lessons`, design D3): every
   * associated project's tasks.md must be fully checked. `force` passes false.
   * @default true
   */
  tasksGate?: boolean
  /**
   * Severities whose open findings block archiving (`Config.reviewBlockingSeverities`).
   * @default ['CRIT']
   */
  reviewBlockingSeverities?: string[]
  /** Caller cancellation, forwarded to every spawned CLI. */
  signal?: AbortSignal
}

export async function orchestrateArchive(
  proposal: Proposal,
  targets: OrchestrationTarget[],
  options: OrchestrateOptions,
  deps: OrchestrateDeps = {},
): Promise<OrchestrationResult> {
  const steps: OrchestrationStep[] = []
  const openspecBin = deps.openspecBin ?? 'openspec'
  if (targets.length === 0) {
    steps.push({ step: 'status', status: 'failed', summary: 'no resolvable project roots — nothing to archive against' })
    return { ok: false, steps }
  }
  const firstRoot = validateProjectRoot(targets[0]!.root)

  // 1. tasks snapshot across EVERY resolvable target, then the acceptance
  // predicate (design D3): one project still holding unchecked tasks stops the
  // run, and the step says which project and how far along it is. `force`
  // passes `tasksGate: false` — an explicit decision, not a silent skip.
  const snapshots: Array<{ project: string; snapshot?: TaskSnapshot }> = []
  for (const target of targets) {
    try {
      const content = await readFile(
        join(validateProjectRoot(target.root), options.openspecRoot, 'changes', proposal.openspecChangeId, 'tasks.md'),
        'utf8',
      )
      snapshots.push({ project: target.project, snapshot: parseTasksMd(content) })
    } catch {
      snapshots.push({ project: target.project })
    }
  }
  const withTasks = snapshots.filter((entry) => entry.snapshot !== undefined)
  let tasks = withTasks[0]?.snapshot
  const progress = snapshots
    .map((entry) =>
      entry.snapshot === undefined ? `[${entry.project}] 无 tasks.md` : `[${entry.project}] ${entry.snapshot.done}/${entry.snapshot.total}`,
    )
    .join('，')
  const incomplete = withTasks.filter((entry) => {
    const snapshot = entry.snapshot as TaskSnapshot
    return snapshot.total > 0 && snapshot.done < snapshot.total
  })
  const unmerged = (proposal.swarmTasks ?? []).filter((task) => task.status !== 'merged')
  if (unmerged.length > 0 && options.tasksGate !== false) {
    steps.push({
      step: 'tasks',
      status: 'failed',
      summary: `验收未通过：swarm 任务未合并 —— ${unmerged
        .map((task) => `[${task.id}] ${task.status}`)
        .join('，')}（workmate_swarm_task action=merge，或 force 跳过）`,
    })
    return { ok: false, steps, ...(tasks !== undefined ? { tasks } : {}) }
  }
  if (incomplete.length > 0 && options.tasksGate !== false) {
    steps.push({
      step: 'tasks',
      status: 'failed',
      summary: `验收未通过：${incomplete
        .map((entry) => `[${entry.project}] ${(entry.snapshot as TaskSnapshot).done}/${(entry.snapshot as TaskSnapshot).total}`)
        .join('，')} 仍有未勾选任务（force 可跳过）——全部进度：${progress}`,
    })
    return { ok: false, steps, ...(tasks !== undefined ? { tasks } : {}) }
  }
  if (withTasks.length === 0) {
    steps.push({ step: 'tasks', status: 'skipped', summary: 'tasks.md not readable — no acceptance evidence' })
  } else {
    steps.push({
      step: 'tasks',
      status: 'ok',
      summary: `${incomplete.length > 0 ? '验收谓词被 force 跳过；' : 'tasks 全部完成；'}${progress}`,
    })
    if (tasks === undefined) tasks = withTasks[0]?.snapshot
  }

  // 2. swarm parallel execution (recorded skip until the swarm plugin ships)
  if (tasks !== undefined && deps.runSwarmTasks) {
    try {
      const summary = await deps.runSwarmTasks(tasks, firstRoot)
      steps.push({ step: 'swarm', status: 'ok', summary })
    } catch (error) {
      steps.push({ step: 'swarm', status: 'failed', summary: error instanceof Error ? error.message : String(error) })
      return { ok: false, steps, ...(tasks !== undefined ? { tasks } : {}) }
    }
  } else {
    steps.push({
      step: 'swarm',
      status: 'skipped',
      summary: 'swarm orchestrator not wired — parallel execution pending (design D1)',
    })
  }

  // 3. review gate: every resolvable target must have a review report with
  // no unresolved CRITICAL issue (change add-proposal-quality-gates, design D2).
  // The review INTELLIGENCE lives in the session layer (proposal-auditor);
  // the host only validates the structured artifact. force skips the gate.
  if (options.reviewGate !== false) {
    let gateFailed = false
    for (const target of targets) {
      const label = targets.length > 1 ? `[${target.project}] ` : ''
      let content: string
      try {
        content = await readFile(
          join(target.root, options.openspecRoot, 'changes', proposal.openspecChangeId, 'review.md'),
          'utf8',
        )
      } catch {
        gateFailed = true
        steps.push({
          step: 'review-gate',
          status: 'failed',
          summary: `${label}审查报告缺失 — 在会话中运行 proposal-auditor 生成 review.md（或 force 跳过）`,
        })
        continue
      }
      const report = parseReviewMd(content)
      const tally = reviewTally(report, options.reviewBlockingSeverities ?? ['CRIT'])
      const counts = formatTally(tally)
      const head = `${label}${counts === '' ? '无发现' : counts}`
      const who = tally.reviewer !== undefined ? `${tally.reviewer}${tally.shadow ? '（影子）' : ''}` : undefined
      if (tally.shadow) {
        // Shadow mode (change add-review-tally, design D2): a reviewer still
        // earning trust reports without blocking — the tally is the evidence.
        steps.push({
          step: 'review-gate',
          status: 'ok',
          summary: `${head}；shadow 审查者${who !== undefined ? ` ${who}` : ''} 只记录不阻断`,
        })
      } else if (tally.blocking > 0) {
        gateFailed = true
        steps.push({
          step: 'review-gate',
          status: 'failed',
          summary: `${label}${tally.blocking} 条未解决阻断级发现（${head}）— ${tally.blockingFindings
            .map((finding) => finding.text.slice(0, 40))
            .join(' / ')}`,
        })
      } else {
        steps.push({
          step: 'review-gate',
          status: 'ok',
          summary: `${head}；审查通过${who !== undefined ? `（${who}）` : ''}`,
        })
      }
    }
    if (gateFailed) return { ok: false, steps, ...(tasks !== undefined ? { tasks } : {}) }
  } else {
    steps.push({ step: 'review-gate', status: 'skipped', summary: 'disabled by force' })
  }

  // 4+5. per-project openspec archive + gitnexus re-index
  let allArchived = true
  for (const target of targets) {
    const label = targets.length > 1 ? `[${target.project}] ` : ''
    try {
      const output = await execCli(
        openspecBin,
        ['archive', proposal.openspecChangeId, '--yes'],
        target.root,
        60_000,
        options.signal,
      )
      steps.push({
        step: 'openspec-archive',
        status: 'ok',
        summary: `${label}${output.trim().split('\n').slice(-2).join(' / ')}`,
      })
    } catch (error) {
      // Retry semantics: a previous partial run may have already archived this
      // project — the CLI then fails with "not found". Archived state means
      // the step's goal is already met: record a skip, not a failure.
      const state = await readChangeState(target.root, options.openspecRoot, proposal.openspecChangeId)
      if (state.state === 'archived') {
        steps.push({
          step: 'openspec-archive',
          status: 'skipped',
          summary: `${label}already archived in a previous run`,
        })
      } else {
        allArchived = false
        steps.push({
          step: 'openspec-archive',
          status: 'failed',
          summary: `${label}${error instanceof Error ? error.message : String(error)}`,
        })
        continue
      }
    }
    if (options.gitnexusAnalyzeEnabled !== false) {
      const result = await gitnexusAnalyze(target.root, { force: true }, options.signal)
      steps.push(
        result.note === undefined
          ? { step: 'gitnexus-analyze', status: 'ok', summary: `${label}${result.output.split('\n').slice(-2).join(' / ')}` }
          : { step: 'gitnexus-analyze', status: 'skipped', summary: `${label}${result.note}` },
      )
    } else {
      steps.push({ step: 'gitnexus-analyze', status: 'skipped', summary: 'disabled by config' })
    }
  }
  if (!allArchived) return { ok: false, steps, ...(tasks !== undefined ? { tasks } : {}) }

  // 6. delivery manifest (design D4) — every probe is best-effort: a project
  // that is not a git repo still archives, it just has less to say.
  const manifest = await collectManifest(proposal, targets, options, steps)

  // 7. status
  steps.push({ step: 'status', status: 'ok', summary: `proposal ${proposal.id} → archived` })
  return {
    ok: true,
    steps,
    manifest,
    ...(tasks !== undefined ? { tasks } : {}),
  }
}

/** Short hashes carrying the proposal marker (`$ git log --grep '[proposal:<id>]'`). */
async function markedCommits(root: string, proposalId: string, signal?: AbortSignal): Promise<string[]> {
  const output = await execCli(
    'git',
    ['log', '--fixed-strings', '--grep', `[proposal:${proposalId}]`, '--format=%h', '-n', '50'],
    root,
    20_000,
    signal,
  )
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/** `git diff --stat` between the oldest and newest marked commit (single → `git show`). */
async function diffStatFor(root: string, commits: readonly string[], signal?: AbortSignal): Promise<string> {
  if (commits.length === 0) throw new Error('no marked commits')
  const newest = commits[0] as string
  const oldest = commits[commits.length - 1] as string
  const args =
    commits.length >= 2 ? ['diff', '--stat', `${oldest}..${newest}`] : ['show', '--stat', '--format=', newest]
  const output = await execCli('git', args, root, 20_000, signal)
  const trimmed = output.trim()
  return trimmed.split('\n').slice(-1)[0] ?? trimmed
}

/** The archived change directory for this proposal, when it can be located. */
async function findArchivedDir(root: string, openspecRoot: string, changeId: string): Promise<string | undefined> {
  const archiveRoot = join(validateProjectRoot(root), openspecRoot, 'changes', 'archive')
  try {
    const entries = await readdir(archiveRoot)
    const match = entries.find((entry) => entry === changeId || entry.endsWith(`-${changeId}`))
    return match === undefined ? undefined : join(archiveRoot, match)
  } catch {
    return undefined
  }
}

/** Best-effort per-project delivery summary (design D4). */
async function collectManifest(
  proposal: Proposal,
  targets: readonly OrchestrationTarget[],
  options: OrchestrateOptions,
  steps: readonly OrchestrationStep[],
): Promise<ArchiveManifest> {
  const projects: ArchiveManifestEntry[] = []
  for (const target of targets) {
    const entry: ArchiveManifestEntry = { project: target.project, root: target.root, commits: [], reindexed: false }
    try {
      const commits = await markedCommits(target.root, proposal.id, options.signal)
      entry.commits = commits
      if (commits.length > 0) entry.diffStat = await diffStatFor(target.root, commits, options.signal)
    } catch (error) {
      entry.note = `git probes unavailable: ${error instanceof Error ? error.message : String(error)}`
    }
    const archivedDir = await findArchivedDir(target.root, options.openspecRoot, proposal.openspecChangeId)
    if (archivedDir !== undefined) {
      entry.archivedChangeDir = archivedDir
      try {
        entry.specsUpdated = (await readdir(join(archivedDir, 'specs'))).length > 0
      } catch {
        entry.specsUpdated = false
      }
    }
    entry.reindexed = steps.some(
      (step) => step.step === 'gitnexus-analyze' && step.status === 'ok' && step.summary.startsWith(`[${target.project}]`),
    ) || steps.some((step) => step.step === 'gitnexus-analyze' && step.status === 'ok' && targets.length === 1)
    projects.push(entry)
  }
  return { at: new Date().toISOString(), projects }
}

/**
 * Reverse orchestration for reopen: move each project's archived change dir
 * back under changes/. Failures are recorded per project and never block the
 * state rollback (the proposal's `archived` stamp is the least valuable
 * thing to lose).
 */
export async function orchestrateReopen(
  proposal: Proposal,
  targets: OrchestrationTarget[],
  options: { openspecRoot: string; signal?: AbortSignal },
): Promise<OrchestrationResult> {
  const steps: OrchestrationStep[] = []
  // Only filesystem renames here — an aborted caller still gets its state
  // rollback (the status field must never depend on directory housekeeping).
  if (options.signal?.aborted === true) {
    steps.push({ step: 'reopen-dir', status: 'skipped', summary: 'aborted by caller — state rollback only' })
    return { ok: true, steps }
  }
  if (targets.length === 0) {
    steps.push({ step: 'reopen-dir', status: 'skipped', summary: 'no resolvable project roots — state rollback only' })
  }
  for (const target of targets) {
    const result = await revertArchiveDir(target.root, options.openspecRoot, proposal.openspecChangeId)
    steps.push({
      step: 'reopen-dir',
      status: result.moved ? 'ok' : 'skipped',
      summary: `[${target.project}] ${result.summary}`,
    })
  }
  steps.push({ step: 'status', status: 'ok', summary: `proposal ${proposal.id} → executing` })
  return { ok: true, steps }
}
