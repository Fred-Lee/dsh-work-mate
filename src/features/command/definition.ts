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
}

export interface CommandDeps {
  /** Ensure the SSE-normalizing proxy is available (no-op when disabled). */
  ensureProxy(): Promise<{ status: string; note?: string }>
  /** WorkMate-registered projects, for resolving a project by name. */
  projects(): Promise<readonly KnownProject[]>
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

      // "当前项目" first: the session knows its own workspace cwd.
      const resolved = resolveProjectRoot({
        ...(parsed.projectRoot !== undefined ? { input: parsed.projectRoot } : {}),
        cwd: sessionCwdOf(invocation.agent) ?? process.cwd(),
        projects: await deps.projects(),
      })
      if ('error' in resolved) return fail(resolved.error)
      const projectRoot = resolved.root

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
      return ok(
        [`✅ 成功｜${where}`, `页数：${result.pages}`, `阅读器：${result.indexHtml}`, suffix]
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
