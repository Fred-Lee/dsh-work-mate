/**
 * `/workmate` command definition (change `add-workmate-command`).
 *
 * The handler composes existing bridges only — no model, no new credential path:
 *   status → gitnexusStatus + artifact inspection (read-only)
 *   wiki   → ensureSseProxy → optional gitnexusAnalyze → gitnexusWiki → verdict
 *
 * Verdicts follow the discipline used everywhere else in this plugin: a wiki is
 * "done" only when `index.html` exists (`complete`); page counts are measured, never
 * taken from the CLI's own summary.
 */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { CommandFace, CommandResultFace } from '../guidance/faces.ts'
import {
  resolveProjectRoot,
  sessionCwdOf,
  type AgentLike,
  type KnownProject,
} from '../project/implicit-root.ts'
import { parseWorkmateInput, workmateUsage } from './parse.ts'

export interface WikiRunResult {
  wikiDir: string
  indexHtml: string
  pages: number
  complete: boolean
  output: string
  note?: string
  /** Non-fatal issue (e.g. exit code non-zero on a complete run). */
  warning?: string
  /** The wiki on disk came from an EARLIER run; this run produced nothing. */
  staleArtifacts?: boolean
  /** GitNexus reported the wiki as already current (nothing regenerated). */
  upToDate?: boolean
  /** Mode reported by GitNexus (`full` / `up-to-date` / …). */
  mode?: string
  /** Wall-clock milliseconds of the generation call. */
  elapsedMs?: number
}

export interface VaultExportSummary {
  projectDir: string
  written: string[]
  modules: number
  pages: number
  iterations: number
  commit?: string
  git?: { committed: boolean; note?: string }
}

export interface CommandDeps {
  /** Ensure the SSE-normalizing proxy is available (no-op when disabled). */
  ensureProxy(): Promise<{ status: string; note?: string }>
  /** WorkMate-registered projects, for resolving a project by name. */
  projects(): Promise<readonly KnownProject[]>
  /** Export the project wiki into the vault (Obsidian/Tolaria). */
  exportToVault(input: { projectRoot: string; vaultPath?: string; noGit?: boolean }): Promise<VaultExportSummary>
  /** Lexical vault search; returns file+line citations for the AI to quote. */
  searchVault(input: { query: string; limit?: number; vaultPath?: string; semantic?: boolean }): Promise<{
    hits: Array<{ file: string; line: number; text: string }>
    scannedFiles: number
    note?: string
  }>
  status(projectRoot: string): Promise<{ stale: boolean; output: string; note?: string }>
  analyze(projectRoot: string): Promise<{ note?: string }>
  wiki(projectRoot: string, options: { force: boolean; lang: string }): Promise<WikiRunResult>
  /** `Config.gitnexusWikiLang` (empty = GitNexus default). */
  configuredLang: string
}

/** Read-only artifact inspection shared by `status` (and mirrored by the wiki tool). */
export async function inspectWikiArtifacts(repoRoot: string): Promise<{ pages: number; complete: boolean; indexBytes: number }> {
  const wikiDir = join(repoRoot, '.gitnexus', 'wiki')
  try {
    const entries = await readdir(wikiDir)
    const pages = entries.filter((entry) => entry.endsWith('.md')).length
    const complete = entries.includes('index.html')
    const indexBytes = complete ? (await stat(join(wikiDir, 'index.html'))).size : 0
    return { pages, complete, indexBytes }
  } catch {
    return { pages: 0, complete: false, indexBytes: 0 }
  }
}

const ok = (text: string): CommandResultFace => ({ kind: 'success', text })
const fail = (text: string): CommandResultFace => ({ kind: 'error', text })
const kb = (bytes: number): string => `${Math.round(bytes / 1024)} KB`

