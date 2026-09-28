/**
 * Archive orchestration (M4): the five-step pipeline from the design doc —
 *   tasks snapshot → (swarm parallel run, D1: recorded skip) →
 *   openspec archive --yes → gitnexus analyze --force → status = archived.
 *
 * Failure semantics (D2): any CLI failure halts the pipeline, leaves the
 * proposal untouched and returns the step log for the caller to inspect.
 * Every step is idempotent, so archive can simply be retried.
 */
import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { validateProjectRoot } from '../proposal/openspec.ts'
import { gitnexusAnalyze } from '../knowledge-bridge/gitnexus.ts'
import type { Proposal } from '../proposal/store.ts'

export interface OrchestrationStep {
  step: 'tasks' | 'swarm' | 'openspec-archive' | 'gitnexus-analyze' | 'status'
  status: 'ok' | 'skipped' | 'failed'
  summary: string
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

export interface OrchestrateDeps {
  /** `openspec` CLI binary; overridable in tests. */
  openspecBin?: string
  gitnexusEnabled?: boolean
  runSwarmTasks?(tasks: TaskSnapshot, projectRoot: string): Promise<string>
}

export async function orchestrateArchive(
  proposal: Proposal,
  projectRoot: string,
  options: { openspecRoot: string; gitnexusAnalyzeEnabled?: boolean },
  deps: OrchestrateDeps = {},
): Promise<OrchestrationResult> {
  const root = validateProjectRoot(projectRoot)
  const steps: OrchestrationStep[] = []
  const openspecBin = deps.openspecBin ?? 'openspec'
  const changeDir = join(root, options.openspecRoot, 'changes', proposal.openspecChangeId)

  // 1. tasks snapshot
  let tasks: TaskSnapshot | undefined
  try {
    const content = await readFile(join(changeDir, 'tasks.md'), 'utf8')
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
      const summary = await deps.runSwarmTasks(tasks, root)
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

  // 3. openspec archive
  try {
    const output = await execCli(openspecBin, ['archive', proposal.openspecChangeId, '--yes'], root, 60_000)
    steps.push({ step: 'openspec-archive', status: 'ok', summary: output.trim().split('\n').slice(-3).join(' / ') })
  } catch (error) {
    steps.push({
      step: 'openspec-archive',
      status: 'failed',
      summary: error instanceof Error ? error.message : String(error),
    })
    return { ok: false, steps, ...(tasks !== undefined ? { tasks } : {}) }
  }

  // 4. gitnexus analyze
  if (options.gitnexusAnalyzeEnabled !== false) {
    const result = await gitnexusAnalyze(root, { force: true })
    steps.push(
      result.note === undefined
        ? { step: 'gitnexus-analyze', status: 'ok', summary: result.output.split('\n').slice(-3).join(' / ') }
        : { step: 'gitnexus-analyze', status: 'skipped', summary: result.note },
    )
  } else {
    steps.push({ step: 'gitnexus-analyze', status: 'skipped', summary: 'disabled by config' })
  }

  // 5. status
  steps.push({ step: 'status', status: 'ok', summary: `proposal ${proposal.id} → archived` })
  return { ok: true, steps, ...(tasks !== undefined ? { tasks } : {}) }
}
