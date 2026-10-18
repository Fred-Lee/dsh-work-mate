/**
 * Read-only branch discovery for a registered project (change
 * `multiproject-branch-workbench`, design D2/D13).
 *
 * Branch selection needs a list, not a guess: the panel shows local/remote
 * branches plus the project default (`main` → `master` → configured value).
 * Every call is read-only — no fetch, no checkout, no branch creation.
 */
import { gitExec, branchExists } from '../worktree/git.ts'
import { validateProjectRoot } from '../proposal/openspec.ts'

export interface ProjectBranches {
  current: string
  default?: string
  local: string[]
  remote: string[]
}

const currentBranch = async (root: string): Promise<string> =>
  (await gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], root, 5_000)).trim()

const refs = async (root: string, namespace: 'refs/heads' | 'refs/remotes'): Promise<string[]> => {
  const out = await gitExec(['for-each-ref', '--format=%(refname:short)', namespace], root, 10_000)
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/** `main` then `master`; `undefined` when neither exists (no guess from HEAD). */
export async function detectDefaultBranch(root: string, local?: readonly string[]): Promise<string | undefined> {
  const candidates = ['main', 'master']
  if (local !== undefined) {
    for (const candidate of candidates) if (local.includes(candidate)) return candidate
    return undefined
  }
  for (const candidate of candidates) if (await branchExists(root, candidate)) return candidate
  return undefined
}

/**
 * List a project's branches. A configured default wins only when it exists
 * locally; otherwise detection decides. Throws a readable error for a missing
 * or non-git root (the caller turns it into a 400).
 */
export async function listProjectBranches(
  projectRoot: string,
  configuredDefault?: string,
): Promise<ProjectBranches> {
  const root = validateProjectRoot(projectRoot)
  const current = await currentBranch(root)
  const local = await refs(root, 'refs/heads')
  const remote = await refs(root, 'refs/remotes')
  const configured = configuredDefault?.trim()
  const fallback = configured !== undefined && configured !== '' && local.includes(configured) ? configured : undefined
  const detected = fallback ?? (await detectDefaultBranch(root, local))
  return {
    current,
    ...(detected !== undefined ? { default: detected } : {}),
    local,
    remote,
  }
}