export function workmateCommandDefinition(deps: CommandDeps): {
  name: string
  description: string
  input: { hint: string }
  handler: (invocation: { rawInput: string; agent?: AgentLike }) => Promise<CommandResultFace>
} {
  return {
    name: 'workmate',
    description: 'WorkMate 确定性入口：生成 / 更新项目 wiki，或只读查看索引与 wiki 产物状态。',
    input: { hint: 'wiki [项目] | status [项目] | help（项目可省略 = 当前项目）' },
    async handler(invocation) {
      const parsed = parseWorkmateInput(invocation.rawInput)
      if ('error' in parsed) return fail(parsed.error)
      if (parsed.action === 'help') return ok(workmateUsage())

      const exportRequested = parsed.action === 'export'
      // "当前项目" first: the session knows its own workspace cwd.
      const resolved = resolveProjectRoot({
        ...(parsed.projectRoot !== undefined ? { input: parsed.projectRoot } : {}),
        cwd: sessionCwdOf(invocation.agent) ?? process.cwd(),
        projects: await deps.projects(),
      })
      if ('error' in resolved) return fail(resolved.error)
      const projectRoot = resolved.root

      if (parsed.action === 'search') {
        const found = await deps.searchVault({
          query: parsed.query ?? '',
          ...(parsed.limit !== undefined ? { limit: parsed.limit } : {}),
        })
        if (found.hits.length === 0) {
          return fail(`没有命中：${parsed.query ?? ''}${found.note !== undefined ? `（${found.note}）` : ''}`)
        }
        const lines = found.hits.map((hit) => `${hit.file}:${hit.line}  ${hit.text}`)
        return ok(
          [
            `🔍 ${found.hits.length} 条命中（扫描 ${found.scannedFiles} 篇笔记）`,
            ...lines,
            found.note ?? '',
          ]
            .filter((line) => line !== '')
            .join('\n'),
        )
      }

      if (exportRequested) {
        const exported = await deps.exportToVault({
          projectRoot,
          ...(parsed.vaultPath !== undefined ? { vaultPath: parsed.vaultPath } : {}),
          ...(parsed.noGit === true ? { noGit: true } : {}),
        })
        const gitLine = exported.git?.committed === true ? '已提交' : (exported.git?.note ?? '未提交')
        return ok(
          [
            `✅ 导出成功｜仓库：${projectRoot}（${resolved.how}）`,
            `vault 目录：${exported.projectDir}`,
            `内容：${exported.modules} 模块 / ${exported.pages} 页 / ${exported.iterations} 迭代`,
            `索引：${exported.projectDir}/index.md（用 Obsidian 打开即可看到模块表与依赖）`,
            `git：${gitLine}`,
            '提示：装 Dataview 插件可把迭代依赖变成表格/时间线。',
          ].join('\n'),
        )
      }

      if (parsed.action === 'status') {
        const status = await deps.status(projectRoot)
        const artifacts = await inspectWikiArtifacts(projectRoot)
        const lines = [
          `仓库：${projectRoot}（${resolved.how}）`,
          `索引：${status.stale ? '⚠️ stale（落后于当前提交，用 --reanalyze 重建）' : '✅ 与当前提交一致'}`,
          `wiki：complete=${artifacts.complete} | pages=${artifacts.pages}` +
            (artifacts.complete ? ` | index.html ${kb(artifacts.indexBytes)}` : ' | 缺 index.html（未跑完）'),
        ]
        if (status.note !== undefined) lines.push(`探测提示：${status.note}`)
        return ok(lines.join('\n'))
      }

      const proxy = await deps.ensureProxy()
      if (proxy.status === 'failed') {
        return fail(`SSE 归一代理不可用：${proxy.note ?? '未知原因'}（wiki 生成需要它在跑）`)
      }
      if (parsed.reanalyze) {
        const reindex = await deps.analyze(projectRoot)
        if (reindex.note !== undefined) return fail(`重索引失败，未生成 wiki：${reindex.note}`)
      }
      const lang = parsed.lang ?? deps.configuredLang
      const result = await deps.wiki(projectRoot, { force: parsed.force, lang })
      const where = `仓库：${projectRoot}（${resolved.how}）｜代理：${proxy.status}｜语言：${lang || '(GitNexus 默认)'}`
      if (!result.complete) {
        // One verdict line first: "what happened" must be readable without parsing.
        const reason = result.note ?? (result.staleArtifacts === true ? '本次未产出新产物（磁盘上是上一次的归档）' : '')
        return fail(
          `❌ 未完成｜${where}｜本次页数：${result.pages}\n${reason}\n阅读器（若存在）：${result.indexHtml}`,
        )
      }
      const suffix = result.warning !== undefined ? `⚠️ 有警告：${result.warning}` : ''
      const what =
        result.upToDate === true
          ? '已是最新（GitNexus 未重新生成；要整份重生成用 --force）'
          : `已生成 / 更新（CLI 模式：${result.mode ?? 'unknown'}）`
      const elapsed = result.elapsedMs !== undefined ? `${(result.elapsedMs / 1000).toFixed(1)}s` : '—'
      return ok(
        [
          `✅ 成功｜${where}`,
          `结果：${what}`,
          `产物（实测）：${result.pages} 页${result.complete ? ' + index.html' : ''}`,
          `耗时：${elapsed}｜索引重建：${parsed.reanalyze ? '是' : '否'}`,
          `阅读器：${result.indexHtml}`,
          suffix,
          '命令结束（无实时进度；需要边跑边看输出请在终端用 wkwiki）',
        ]
          .filter((line) => line !== '')
          .join('\n'),
      )
    },
  }
}

/** Registration helper: `commands` is optional, so the plugin stays ACTIVE without it. */
export function registerWorkmateCommand(commands: CommandFace, deps: CommandDeps): () => void {
  return commands.register(workmateCommandDefinition(deps))
}

export { parseWorkmateInput, workmateUsage }
