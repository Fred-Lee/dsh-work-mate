/**
 * Real-git merge-conflict semantics E2E (spec merge-conflict-resolution).
 *
 * Drives OrchestratorCore against a REAL WorktreeService on a throwaway git
 * base repo, with adapters that edit their worktrees like agents would. This
 * exercises the actual `git apply` / `git apply --check` path:
 *
 *  - disjoint multi-agent edits to the SAME file default-merge (no conflict);
 *  - overlapping edits are flagged ONLY because the combined patch fails to
 *    apply, and a headless merge aborts wholesale with the base repo untouched;
 *  - an adjudicated merge (resolutions) applies exactly the chosen agent plan.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrchestratorCore } from './core.ts'
import type { AgentAdapter, AgentExecuteResult } from './types.ts'
import { WorktreeService } from '../../worktree/src/service.ts'

const BASE_LINES = ['line1', 'line2', 'line3', 'line4', 'line5', 'line6', 'line7', 'line8', 'line9', 'line10']

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

/** Replaces a 1-based line index with a new value and returns file text. */
function replaceLine(lines: string[], index1: number, value: string): string {
  const copy = [...lines]
  copy[index1 - 1] = value
  return copy.join('\n')
}

function makeEditor(agent: 'claude' | 'codex', line: number): AgentAdapter {
  return {
    name: agent,
    checkInstalled: async () => ({ installed: true, version: '1.0' }),
    execute: async (req): Promise<AgentExecuteResult> => {
      const target = join(req.worktreePath, 'shared.txt')
      writeFileSync(target, replaceLine(BASE_LINES, line, `${agent}-edit`), 'utf8')
      return { exitCode: 0, stdout: 'done', stderr: '', timedOut: false }
    },
  }
}

/** Edits at different regions — a clean combined patch. */
function disjointEditors(): AgentAdapter[] {
  return [makeEditor('claude', 2), makeEditor('codex', 9)]
}

/** Both edit the SAME original line with different content — real conflict. */
function overlappingEditors(): AgentAdapter[] {
  return [makeEditor('claude', 2), makeEditor('codex', 2)]
}

const dirs: string[] = []

function setupRepo(): { baseRepo: string; rootDir: string } {
  const base = mkdtempSync(join(tmpdir(), 'helm-merge-e2e-'))
  dirs.push(base)
  const baseRepo = join(base, 'repo')
  const rootDir = join(base, 'worktrees')
  mkdirSync(baseRepo, { recursive: true })
  mkdirSync(rootDir, { recursive: true })
  git(baseRepo, 'init', '-q', '--initial-branch', 'main')
  git(baseRepo, 'config', 'user.email', 't@t.t')
  git(baseRepo, 'config', 'user.name', 't')
  writeFileSync(join(baseRepo, 'shared.txt'), BASE_LINES.join('\n'), 'utf8')
  git(baseRepo, 'add', '.')
  git(baseRepo, 'commit', '-qm', 'base')
  return { baseRepo, rootDir }
}

async function runAndMerge(
  agents: AgentAdapter[],
  merge: (core: OrchestratorCore, taskId: string) => Promise<ReturnType<OrchestratorCore['mergeTask']>>,
): Promise<{ core: OrchestratorCore; taskId: string; result: Awaited<ReturnType<OrchestratorCore['mergeTask']>> }> {
  const { baseRepo, rootDir } = setupRepo()
  const svc = new WorktreeService({ rootDir })
  const core = new OrchestratorCore({ worktree: svc, delay: async () => undefined })
  for (const a of agents) core.registerAdapter(a)
  const { taskId } = await core.runParallelTask({ prompt: 'edit shared.txt', agents: agents.map((a) => a.name), repoPath: baseRepo })
  await core.waitForTask(taskId)
  const task = core.getTaskStatus(taskId)!
  expect(task.status).toBe('COMPLETED')
  expect(task.agents).toBeDefined()
  const result = await merge(core, taskId)
  return { core, taskId, result }
}

