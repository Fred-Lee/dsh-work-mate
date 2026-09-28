/**
 * OpenSpec change-directory generation: `workmate_proposal_create` seeds the
 * standard three-file layout under `<projectRoot>/<openspecRoot>/changes/<id>/`.
 *
 * Discipline: existing directories are NEVER touched (the proposal author or a
 * previous run may have real content there), and `projectRoot` is validated
 * before anything touches the filesystem.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'

export interface GenerateChangeDirResult {
  status: 'created' | 'existing' | 'skipped'
  dir?: string
  note?: string
}

/** Rejects relative paths and anything containing `..` segments. */
export function validateProjectRoot(projectRoot: string): string {
  if (!projectRoot.startsWith(sep)) {
    throw new Error(`projectRoot must be an absolute path: ${projectRoot}`)
  }
  // Check the raw path first: resolve() would already collapse `/a/../b`.
  if (projectRoot.split(sep).includes('..')) {
    throw new Error(`projectRoot must not traverse upward: ${projectRoot}`)
  }
  return resolve(projectRoot)
}

function proposalTemplate(id: string, title: string): string {
  return [
    `# ${title}`,
    '',
    '## Why',
    '',
    `<!-- 为什么做这个变更（提案 ${id} 由 WorkMate 创建） -->`,
    '',
    '## What Changes',
    '',
    '- ',
    '',
    '## Impact',
    '',
    '- ',
    '',
    '',
  ].join('\n')
}

function designTemplate(title: string): string {
  return [
    `# Design — ${title}`,
    '',
    '<!-- 关键决策、权衡、替代方案。非平凡变更必填。 -->',
    '',
    '## D1 决策',
    '',
    '',
  ].join('\n')
}

function tasksTemplate(): string {
  return [
    '# Tasks',
    '',
    '- [ ] 1. 骨架与规格',
    '- [ ] 2. 实现',
    '- [ ] 3. 测试与验证',
    '',
  ].join('\n')
}

/**
 * Create the change directory. Returns `existing` (and touches nothing) when
 * the directory is already present — creation is best-effort: a failure to
 * write templates after the directory exists is reported in `note`, never thrown.
 */
export async function generateChangeDir(
  projectRoot: string,
  openspecRoot: string,
  changeId: string,
  title: string,
): Promise<GenerateChangeDirResult> {
  const root = validateProjectRoot(projectRoot)
  const { stat } = await import('node:fs/promises')
  const dir = join(root, openspecRoot, 'changes', changeId)

  try {
    const info = await stat(dir)
    if (info.isDirectory()) return { status: 'existing', dir }
  } catch {
    // not there — proceed to create
  }

  await mkdir(dir, { recursive: true })
  const files: Array<[string, string]> = [
    ['proposal.md', proposalTemplate(changeId, title)],
    ['design.md', designTemplate(title)],
    ['tasks.md', tasksTemplate()],
  ]
  for (const [name, content] of files) {
    try {
      await writeFile(join(dir, name), content, 'utf8')
    } catch (error) {
      return {
        status: 'created',
        dir,
        note: `failed to write ${name}: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }
  return { status: 'created', dir }
}

export interface OpenspecChangeState {
  /** `active` = changes/<id> exists; `archived` = changes/archive/*-<id> exists; `missing`. */
  state: 'active' | 'archived' | 'missing'
  /** tasks.md checkbox progress, when a tasks.md is readable. */
  tasks?: { done: number; total: number }
}

/**
 * Read-only OpenSpec state probe. Any filesystem hiccup collapses to
 * `missing` — status must keep working on machines without the project.
 */
export async function readChangeState(
  projectRoot: string,
  openspecRoot: string,
  changeId: string,
): Promise<OpenspecChangeState> {
  const { readdir, readFile, stat } = await import('node:fs/promises')
  const root = validateProjectRoot(projectRoot)
  const changesDir = join(root, openspecRoot, 'changes')

  const activeDir = join(changesDir, changeId)
  let active = false
  try {
    active = (await stat(activeDir)).isDirectory()
  } catch {
    active = false
  }

  let archived = false
  try {
    const entries = await readdir(join(changesDir, 'archive'))
    archived = entries.some((entry) => entry.endsWith(`-${changeId}`))
  } catch {
    archived = false
  }

  const tasks = await readTaskProgress(activeDir, stat, readFile)
  if (active) return { state: 'active', ...(tasks ? { tasks } : {}) }
  if (archived) return { state: 'archived' }
  return { state: 'missing' }
}

async function readTaskProgress(
  activeDir: string,
  stat: (path: string) => Promise<{ isFile(): boolean }>,
  readFile: (path: string, encoding: 'utf8') => Promise<string>,
): Promise<{ done: number; total: number } | undefined> {
  try {
    const tasksPath = join(activeDir, 'tasks.md')
    if (!(await stat(tasksPath)).isFile()) return undefined
    const content = await readFile(tasksPath, 'utf8')
    const done = (content.match(/^- \[x\]/gm) ?? []).length
    const total = (content.match(/^- \[.\]/gm) ?? []).length
    return total > 0 ? { done, total } : undefined
  } catch {
    return undefined
  }
}
