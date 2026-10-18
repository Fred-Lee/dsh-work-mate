/**
 * Proposal write-scope claims (change `multiproject-branch-workbench`,
 * design D5.3). `<!-- writes: a/**, b/** -->` declarations are the auditable
 * promise that two parallel proposals will not touch the same files. This
 * module reads those declarations and reports pairwise overlaps per project;
 * blocking lives in the lifecycle gate, not here.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { scopesIntersect } from '../swarm/plan.ts'
import { validateProjectRoot } from './openspec.ts'

const WRITES = /<!--\s*writes:\s*([^>]*?)\s*-->/g

const stripComments = (content: string): string[] => {
  const scopes: string[] = []
  for (const match of content.matchAll(WRITES)) {
    const value = match[1] ?? ''
    for (const scope of value.split(',')) {
      const trimmed = scope.trim()
      if (trimmed !== '') scopes.push(trimmed)
    }
  }
  return scopes
}

/**
 * Union of declared write scopes from `design.md` and `tasks.md`. Missing files
 * are simply skipped (a small fix may only have one), and duplicates collapse.
 */
export async function readProposalWriteScopes(
  projectRoot: string,
  openspecRoot: string,
  changeId: string,
): Promise<string[]> {
  const root = validateProjectRoot(projectRoot)
  const dir = join(root, openspecRoot, 'changes', changeId)
  const scopes = new Set<string>()
  for (const file of ['design.md', 'tasks.md']) {
    let content: string
    try {
      content = await readFile(join(dir, file), 'utf8')
    } catch {
      continue
    }
    for (const scope of stripComments(content)) scopes.add(scope)
  }
  return [...scopes].sort()
}

export interface WriteClaim {
  proposalId: string
  project: string
  writes: string[]
}

export interface WriteConflict {
  project: string
  /** Pair of proposal ids whose declared scopes overlap. */
  proposalIds: [string, string]
  /** The overlapping scopes. */
  scopes: string[]
}

/** Pairwise overlap per project; a proposal never conflicts with itself. */
export function findWriteConflicts(claims: readonly WriteClaim[]): WriteConflict[] {
  const conflicts: WriteConflict[] = []
  for (let left = 0; left < claims.length; left += 1) {
    for (let right = left + 1; right < claims.length; right += 1) {
      const a = claims[left] as WriteClaim
      const b = claims[right] as WriteClaim
      if (a.project !== b.project || a.proposalId === b.proposalId) continue
      const overlaps = new Set<string>()
      for (const scopeA of a.writes) {
        for (const scopeB of b.writes) {
          if (scopesIntersect(scopeA, scopeB)) {
            overlaps.add(scopeA.length <= scopeB.length ? scopeA : scopeB)
          }
        }
      }
      if (overlaps.size > 0) {
        conflicts.push({
          project: a.project,
          proposalIds: [a.proposalId, b.proposalId].sort() as [string, string],
          scopes: [...overlaps].sort(),
        })
      }
    }
  }
  return conflicts
}
