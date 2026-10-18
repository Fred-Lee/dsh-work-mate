/**
 * Canonical plan fingerprint (change `multiproject-branch-workbench`, design
 * D12): G2 approves a `planHash`, not a vibe. The hash covers the OpenSpec plan
 * artifacts (`proposal.md`, `design.md`, `tasks.md`, `specs/**\/*.md`) plus the
 * optional team artifacts (`REQ.md`, `PLAN.md`, `TASKS.json`) when present.
 * `tasks.md` checkbox state is normalized away: completing a task must not
 * invalidate the approved plan, changing its text must.
 *
 * Missing proposal/design/tasks yields no hash (and names what is missing);
 * specs are optional because small fixes legitimately have none.
 */
import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { validateProjectRoot } from './openspec.ts'
import type { ProposalTarget } from './store.ts'

export const REQUIRED_PLAN_FILES = ['proposal.md', 'design.md', 'tasks.md'] as const

export interface PlanFingerprint {
  /** Present only when every required file exists. */
  hash?: string
  /** Change-relative paths included in the hash, sorted. */
  files: string[]
  /** Required files that are absent. */
  missing: string[]
}

const isFile = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** Recursively list `.md` files under `<changeDir>/specs`, change-relative. */
async function specFiles(changeDir: string): Promise<string[]> {
  const root = join(changeDir, 'specs')
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        out.push(relative(changeDir, path).split(sep).join('/'))
      }
    }
  }
  await walk(root)
  return out.sort()
}

/** Read the plan artifacts and compute their canonical hash. */
export async function computePlanFingerprint(
  projectRoot: string,
  openspecRoot: string,
  changeId: string,
  targets?: readonly ProposalTarget[],
): Promise<PlanFingerprint> {
  const root = validateProjectRoot(projectRoot)
  const changeDir = join(root, openspecRoot, 'changes', changeId)
  const present: string[] = []
  const missing: string[] = []
  for (const name of REQUIRED_PLAN_FILES) {
    if (await isFile(join(changeDir, name))) present.push(name)
    else missing.push(name)
  }
  const specs = await specFiles(changeDir)
  const teamFiles: string[] = []
  for (const name of ['REQ.md', 'PLAN.md', 'TASKS.json']) {
    if (await isFile(join(changeDir, name))) teamFiles.push(name)
  }
  const files = [...present, ...specs, ...teamFiles].sort()
  if (missing.length > 0) return { files, missing }
  if (files.length === 0) return { files, missing }
  const hash = createHash('sha256')
  if (targets !== undefined) {
    hash.update(JSON.stringify(targets.map((target) => ({ project: target.project, baseBranch: target.baseBranch }))))
    hash.update('\u0000')
  }
  for (const file of files) {
    const content = await readFile(join(changeDir, file), 'utf8')
    hash.update(file)
    hash.update('\u0000')
    hash.update(file === 'tasks.md' ? content.replace(/^(\s*[-*]\s+)\[[ xX]\]/gm, '$1[ ]') : content)
    hash.update('\u0000')
  }
  return { hash: hash.digest('hex'), files, missing }
}
