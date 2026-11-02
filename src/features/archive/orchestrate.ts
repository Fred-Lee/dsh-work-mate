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
import { checkCitations, fileSystemProbe, formatCitationReport } from '../quality/citations.ts'
import { judgeReviewerIndependence, type Identity } from '../quality/reviewer-independence.ts'
import type { Proposal } from '../proposal/store.ts'
import type { ArchiveManifest, ArchiveManifestEntry } from './manifest.ts'
import { collectArtifactLedger, computeDrift, declaredScopes } from '../proposal/artifacts.ts'
import type { DecisionOutcome, DecisionQuestion } from '../decision/types.ts'

export interface OrchestrationStep {
  step:
    | 'review-gate'
    | 'team-review'
    | 'team-review-evidence'
    | 'team-test-evidence'
    | 'review-independent'
    | 'review-evidence'
    | 'tasks'
    | 'plan-drift'
    | 'swarm'
    | 'openspec-archive'
    | 'gitnexus-analyze'
    | 'reopen-dir'
    | 'worktree-cleanup'
    | 'vault-export'
    | 'status'
  /**
   * `warn` is a step that succeeded but surfaced something worth reading (an
   * untouched declaration, a tolerated out-of-range citation). It never blocks:
   * only `failed` does, and every consumer keys on `failed`.
   */
  status: 'ok' | 'skipped' | 'failed' | 'warn'
  summary: string
}

export interface OrchestrationTarget {
  project: string
  root: string
}

