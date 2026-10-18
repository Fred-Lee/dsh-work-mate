/**
 * DSH Workspace → WorkMate project candidates (change
 * `multiproject-branch-workbench`, design D13).
 *
 * The official Workspace registry is a directory list, not a project list: it
 * accepts any folder. This module only reads it, keeps git repositories that
 * are not already registered, and suggests a collision-free name. It never
 * writes to either registry — the user confirms each import in the panel.
 */
import { stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { ProjectRegistry } from './registry.ts'

export interface WorkspaceLike {
  path: string
  title: string
}

export interface WorkspaceRegistryLike {
  list(): readonly WorkspaceLike[] | Promise<readonly WorkspaceLike[]>
}

export interface WorkspaceCandidate {
  /** Canonical-ish directory path as the Workspace reports it. */
  path: string
  /** Workspace display title. */
  title: string
  /** Name that would be used if imported as-is. */
  name: string
  /** Name suggested when `name` already belongs to another root. */
  suggestedName: string
  /** Already registered under this root (by any name). */
  registered: boolean
  /** Existing WorkMate name for the same root, when registered. */
  registeredAs?: string
  /** Contains an `openspec/` directory (shown as a hint, not a filter). */
  hasOpenspec: boolean
  /** Grouping label for the panel (`Workspace.title`). */
  workspace: string
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

const isGitRepo = async (root: string): Promise<boolean> => {
  try {
    const info = await stat(join(root, '.git'))
    return info.isDirectory() || info.isFile()
  } catch {
    return false
  }
}

const uniqueName = (base: string, taken: Set<string>): string => {
  if (!taken.has(base)) return base
  let index = 2
  while (taken.has(`${base}-${index}`)) index += 1
  return `${base}-${index}`
}

/**
 * Read-only candidate list. Non-git Workspaces are skipped; a registered root
 * is returned with `registered: true` so the panel can explain why it has no
 * import action. Paths are de-duplicated after `resolve`.
 */
export async function listWorkspaceCandidates(
  workspaceRegistry: WorkspaceRegistryLike,
  projectRegistry: ProjectRegistry,
): Promise<WorkspaceCandidate[]> {
  const workspaces = await workspaceRegistry.list()
  const projects = await projectRegistry.list()
  const roots = new Map(projects.map((project) => [resolve(project.root), project]))
  const taken = new Set(projects.map((project) => project.name))
  const seen = new Set<string>()
  const candidates: WorkspaceCandidate[] = []

  for (const workspace of workspaces) {
    const root = resolve(workspace.path)
    if (seen.has(root)) continue
    seen.add(root)
    if (!(await isGitRepo(root))) continue

    const existing = roots.get(root)
    const name = basename(root)
    const suggestedName = existing !== undefined ? existing.name : uniqueName(name, taken)
    candidates.push({
      path: root,
      title: workspace.title,
      name,
      suggestedName,
      registered: existing !== undefined,
      ...(existing !== undefined ? { registeredAs: existing.name } : {}),
      hasOpenspec: await exists(join(root, 'openspec')),
      workspace: workspace.title.trim() !== '' ? workspace.title : basename(dirname(root)),
    })
  }
  return candidates
}
