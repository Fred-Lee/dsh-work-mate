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
import { parseReviewMd, unresolvedCriticals } from '../quality/review-parser.ts'
import type { Proposal } from '../proposal/store.ts'

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

function execCli(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr?.trim() || error.message))
      else resolvePromise(stdout)
    })
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
  gitnexusEnabled?: boolean
  runSwarmTasks?(tasks: TaskSnapshot, projectRoot: string): Promise<string>
}

export async function orchestrateArchive(
  proposal: Proposal,
  targets: OrchestrationTarget[],
  options: { openspecRoot: string; gitnexusAnalyzeEnabled?: boolean; reviewGate?: boolean },
  deps: OrchestrateDeps = {},
): Promise<OrchestrationResult> {
  const steps: OrchestrationStep[] = []
  const openspecBin = deps.openspecBin ?? 'openspec'
  if (targets.length === 0) {
    steps.push({ step: 'status', status: 'failed', summary: 'no resolvable project roots — nothing to archive against' })
    return { ok: false, steps }
  }
  const firstRoot = validateProjectRoot(targets[0]!.root)

  // 1. tasks snapshot (first resolvable target)
  let tasks: TaskSnapshot | undefined
  try {
    const content = await readFile(
      join(firstRoot, options.openspecRoot, 'changes', proposal.openspecChangeId, 'tasks.md'),
      'utf8',
    )
    tasks = parseTasksMd(content)
    steps.push({
      step: 'tasks',
      status: 'ok',
      summary: `${tasks.done}/${tasks.total} tasks done at snapshot`,
    })
  } catch {
    steps.push({ step: 'tasks', status: 'skipped', summary: 'tasks.md not readable — no snapshot' })
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
      const unresolved = unresolvedCriticals(report)
      if (unresolved.length > 0) {
        gateFailed = true
        steps.push({
          step: 'review-gate',
          status: 'failed',
          summary: `${label}${unresolved.length} 个未解决 CRITICAL — ${unresolved.map((issue) => issue.text.slice(0, 40)).join(' / ')}`,
        })
      } else {
        steps.push({ step: 'review-gate', status: 'ok', summary: `${label}审查通过（${report.criticals.length} 项 CRITICAL 已解决）` })
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
      const output = await execCli(openspecBin, ['archive', proposal.openspecChangeId, '--yes'], target.root, 60_000)
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
      const result = await gitnexusAnalyze(target.root, { force: true })
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

  // 5. status
  steps.push({ step: 'status', status: 'ok', summary: `proposal ${proposal.id} → archived` })
  return { ok: true, steps, ...(tasks !== undefined ? { tasks } : {}) }
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
  options: { openspecRoot: string },
): Promise<OrchestrationResult> {
  const steps: OrchestrationStep[] = []
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
