/**
 * Project wiki → Obsidian/Tolaria vault (change `export-wiki-to-vault`).
 *
 * Two consumers, one artifact: humans read these notes in a vault app (Graph view,
 * Dataview, backlinks), the AI reads the very same markdown files (grep/read with
 * file+line citations). So the export is not a dump — it is an index (MOC) plus one
 * note per module, with YAML front-matter and `[[wikilinks]]` that make the graph
 * show real structure, and one note per proposal carrying its dependencies.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Proposal } from '../proposal/store.ts'

export interface VaultIterationInput {
  id: string
  title: string
  status: string
  archived: boolean
  /** From proposal.relatesTo — rendered as `depends_on`. */
  dependsOn: string[]
  /** From decisions that overturn earlier ones — rendered as `supersedes`. */
  supersedes: string[]
  commits: string[]
}

export interface VaultExportInput {
  /** Repository that owns `.gitnexus/wiki`. */
  projectRoot: string
  /** Project name used for the vault directory and front-matter. */
  project: string
  /** Vault root (Obsidian/Tolaria folder). */
  vaultPath: string
  /** Subdirectory inside the vault. @default 'WorkMate' */
  subdir?: string
  /** Proposals of this project, projected into iteration notes. */
  iterations?: readonly VaultIterationInput[]
  now?: () => Date
}

export interface VaultExportResult {
  projectDir: string
  /** Paths written, relative to the vault root. */
  written: string[]
  modules: number
  pages: number
  iterations: number
  commit?: string
  note?: string
}

/** Build the iteration projection from WorkMate proposals (dependencies are real data). */
export function iterationsFromProposals(proposals: readonly Proposal[]): VaultIterationInput[] {
  return proposals.map((proposal) => ({
    id: proposal.id,
    title: proposal.title,
    status: proposal.status,
    archived: proposal.status === 'archived',
    dependsOn: (proposal.relatesTo ?? []).map((value) => value.trim()).filter((value) => value !== ''),
    supersedes: (proposal.decisions ?? [])
      .map((entry) => entry.supersedes)
      .filter((value): value is string => typeof value === 'string' && value !== ''),
    commits: (proposal.commits ?? []).map((commit) => String(commit).slice(0, 8)),
  }))
}

interface ModuleEntry {
  name: string
  slug: string
}

/** YAML front-matter: never emit `undefined`, always quote strings that could parse oddly. */
function frontMatter(fields: Record<string, string | number | boolean | string[] | undefined>): string {
  const lines = ['---']
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      lines.push(value.length === 0 ? `${key}: []` : `${key}: [${value.map((item) => JSON.stringify(item)).join(', ')}]`)
    } else {
      lines.push(`${key}: ${typeof value === 'string' ? JSON.stringify(value) : String(value)}`)
    }
  }
  lines.push('---', '')
  return lines.join('\n')
}

const asArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