export interface OrchestrationResult {
  ok: boolean
  steps: OrchestrationStep[]
  /**
   * True when a gate was explicitly skipped by `force` (`reviewGate: false` / `tasksGate: false`).
   * Reported so "编排自报失败" and "归档已完成" can never be silently contradicted.
   */
  forced?: boolean
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

/**
 * Grade untagged review findings (change `add-decision-nodes`, design D2): a
 * question/suggestion in review.md is a discovery whose severity nobody wrote down.
 * Only an `act` judgement becomes a finding — `review`/`abstain` mean "not decided",
 * and inventing a severity there would block archiving on a guess.
 */
export async function gradeUntaggedFindings(
  report: { questions: string[]; suggestions: string[] },
  decide: DecideHook,
  max: number,
  signal?: AbortSignal,
): Promise<import('../quality/review-parser.ts').ReviewFinding[]> {
  const items = [...report.questions, ...report.suggestions].slice(0, Math.max(0, max))
  const graded: import('../quality/review-parser.ts').ReviewFinding[] = []
  for (const [index, item] of items.entries()) {
    const outcome = await decide(
      {
        node: 'review-severity',
        state: item,
        question: '这条审查发现的严重度是？',
        options: ['CRIT', 'HIGH', 'MED', 'LOW'],
      },
      signal,
    )
    if (outcome?.action !== 'act' || outcome.choice === undefined) continue
    if (!['CRIT', 'HIGH', 'MED', 'LOW'].includes(outcome.choice)) continue
    graded.push({
      severity: outcome.choice as 'CRIT' | 'HIGH' | 'MED' | 'LOW',
      tag: `JUDGED-${index + 1}`,
      text: item,
      resolved: false,
    })
  }
  return graded
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

/** Judgement hook (change `add-decision-nodes`); omitted = layer disabled. */
export type DecideHook = (question: DecisionQuestion, signal?: AbortSignal) => Promise<DecisionOutcome | undefined>

export interface OrchestrateDeps {
  /** Judgement layer hook; omitted when the layer is disabled. */
  decide?: DecideHook
  /** `openspec` CLI binary; overridable in tests. */
  openspecBin?: string
  runSwarmTasks?(tasks: TaskSnapshot, projectRoot: string): Promise<string>
}

export interface OrchestrateOptions {
  openspecRoot: string
  /**
   * Called once the proposal reached `archived` (change `auto-export-vault`).
   * Best-effort: a failing hook is recorded as a step, never fails the archive itself.
   */
  onArchived?: (proposal: Proposal, targets: OrchestrationTarget[]) => Promise<string | undefined>
  gitnexusAnalyzeEnabled?: boolean
  reviewGate?: boolean
  /**
   * Acceptance predicate (change `adopt-workdsh-lessons`, design D3): every
   * associated project's tasks.md must be fully checked. `force` passes false.
   * @default true
   */
  tasksGate?: boolean
  /**
   * Fail the archive when the diff contains files the plan never declared
   * (`Config.planDriftGate`). @default false
   */
  planDriftGate?: boolean
  /**
   * Severities whose open findings block archiving (`Config.reviewBlockingSeverities`).
   * @default ['CRIT']
   */
  reviewBlockingSeverities?: string[]
  /**
   * Reviewer independence (`Config.reviewerIndependence`, change `harden-archive-gates`).
   * `block` fails on `missing` / `same-as-author`; `undetermined` (no git facts) only warns.
   * @default 'off' — the host passes the configured value.
   */
  reviewerIndependence?: 'off' | 'warn' | 'block'
  /**
   * Citation probe mode (`Config.reviewEvidenceGate`). `block` fails on a missing file;
   * an out-of-range line only warns. @default 'off'
   */
  reviewEvidenceGate?: 'off' | 'warn' | 'block'
  /**
   * Block archiving while a merged swarm task lacks an independent verification
   * record (change `wire-swarm-independent-review`). @default false
   */
  swarmReviewRequired?: boolean
  /** Identities of this proposal's executors, collected by the caller (git authors). */
  executorIdentities?: readonly Identity[]
  /** How many untagged findings one run may grade (`Config.reviewGradeMax`). @default 5 */
  reviewGradeMax?: number
  /** Block archiving on a judged-unsatisfied task (`Config.taskJudgementGate`). @default false */
  taskJudgementGate?: boolean
  /** Caller cancellation, forwarded to every spawned CLI. */
  signal?: AbortSignal
}

/**
 * A change directory may already have moved into `changes/archive/<date>-<id>/` — after a
 * previous archive attempt, or when the run is re-checked. Both the tasks gate and the review
 * gate read evidence from this directory, so resolve it instead of assuming the active path.
 */
export async function resolveChangeDir(root: string, openspecRoot: string, changeId: string): Promise<string> {
  const projectRoot = validateProjectRoot(root)
  const active = join(projectRoot, openspecRoot, 'changes', changeId)
  const exists = await readdir(active).then(() => true).catch(() => false)
  if (exists) return active
  const archiveDir = join(projectRoot, openspecRoot, 'changes', 'archive')
  const entries = await readdir(archiveDir).catch(() => [] as string[])
  const archived = entries.filter((entry) => entry === changeId || entry.endsWith(`-${changeId}`)).sort().pop()
  return archived === undefined ? active : join(archiveDir, archived)
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
      const changeDir = await resolveChangeDir(target.root, options.openspecRoot, proposal.openspecChangeId)
      const content = await readFile(join(changeDir, 'tasks.md'), 'utf8')
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
  // Task judgement (change `add-decision-nodes`): computed once, then reused by the
  // manifest so the gate and the delivery record never disagree.
  const taskJudgements = await judgeTasks(proposal, targets, options, deps.decide)
  if (options.taskJudgementGate === true) {
    const unsatisfied = taskJudgements.filter((entry) => entry.verdict === 'unsatisfied')
    if (unsatisfied.length > 0) {
      steps.push({
        step: 'tasks',
        status: 'failed',
        summary: `任务判定未通过：${unsatisfied
          .map((entry) => `[${entry.project}] ${entry.task.slice(0, 40)}`)
          .join('，')}（判断层认为 diff 未满足该任务；补实现、改任务描述，或 force 跳过）`,
      })
      return { ok: false, steps, ...(tasks !== undefined ? { tasks } : {}) }
    }
  }

  if (options.planDriftGate === true) {
    const undeclared: string[] = []
    const untouched: string[] = []
    for (const target of targets) {
      const drift = await collectProjectDrift(proposal, target, options)
      for (const file of drift?.undeclared ?? []) undeclared.push(`[${target.project}] ${file}`)
      for (const scope of drift?.missing ?? []) untouched.push(`[${target.project}] ${scope}`)
    }
    if (undeclared.length > 0) {
      steps.push({
        step: 'plan-drift',
        status: 'failed',
        summary: `计划漂移：${undeclared.length} 个改动未在 writes/files 里声明 —— ${undeclared
          .slice(0, 8)
          .join('，')}（补声明，或 force 跳过）`,
      })
      return { ok: false, steps, ...(tasks !== undefined ? { tasks } : {}) }
    }
    // The opposite direction ("declared but never touched") is NOT blocked: a plan
    // can legitimately declare a scope and then cover it by a different route (a
    // rename, a shared module). But it must not be invisible either — before this
    // step existed, an untouched declaration left no trace in the archive record.
    if (untouched.length > 0) {
      steps.push({
        step: 'plan-drift',
        status: 'warn',
        summary: `计划里有 ${untouched.length} 处声明的范围没有任何改动落在其上 —— ${untouched
          .slice(0, 8)
          .join('，')}（计划写多了，或改在了别处；不阻断，但值得看一眼）`,
      })
    }
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

  // 2. swarm: REPORT, never dispatch. Design D1 keeps task execution with the caller
  // (subagents / Agent Teams); workmate owns the git isolation and merge discipline. So the
  // step states what this proposal actually used instead of a vague "not wired".
  const swarmTasks = proposal.swarmTasks ?? []
  const swarmMerged = swarmTasks.filter((task) => task.status === 'merged')
  const swarmPending = swarmTasks.filter((task) => task.status !== 'merged')
  if (tasks !== undefined && deps.runSwarmTasks !== undefined) {
    try {
      const summary = await deps.runSwarmTasks(tasks, firstRoot)
      steps.push({ step: 'swarm', status: 'ok', summary })
    } catch (error) {
      steps.push({ step: 'swarm', status: 'failed', summary: error instanceof Error ? error.message : String(error) })
      return { ok: false, steps, ...(tasks !== undefined ? { tasks } : {}) }
    }
  } else if (swarmTasks.length === 0) {
    steps.push({
      step: 'swarm',
      status: 'ok',
      summary: '无 swarm 任务（本提案未使用任务级并行；派发执行由调用方/Agent Teams 决定，见设计 D1）',
    })
  } else if (swarmPending.length === 0) {
    // Merged is not checked (change `wire-swarm-independent-review`): with
    // `swarmReviewRequired` on, each merged task needs a verification record whose
    // checker is independent of that task's commit authors. Without it the merged
    // claim alone passes — the same "self-report" hole the review gate had.
    // `undetermined` blocks too (design D3): in this scenario it means the git facts are
    // unreachable — a misconfiguration — so treating it as "no verdict" would let the
    // gate fail silently instead of loudly. This mirrors specs/swarm-verification.
    const unverified = options.swarmReviewRequired === true
      ? swarmMerged.filter(
          (task) =>
            task.verification === undefined ||
            task.verification.independence === 'same-as-author' ||
            task.verification.independence === 'undetermined',
        )
      : []
    if (unverified.length > 0) {
      steps.push({
        step: 'swarm',
        status: 'failed',
        summary:
          `${swarmMerged.length} 个 swarm 任务已合并，但 ${unverified.length} 个没有独立核验记录：` +
          unverified
            .map((task) => {
              if (task.verification === undefined) return `${task.id}(未核验)`
              if (task.verification.independence === 'undetermined') {
                return `${task.id}(核验者 ${task.verification.reviewer} 的独立性无法判定：取不到仓库作者事实)`
              }
              return `${task.id}(核验者 ${task.verification.reviewer} 与提交作者同一身份)`
            })
            .join('，') +
          '——先 workmate_swarm_task action=verify，或把 Config.swarmReviewRequired 关掉',
      })
      return { ok: false, steps, ...(tasks !== undefined ? { tasks } : {}) }
    }
    steps.push({
      step: 'swarm',
      status: 'ok',
      summary: `${swarmMerged.length} 个 swarm 任务全部已合并` +
        `${swarmMerged.filter((task) => task.branch !== undefined).length > 0
          ? `（分支：${swarmMerged.map((task) => task.branch ?? task.id).join(', ')}）`
          : ''}` +
        `${swarmMerged.filter((task) => task.verification !== undefined).length > 0
          ? `；其中 ${swarmMerged.filter((task) => task.verification !== undefined).length} 个有独立核验记录`
          : ''}`,
    })
  } else {
    steps.push({
      step: 'swarm',
      status: 'skipped',
      summary: `swarm 任务未全部合并，本次按 force 放行：${swarmPending
        .map((task) => `${task.id}(${task.status}${task.branch !== undefined ? `, ${task.branch}` : ''})`)
        .join('，')}——正常路径应为 workmate_swarm_task action=merge`,
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
      let content: string | undefined
      let teamContent: string | undefined
      let testContent: string | undefined
      try {
        const changeDir = await resolveChangeDir(target.root, options.openspecRoot, proposal.openspecChangeId)
        content = await readFile(join(changeDir, 'review.md'), 'utf8').catch(() => undefined)
        // 任务制变更用大写工件 `TEAM-REVIEW.md`；macOS 大小写不敏感，所以它不能和
        // 规划期的小写 `review.md` 同名（C2）。
        teamContent = await readFile(join(changeDir, 'TEAM-REVIEW.md'), 'utf8').catch(() => undefined)
        testContent = await readFile(join(changeDir, 'TEST.md'), 'utf8').catch(() => undefined)
        if (content === undefined && teamContent !== undefined) content = teamContent
      } catch {
        // unresolved change dir
      }
      if (content === undefined) {
        gateFailed = true
        steps.push({
          step: 'review-gate',
          status: 'failed',
          summary:
            `${label}审查报告缺失 — 在会话中运行 proposal-auditor 生成 review.md（或 force 跳过）` +
            `；本次 reviewGate=on`,
        })
        continue
      }
      const report = parseReviewMd(content)
      if (teamContent !== undefined) {
        const teamReport = parseReviewMd(teamContent)
        const teamTally = reviewTally(teamReport, options.reviewBlockingSeverities ?? ['CRIT'])
        if (teamTally.blocking > 0) {
          gateFailed = true
          steps.push({
            step: 'team-review',
            status: 'failed',
            summary: `${label}TEAM-REVIEW.md 有 ${teamTally.blocking} 条未解决阻断级发现`,
          })
        } else {
          steps.push({ step: 'team-review', status: 'ok', summary: `${label}TEAM-REVIEW.md 无阻断级发现` })
        }
        if (options.reviewEvidenceGate !== undefined && options.reviewEvidenceGate !== 'off') {
          const probe = fileSystemProbe(target.root)
          for (const [step, name, text] of [
            ['team-review-evidence', 'TEAM-REVIEW.md', teamContent],
            ['team-test-evidence', 'TEST.md', testContent],
          ] as const) {
            if (text === undefined) continue
            const citations = await checkCitations(text, probe)
            const missing = citations.byVerdict['file-missing']
            const block = options.reviewEvidenceGate === 'block' && missing > 0
            if (block) gateFailed = true
            steps.push({
              step,
              status: block ? 'failed' : missing > 0 || citations.byVerdict['line-out-of-range'] > 0 ? 'skipped' : 'ok',
              summary: `${label}${name} ${formatCitationReport(citations)}${block ? ' —— reviewEvidenceGate=block，归档被阻断' : ''}`,
            })
          }
        }
      }
      const graded =
        deps.decide === undefined
          ? []
          : await gradeUntaggedFindings(report, deps.decide, options.reviewGradeMax ?? 5, options.signal)
      // Reviewer independence + citation probe (change `harden-archive-gates`).
      // Both run per target: a report without a verifiable checker or with citations
      // that do not resolve is not evidence, and the gate must say so — in `block`
      // mode it fails, in `warn` mode it records the fact and lets the run continue.
      if (options.reviewerIndependence !== undefined && options.reviewerIndependence !== 'off') {
        const executors =
          options.executorIdentities ?? (await collectExecutorIdentities(target.root, proposal.id, options.signal))
        const verdict = judgeReviewerIndependence({
          ...(report.reviewer.reviewer !== undefined ? { reviewer: report.reviewer.reviewer } : {}),
          shadow: report.reviewer.shadow,
          executors,
        })
        const blockingVerdict = verdict.verdict === 'missing' || verdict.verdict === 'same-as-author'
        const block = options.reviewerIndependence === 'block' && blockingVerdict
        if (block) gateFailed = true
        steps.push({
          step: 'review-independent',
          status: block ? 'failed' : verdict.verdict === 'independent' ? 'ok' : 'skipped',
          summary: `${label}${verdict.note}${block ? ' —— reviewerIndependence=block，归档被阻断' : ''}`,
        })
      }
      if (options.reviewEvidenceGate !== undefined && options.reviewEvidenceGate !== 'off') {
        const probe = fileSystemProbe(target.root)
        const citations = await checkCitations(content, probe)
        const missing = citations.byVerdict['file-missing']
        const block = options.reviewEvidenceGate === 'block' && missing > 0
        if (block) gateFailed = true
        steps.push({
          step: 'review-evidence',
          status: block ? 'failed' : missing > 0 || citations.byVerdict['line-out-of-range'] > 0 ? 'skipped' : 'ok',
          summary: `${label}${formatCitationReport(citations)}${block ? ' —— reviewEvidenceGate=block，归档被阻断' : ''}`,
        })
      }
      const tally = reviewTally(
        { ...report, findings: [...report.findings, ...graded] },
        options.reviewBlockingSeverities ?? ['CRIT'],
      )
      const counts = formatTally(tally)
      const head = `${label}${counts === '' ? '无发现' : counts}${graded.length > 0 ? `（判断层归级 ${graded.length} 条）` : ''}`
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
      // Exit code 0 is NOT proof of success: `openspec archive` exits 0 while
      // printing "Aborted. No files were changed." when the delta specs do not
      // parse, so the pipeline would stamp `archived` on a change directory that
      // never moved. Judge the product fact instead — see the branch below
      // (change `harden-openspec-archive-step`).
      const archived = await readChangeState(target.root, options.openspecRoot, proposal.openspecChangeId)
      if (archived.state === 'archived') {
        steps.push({
          step: 'openspec-archive',
          status: 'ok',
          summary: `${label}${output.trim().split('\n').slice(-2).join(' / ')}`,
        })
      } else {
        allArchived = false
        steps.push({
          step: 'openspec-archive',
          status: 'failed',
          summary: `${label}${output.trim().split('\n').slice(-2).join(' / ')} / changes/${proposal.openspecChangeId}/ 仍在原地 —— 退出码 0 不代表归档完成`,
        })
        continue
      }
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
  const manifest = await collectManifest(proposal, targets, options, steps, taskJudgements)

  // 7. status
  steps.push({ step: 'status', status: 'ok', summary: `proposal ${proposal.id} → archived` })
  // 8. vault 回写（知识面 = 本地 markdown + Obsidian：归档即同步，不必有人记得手动导出）
  if (options.onArchived !== undefined) {
    try {
      const summary = await options.onArchived(proposal, targets)
      steps.push({ step: 'vault-export', status: 'ok', summary: summary ?? 'vault 已更新' })
    } catch (error) {
      steps.push({
        step: 'vault-export',
        status: 'failed',
        summary: `vault 回写失败（不影响归档）：${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  return {
    ok: true,
    steps,
    manifest,
    // A forced run must say so: the panel can then never contradict an `ok:false` result.
    forced: options.reviewGate === false || options.tasksGate === false,
    ...(tasks !== undefined ? { tasks } : {}),
  }
}

/**
 * Distinct author identities of the commits carrying `[proposal:<id>]` — the
 * "executor set" the reviewer-independence verdict compares against (change
 * `harden-archive-gates`, design D2). Best-effort: a non-git root yields `[]`,
 * which makes the verdict `undetermined` rather than a false accusation.
 */
export async function collectExecutorIdentities(root: string, proposalId: string, signal?: AbortSignal): Promise<Identity[]> {
  let output: string
  try {
    output = await execCli(
      'git',
      ['log', '--all', '--fixed-strings', '--grep', `[proposal:${proposalId}]`, '--format=%an%x09%ae'],
      root,
      20_000,
      signal,
    )
  } catch {
    return []
  }
  const byKey = new Map<string, Identity>()
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const [name = '', email = ''] = trimmed.split('\t')
    if (name === '' && email === '') continue
    const key = `${name.toLowerCase()}|${email.toLowerCase()}`
    if (!byKey.has(key)) byKey.set(key, { name, ...(email !== '' ? { email } : {}) })
  }
  return [...byKey.values()]
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

/**
 * Judge whether the merged diff actually satisfies each CHECKED task line
 * (change `add-decision-nodes`, design D3/D5). Capped at three judgements per run:
 * this is a model call, and an archive must not fan out into dozens of them.
 * Only an `act` verdict is recorded; anything else is "not decided".
 */
async function judgeTasks(
  proposal: Proposal,
  targets: readonly OrchestrationTarget[],
  options: OrchestrateOptions,
  decide: DecideHook | undefined,
): Promise<Array<{ project: string; task: string; verdict: string; certainty: number }>> {
  if (decide === undefined) return []
  const judgements: Array<{ project: string; task: string; verdict: string; certainty: number }> = []
  for (const target of targets) {
    let content = ''
    try {
      content = await readFile(
        join(target.root, options.openspecRoot, 'changes', proposal.openspecChangeId, 'tasks.md'),
        'utf8',
      )
    } catch {
      const archived = await findArchivedDir(target.root, options.openspecRoot, proposal.openspecChangeId)
      if (archived !== undefined) {
        content = await readFile(join(archived, 'tasks.md'), 'utf8').catch(() => '')
      }
    }
    const checked = content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^- \[[xX]\] /.test(line))
      .slice(0, 3)
    const drift = await collectProjectDrift(proposal, target, options)
    const files = (drift?.actual ?? []).slice(0, 20).join(', ') || '(无标记提交)'
    for (const task of checked) {
      const outcome = await decide(
        {
          node: 'task-satisfied',
          state: `任务：${task}\n标记提交涉及的文件：${files}`,
          question: '这份 diff 是否真的满足该任务？',
          options: ['satisfied', 'unsatisfied'],
        },
        options.signal,
      )
      if (outcome?.action !== 'act' || outcome.choice === undefined) continue
      judgements.push({ project: target.project, task, verdict: outcome.choice, certainty: outcome.certainty })
    }
  }
  return judgements
}

/**
 * Declared-vs-actual drift for one project (undefined when nothing is comparable).
 * Exported for `workmate_plan_drift`: the same comparison the optional gate uses,
 * available before archiving so the plan or the diff can still be fixed.
 */
export async function collectProjectDrift(
  proposal: Proposal,
  target: OrchestrationTarget,
  options: OrchestrateOptions,
): Promise<ReturnType<typeof computeDrift> | undefined> {
  try {
    const commits = await markedCommits(target.root, proposal.id, options.signal)
    if (commits.length === 0) return undefined
    // The change's own spec directory is the plan, not a deliverable: drift is
    // about what the plan failed to declare, not about the plan itself.
    const changesPrefix = `${options.openspecRoot.replace(/\/+$/, '')}/changes/`
    const actual = (await changedFiles(target.root, commits, options.signal)).filter(
      (path) => !path.startsWith(changesPrefix),
    )
    // Read the declarations from the active change directory, falling back to the
    // archived one: the manifest is collected after the archive step moved it.
    const activeDir = join(target.root, options.openspecRoot, 'changes', proposal.openspecChangeId)
    const archivedDir = await findArchivedDir(target.root, options.openspecRoot, proposal.openspecChangeId)
    const readDeclared = async (name: string): Promise<string> => {
      const active = await readFile(join(activeDir, name), 'utf8').catch(() => undefined)
      if (active !== undefined) return active
      if (archivedDir === undefined) return ''
      return readFile(join(archivedDir, name), 'utf8').catch(() => '')
    }
    const declared = declaredScopes({
      tasksMd: await readDeclared('tasks.md'),
      designMd: await readDeclared('design.md'),
    })
    return computeDrift(declared, actual, { ignoredPrefixes: [changesPrefix] })
  } catch {
    return undefined
  }
}

/**
 * Files a proposal's marked commits touched: the union of each commit's own file
 * list. Using `diff-tree` per commit avoids `<hash>^`, which does not exist for a
 * root commit (a first-commit proposal would otherwise lose its whole diff).
 */
async function changedFiles(root: string, commits: readonly string[], signal?: AbortSignal): Promise<string[]> {
  const files = new Set<string>()
  for (const commit of commits) {
    try {
      const output = await execCli(
        'git',
        // `--root` so a root commit (the only one a fresh repo has) still lists its files.
        ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', commit],
        root,
        20_000,
        signal,
      )
      for (const line of output.split('\n')) {
        const trimmed = line.trim()
        if (trimmed !== '') files.add(trimmed)
      }
    } catch {
      // A commit whose objects are gone (rebased away) contributes nothing.
    }
  }
  return [...files].sort()
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
  taskJudgements: ReadonlyArray<{ project: string; task: string; verdict: string; certainty: number }> = [],
): Promise<ArchiveManifest> {
  const projects: ArchiveManifestEntry[] = []
  for (const target of targets) {
    const entry: ArchiveManifestEntry = { project: target.project, root: target.root, commits: [], reindexed: false }
    try {
      const commits = await markedCommits(target.root, proposal.id, options.signal)
      entry.commits = commits
      if (commits.length > 0) {
        entry.diffStat = await diffStatFor(target.root, commits, options.signal)
        const drift = await collectProjectDrift(proposal, target, options)
        if (drift !== undefined) entry.drift = drift
      }
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
      entry.artifacts = await collectArtifactLedger(archivedDir, {
        ...(entry.commits[0] !== undefined ? { commit: entry.commits[0] } : {}),
      })
    }
    entry.reindexed = steps.some(
      (step) => step.step === 'gitnexus-analyze' && step.status === 'ok' && step.summary.startsWith(`[${target.project}]`),
    ) || steps.some((step) => step.step === 'gitnexus-analyze' && step.status === 'ok' && targets.length === 1)
    const own = taskJudgements.filter((judgement) => judgement.project === target.project)
    if (own.length > 0) entry.taskJudgements = own.map(({ task, verdict, certainty }) => ({ task, verdict, certainty }))
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
