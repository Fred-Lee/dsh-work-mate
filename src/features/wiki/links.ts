/**
 * WeKnora Wiki association (change add-lifecycle-worktree-wiki, design D4):
 * WorkMate records references — never manages Wiki files. The WeKnora plugin's
 * tools (weknora_search / read_document / ask / list_knowledge_bases) are
 * session-side agent tools; the host only parses task declarations, validates
 * type coverage at implementing→merging and renders the archive artifacts.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TaskSnapshot } from '../archive/orchestrate.ts'
import type { WikiLink } from '../proposal/store.ts'

export const WIKI_PAGE_TYPES = ['concept', 'synthesis', 'entity'] as const
export type WikiPageType = (typeof WIKI_PAGE_TYPES)[number]

export type WikiContentKind = 'technical' | 'business' | 'both'

/** technical pages live on concept|synthesis; business pages on entity|concept. */
const COVERAGE: Record<Exclude<WikiContentKind, 'both'>, WikiPageType[]> = {
  technical: ['concept', 'synthesis'],
  business: ['entity', 'concept'],
}

/** Task line suffix declaration: `<!-- wiki: true; type: technical -->`. */
const WIKI_DECLARATION = /<!--\s*wiki:\s*true(?:\s*;\s*type:\s*(technical|business|both))?\s*-->/i

export interface WikiTask {
  text: string
  kind: Exclude<WikiContentKind, 'both'> | 'both'
}

/** Tasks that declared wiki work, with their content kind (default: both). */
export function parseWikiTasks(content: string): WikiTask[] {
  const tasks: WikiTask[] = []
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!/^- \[.\] /.test(line)) continue
    const match = WIKI_DECLARATION.exec(line)
    if (match === null) continue
    const declared = match[1]?.toLowerCase() as WikiContentKind | undefined
    tasks.push({
      text: line.replace(WIKI_DECLARATION, '').trim(),
      kind: declared ?? 'both',
    })
  }
  return tasks
}

/** Read tasks.md and extract the wiki declarations. */
export async function readWikiTasks(projectRoot: string, openspecRoot: string, changeId: string): Promise<WikiTask[]> {
  try {
    const content = await readFile(join(projectRoot, openspecRoot, 'changes', changeId, 'tasks.md'), 'utf8')
    return parseWikiTasks(content)
  } catch {
    return []
  }
}

export interface CoverageResult {
  ok: boolean
  missing: Array<{ task: string; kind: WikiContentKind; missingTypes: WikiPageType[] }>
}

/**
 * Type-coverage check for implementing→merging: every wiki task needs at least
 * one registered reference covering each allowed page type of its kind
 * (`both` = union of both lists).
 */
export function checkCoverage(tasks: WikiTask[], links: WikiLink[]): CoverageResult {
  const registered = new Set(links.map((link) => link.pageType))
  const missing: CoverageResult['missing'] = []

  for (const task of tasks) {
    const allowed = task.kind === 'both' ? [...COVERAGE.technical, ...COVERAGE.business] : COVERAGE[task.kind]
    const missingTypes = allowed.filter((pageType) => !registered.has(pageType))
    if (missingTypes.length > 0 && links.length > 0) {
      missing.push({ task: task.text, kind: task.kind, missingTypes })
    } else if (missingTypes.length > 0 && links.length === 0 && missing.every((m) => m.task !== task.text)) {
      missing.push({ task: task.text, kind: task.kind, missingTypes })
    }
  }
  return { ok: missing.length === 0, missing }
}

/** Group registered links for the panel and wiki.md (technical vs business). */
export function groupLinks(links: WikiLink[]): { technical: WikiLink[]; business: WikiLink[] } {
  const technical = links.filter((link) => link.pageType === 'concept' || link.pageType === 'synthesis')
  const business = links.filter((link) => link.pageType === 'entity')
  return { technical, business }
}

/** Render the archive artifact listing WeKnora references (URLs only). */
export function renderWikiMd(links: WikiLink[]): string {
  const { technical, business } = groupLinks(links)
  const lines = ['# WeKnora Wiki 关联', '', '## 技术方案', '']
  for (const link of technical) {
    lines.push(`- ${link.url} (${link.pageType}${link.version !== undefined ? `, 版本 ${link.version}` : ''})`)
  }
  if (technical.length === 0) lines.push('- （无）')
  lines.push('', '## 业务规则', '')
  for (const link of business) {
    lines.push(`- ${link.url} (${link.pageType}${link.version !== undefined ? `, 版本 ${link.version}` : ''})`)
  }
  if (business.length === 0) lines.push('- （无）')
  return `${lines.join('\n')}\n`
}

/** Render the archive commit manifest. */
export function renderCommitsMd(commits: Array<{ short: string; subject: string }>): string {
  const lines = ['# 关联提交', '']
  for (const commit of commits) lines.push(`- \`${commit.short}\` ${commit.subject}`)
  if (commits.length === 0) lines.push('- （无）')
  return `${lines.join('\n')}\n`
}

/** Re-export so the orchestration layer can snapshot tasks without importing orchestrate. */
export type { TaskSnapshot }

// ---------------------------------------------------------------------------
// Proposal-facing helpers (need the proposal service to persist references)
// ---------------------------------------------------------------------------

import type { ProposalService } from '../proposal/service.ts'

export interface WikiLinkInput {
  url: string
  pageType: string
  version?: number
  commit?: string
  taskId?: string
}

/** Register one WeKnora page reference on the proposal. */
export async function linkWikiToProposal(
  proposals: ProposalService,
  proposalId: string,
  input: WikiLinkInput,
): Promise<WikiLink> {
  const url = input.url.trim()
  if (!url) throw new Error('wiki url must be a non-empty string')
  const pageType = input.pageType.trim().toLowerCase()
  if (!WIKI_PAGE_TYPES.includes(pageType as WikiPageType)) {
    throw new Error(`pageType must be one of ${WIKI_PAGE_TYPES.join('|')}, got '${pageType}'`)
  }

  const proposal = await proposals.get(proposalId)
  if (!proposal) throw new Error(`proposal not found: ${proposalId}`)

  const link: WikiLink = {
    url,
    pageType: pageType as WikiPageType,
    registeredAt: new Date().toISOString(),
    ...(input.version !== undefined ? { version: input.version } : {}),
    ...(input.commit !== undefined && input.commit.trim() !== '' ? { commit: input.commit.trim() } : {}),
    ...(input.taskId !== undefined && input.taskId.trim() !== '' ? { taskId: input.taskId.trim() } : {}),
  }
  const proposalUpdated = await proposals.patchFields(proposalId, {
    wikiLinks: [...(proposal.wikiLinks ?? []), link],
  })
  void proposalUpdated
  return link
}

/** All registered references for a proposal (typed view). */
export async function listWikiLinks(proposals: ProposalService, proposalId: string): Promise<WikiLink[]> {
  const proposal = await proposals.get(proposalId)
  return proposal?.wikiLinks ?? []
}