/** Read GitNexus's module tree; tolerate its absence (the export then has no modules). */
async function readModules(wikiDir: string): Promise<ModuleEntry[]> {
  try {
    const raw = await readFile(join(wikiDir, 'module_tree.json'), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    const list = Array.isArray(parsed) ? parsed : ((parsed as { modules?: unknown }).modules ?? [])
    if (!Array.isArray(list)) return []
    return list
      .map((entry) => {
        const record = entry as { name?: unknown; slug?: unknown }
        const name = typeof record.name === 'string' ? record.name : undefined
        const slug = typeof record.slug === 'string' ? record.slug : undefined
        return name !== undefined && slug !== undefined ? { name, slug } : undefined
      })
      .filter((entry): entry is ModuleEntry => entry !== undefined)
  } catch {
    return []
  }
}

async function readMeta(wikiDir: string): Promise<{ commit?: string; generatedAt?: string }> {
  try {
    const parsed = JSON.parse(await readFile(join(wikiDir, 'meta.json'), 'utf8')) as {
      fromCommit?: unknown
      generatedAt?: unknown
    }
    return {
      ...(typeof parsed.fromCommit === 'string' ? { commit: parsed.fromCommit.slice(0, 8) } : {}),
      ...(typeof parsed.generatedAt === 'string' ? { generatedAt: parsed.generatedAt } : {}),
    }
  } catch {
    return {}
  }
}

/**
 * Export one project's wiki into the vault. Files are rewritten wholesale (the vault is
 * a projection, not a source of truth); the changelog is append-only and de-duplicated.
 */
export async function exportWikiToVault(input: VaultExportInput): Promise<VaultExportResult> {
  const now = input.now ?? ((): Date => new Date())
  const wikiDir = join(input.projectRoot, '.gitnexus', 'wiki')
  const subdir = input.subdir ?? 'WorkMate'
  const projectDirRel = join(subdir, input.project)
  const projectDir = join(input.vaultPath, projectDirRel)
  const modulesDir = join(projectDir, 'modules')
  const iterationsDir = join(projectDir, 'iterations')

  let pages = 0
  try {
    pages = (await readdir(wikiDir)).filter((entry) => entry.endsWith('.md')).length
  } catch {
    pages = 0
  }
  const modules = await readModules(wikiDir)
  const meta = await readMeta(wikiDir)
  const iterations = [...(input.iterations ?? [])]
  const generated = now().toISOString()

  await mkdir(modulesDir, { recursive: true })
  const written: string[] = []

  // ── one note per module ────────────────────────────────────────────────
  for (const module of modules) {
    const sourceFiles = (await readdir(wikiDir)).filter(
      (entry) => entry.endsWith('.md') && (entry === `${module.slug}.md` || entry.startsWith(`${module.slug}-`)),
    )
    const body: string[] = []
    for (const file of sourceFiles) {
      const text = await readFile(join(wikiDir, file), 'utf8')
      body.push(text.replace(/^---[\s\S]*?---\s*/m, '').trim())
    }
    const content =
      frontMatter({
        title: module.name,
        project: input.project,
        module: module.slug,
        source: 'gitnexus',
        commit: meta.commit,
        generated,
        pages: sourceFiles.length,
        tags: ['workmate', 'module', input.project],
      }) +
      `# ${module.name}\n\n> 项目 [[${subdir}/${input.project}/index|${input.project}]] · 来源 \`gitnexus\` · commit \`${meta.commit ?? 'unknown'}\`\n\n` +
      body.join('\n\n') +
      `\n\n---\n\n[[${subdir}/${input.project}/index|← 返回项目索引]]\n`
    const rel = join(projectDirRel, 'modules', `${module.slug}.md`)
    await writeFile(join(input.vaultPath, rel), content, 'utf8')
    written.push(rel)
  }

  // ── one note per iteration (dependencies come from proposals) ──────────
  for (const iteration of iterations) {
    const depends = iteration.dependsOn.map((id) => `"[[${subdir}/${input.project}/iterations/${id}|${id}]]"`)
    const sup = iteration.supersedes.map((id) => `"[[${subdir}/${input.project}/iterations/${id}|${id}]]"`)
    const content =
      frontMatter({
        title: iteration.title,
        type: 'iteration',
        project: input.project,
        proposal: iteration.id,
        status: iteration.status,
        archived: iteration.archived,
        generated,
        tags: ['workmate', 'iteration', input.project],
      }) +
      `# ${iteration.title}\n\n- 提案：\`${iteration.id}\`\n- 状态：**${iteration.status}**\n- 提交：${iteration.commits.map((c) => `\`${c}\``).join(' ') || '（无标记提交）'}\n\n` +
      `## 依赖（depends_on）\n\n${depends.length > 0 ? depends.map((line) => `- ${line.replaceAll('"', '')}`).join('\n') : '- （无声明）'}\n\n` +
      `## 取代（supersedes）\n\n${sup.length > 0 ? sup.map((line) => `- ${line.replaceAll('"', '')}`).join('\n') : '- （无）'}\n\n` +
      `---\n\n[[${subdir}/${input.project}/index|← 返回项目索引]]\n`
    const rel = join(projectDirRel, 'iterations', `${iteration.id}.md`)
    await mkdir(iterationsDir, { recursive: true })
    await writeFile(join(input.vaultPath, rel), content, 'utf8')
    written.push(rel)
  }

  // ── index (MOC) ────────────────────────────────────────────────────────
  const moduleTable = modules
    .map((module) => `| [[${subdir}/${input.project}/modules/${module.slug}\\|${module.name}]] | \`${module.slug}\` |`)
    .join('\n')
  const iterationTable = iterations
    .map(
      (iteration) =>
        `| [[${subdir}/${input.project}/iterations/${iteration.id}\\|${iteration.title}]] | ${iteration.status} | ` +
        `${iteration.dependsOn.join(', ') || '—'} | ${iteration.supersedes.join(', ') || '—'} |`,
    )
    .join('\n')
  const index =
    frontMatter({
      title: `${input.project} — 项目 wiki`,
      type: 'moc',
      project: input.project,
      source: 'gitnexus',
      commit: meta.commit,
      generated,
      modules: modules.length,
      pages,
      tags: ['workmate', 'moc', input.project],
    }) +
    `# ${input.project} — 项目 wiki\n\n` +
    `> 由 WorkMate 从 GitNexus 图谱导出 · commit \`${meta.commit ?? 'unknown'}\` · ${generated} · ${modules.length} 模块 / ${pages} 页\n\n` +
    `## 模块\n\n| 模块 | slug |\n| --- | --- |\n${moduleTable || '| （无） | — |'}\n\n` +
    (iterations.length > 0
      ? `## 迭代与依赖\n\n| 迭代 | 状态 | depends_on | supersedes |\n| --- | --- | --- | --- |\n${iterationTable}\n\n`
      : '') +
    `## 说明\n\n- 人读：本文件是入口；模块笔记在 \`modules/\`，迭代笔记在 \`iterations/\`。\n- AI 读：直接读同一批文件即可；检索建议返回**文件 + 行号**。\n`
  const indexRel = join(projectDirRel, 'index.md')
  await writeFile(join(input.vaultPath, indexRel), index, 'utf8')
  written.push(indexRel)

  // ── changelog (append-only, de-duplicated by day+commit) ───────────────
  const changelogRel = join(projectDirRel, 'changelog.md')
  const changelogPath = join(input.vaultPath, changelogRel)
  const line = `- ${generated.slice(0, 10)} · \`${meta.commit ?? 'unknown'}\` · ${modules.length} 模块 / ${pages} 页 · ${iterations.length} 迭代`
  let existing = ''
  try {
    existing = await readFile(changelogPath, 'utf8')
  } catch {
    existing = `# ${input.project} — 变更记录\n\n`
  }
  if (!existing.includes(line)) {
    await writeFile(changelogPath, `${existing.trimEnd()}\n${line}\n`, 'utf8')
  }
  written.push(changelogRel)

  return {
    projectDir,
    written,
    modules: modules.length,
    pages,
    iterations: iterations.length,
    ...(meta.commit !== undefined ? { commit: meta.commit } : {}),
  }
}