describe('real-git conflict semantics (merge-conflict-resolution spec)', () => {
  beforeAll(() => {
    // git must be available for these tests to be meaningful.
    try {
      execFileSync('git', ['--version'])
    } catch {
      throw new Error('git is required for the real-git merge E2E tests')
    }
  })
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
    dirs.length = 0
  })

  it('disjoint multi-agent edits to the SAME file default-merge without a conflict', async () => {
    const { result } = await runAndMerge(disjointEditors(), (core, taskId) => core.mergeTask({ taskId }))
    expect(result.results.map((r) => r.ok)).toEqual([true, true])
    expect(result.results.flatMap((r) => r.conflictFiles)).toEqual([])
  })

  it('an overlapping edit fails the combined patch; headless merge aborts with base untouched', async () => {
    let baseRepo = ''
    const { result, core, taskId } = await runAndMerge(overlappingEditors(), (c, id) => {
      const svc = c.getTaskStatus(id)!
      baseRepo = svc.repoPath!
      return c.mergeTask({ taskId: id, source: 'tool' })
    })
    expect(result.results.every((r) => r.ok === false)).toBe(true)
    expect(result.results[0]!.conflictFiles).toEqual(['shared.txt'])
    // Base repo content is byte-for-byte the original → zero changes.
    expect(readFileSync(join(baseRepo, 'shared.txt'), 'utf8')).toBe(BASE_LINES.join('\n'))
    const commits = execFileSync('git', ['-C', baseRepo, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim()
    expect(commits).toBe('1')
    void core
  })

  it('an adjudicated merge applies exactly the chosen agent plan', async () => {
    let baseRepo = ''
    const { result, core, taskId } = await runAndMerge(overlappingEditors(), (c, id) => {
      const svc = c.getTaskStatus(id)!
      baseRepo = svc.repoPath!
      return c.mergeTask({
        taskId: id,
        source: 'tool',
        resolutions: { 'shared.txt': { kind: 'agent', agent: 'claude' } },
      })
    })
    expect(result.results.every((r) => r.ok === true)).toBe(true)
    const content = readFileSync(join(baseRepo, 'shared.txt'), 'utf8')
    expect(content).toContain('claude-edit')
    expect(content).not.toContain('codex-edit')
    // merge-decision event persisted to the durable run timeline
    const page = await core.history.eventsAfter(taskId, 0)
    const mergeEvent = page.events.find((e) => e.kind === 'merge-decision')
    expect(mergeEvent).toBeDefined()
    expect((mergeEvent?.payload as { resolutions: unknown }).resolutions).toEqual({
      'shared.txt': { kind: 'agent', agent: 'claude' },
    })
  })

  it('the audit journal records the merge decision and the adjudication payload', async () => {
    let baseRepo = ''
    const journalDir = mkdtempSync(join(tmpdir(), 'helm-audit-'))
    dirs.push(journalDir)
    void baseRepo
    const { baseRepo: repo, rootDir } = setupRepo()
    const svc = new WorktreeService({ rootDir })
    const { JsonlAuditJournal } = await import('./audit/journal.ts')
    const journal = new JsonlAuditJournal(join(journalDir, 'audit.jsonl'))
    const core = new OrchestratorCore({ worktree: svc, delay: async () => undefined, journal })
    const agents = overlappingEditors()
    for (const a of agents) core.registerAdapter(a)
    const { taskId } = await core.runParallelTask({ prompt: 'edit', agents: agents.map((a) => a.name), repoPath: repo })
    await core.waitForTask(taskId)
    const decision = await core.mergeTask({
      taskId,
      source: 'tool',
      resolutions: { 'shared.txt': { kind: 'manual' } },
    })
    expect(decision.results.every((r) => r.ok === true)).toBe(true)
    const entries = await journal.query({ taskId })
    const mergeCompletion = entries.find((e) => e.type === 'run-completion' && e.operation === 'merge')
    const detail = mergeCompletion?.detail as { resolutions?: unknown } | undefined
    expect(detail?.resolutions).toEqual({ 'shared.txt': { kind: 'manual' } })
    expect(existsSync(join(journalDir, 'audit.jsonl'))).toBe(true)
  })
})
