/**
 * GitNexus bridge — CLI direct connection (design D1 of `add-knowledge-bridge`):
 * the assumed `@deepseek-ai/dsh-mcp-client` does not exist in this ecosystem,
 * while the local `gitnexus` binary natively exposes everything we need.
 * execFile + argv array, cwd = the target project, hard timeout.
 */
import { basename, join } from 'node:path'
import { readdir, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { validateProjectRoot } from '../proposal/openspec.ts'
import { resolveGitnexusApiKey, withResolvedApiKey, type CredentialOptions } from './gitnexus-credentials.ts'

/**
 * Credential sources WorkMate uses for spawned `gitnexus` calls
 * (`Config.gitnexusApiKeyFromEnv` + `Config.gitnexusApiKeyKeychainService`).
 * Module-scoped so the single exec chokepoint — and every caller — stays unaware.
 */
let credentialOptions: Omit<CredentialOptions, 'env'> = {}

export function setGitnexusApiKeyEnv(name: string): void {
  credentialOptions = { ...credentialOptions, ...(name !== '' ? { fromEnvName: name } : {}) }
}

export function setGitnexusKeychainService(service: string): void {
  credentialOptions = { ...credentialOptions, ...(service !== '' ? { keychainService: service } : {}) }
}

/** Where a child-process credential would come from right now (source name only). */
export function gitnexusCredentialOptions(): Omit<CredentialOptions, 'env'> {
  return credentialOptions
}

export type GitnexusAction = 'query' | 'context' | 'impact'

export interface GitnexusResult {
  /** CLI text output (model-readable). */
  output: string
  note?: string
}

function execGitnexus(args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'gitnexus',
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        // GitNexus only reads GITNEXUS_API_KEY/OPENAI_API_KEY; the user's own
        // variable name is mapped here, per child process, never persisted.
        env: withResolvedApiKey(process.env, credentialOptions),
        ...(signal !== undefined ? { signal } : {}),
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr?.trim() || error.message
          reject(new Error(detail))
        } else {
          resolvePromise(stdout)
        }
      },
    )
  })
}

export async function gitnexusRun(
  action: GitnexusAction,
  projectRoot: string,
  args: { target: string; context?: string; direction?: 'upstream' | 'downstream'; repo?: string },
  signal?: AbortSignal,
): Promise<GitnexusResult> {
  const root = validateProjectRoot(projectRoot)
  const cliArgs: string[] = [action]
  if (action === 'query') {
    cliArgs.push(args.target)
    if (args.context) cliArgs.push('-c', args.context)
    cliArgs.push('-l', '5')
  } else if (action === 'context') {
    cliArgs.push(args.target)
  } else {
    cliArgs.push(args.target, '--direction', args.direction ?? 'upstream')
  }
  // The global GitNexus index usually spans many repos; without -r the CLI
  // refuses with "Multiple repositories indexed". Default to the directory
  // name (GitNexus names an indexed repo after its folder), overridable.
  const repo = args.repo ?? basename(root)
  cliArgs.push('-r', repo)

  try {
    const output = await execGitnexus(cliArgs, root, 30_000, signal)
    return { output: output.trim() || '(no output)' }
  } catch (error) {
    return { output: '', note: `gitnexus ${action} failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** Full re-index used by the archive orchestration (M4). */
export async function gitnexusAnalyze(
  projectRoot: string,
  options: { embeddings?: boolean; force?: boolean } = {},
  signal?: AbortSignal,
): Promise<GitnexusResult> {
  const root = validateProjectRoot(projectRoot)
  const cliArgs = ['analyze']
  if (options.force === true) cliArgs.push('--force')
  cliArgs.push(root)
  if (options.embeddings === true) cliArgs.push('--embeddings')

  try {
    const output = await execGitnexus(cliArgs, root, 120_000, signal)
    return { output: output.trim() || '(no output)' }
  } catch (error) {
    return { output: '', note: `gitnexus analyze failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

export interface GitnexusStatusResult {
  output: string
  /** True when the index no longer matches the working branch/commit. */
  stale: boolean
  note?: string
}

/**
 * Read-only freshness probe (design D1 of `add-wiki-generation`): `analyze` is a
 * heavy full rebuild, so the wiki entry point reports staleness instead of silently
 * running it. A probe failure counts as stale — unknown is not "fresh".
 */
export async function gitnexusStatus(projectRoot: string, signal?: AbortSignal): Promise<GitnexusStatusResult> {
  const root = validateProjectRoot(projectRoot)
  try {
    const output = await execGitnexus(['status'], root, 30_000, signal)
    return { output: output.trim(), stale: /stale|re-run gitnexus analyze/i.test(output) }
  } catch (error) {
    return {
      output: '',
      stale: true,
      note: `gitnexus status failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

export interface GitnexusWikiResult extends GitnexusResult {
  /** Where GitNexus writes the generated wiki. */
  wikiDir: string
  indexHtml: string
  /** Module pages actually written (`.md` count). */
  pages: number
  /** GitNexus writes `index.html` during finalization — its absence means an aborted run. */
  complete: boolean
  /**
   * Non-fatal problem worth telling the user about (the shipped CLI can exit non-zero
   * after a fully successful run). Distinct from `note`: a warning never means "failed".
   */
  warning?: string
  /** The wiki on disk was produced by an EARLIER run; this run produced nothing. */
  staleArtifacts?: boolean
  /** GitNexus said the wiki was already current, so nothing was regenerated. */
  upToDate?: boolean
  /** Mode reported by the CLI (`full` / `up-to-date` / incremental variants). */
  mode?: string
  /** Pages the CLI claims it generated (our `pages` is the measured count). */
  reportedPages?: number
  /** Wall-clock milliseconds for the CLI invocation. */
  elapsedMs?: number
}

/**
 * Read the artifact directory: claims about success are checked against files.
 *
 * `startedAt` guards the failure mode that produced a confusing "success": a run that
 * died instantly while the PREVIOUS run's wiki was still on disk. Artifacts older than
 * this run do not count — they are reported as `staleArtifacts` instead.
 */
async function inspectWiki(
  wikiDir: string,
  startedAt: number,
): Promise<{ pages: number; complete: boolean; staleArtifacts: boolean }> {
  try {
    const entries = await readdir(wikiDir)
    const pages = entries.filter((entry) => entry.endsWith('.md')).length
    if (!entries.includes('index.html')) return { pages, complete: false, staleArtifacts: false }
    const info = await stat(join(wikiDir, 'index.html'))
    const fresh = info.mtimeMs >= startedAt - 2_000
    return fresh ? { pages, complete: true, staleArtifacts: false } : { pages, complete: false, staleArtifacts: true }
  } catch {
    return { pages: 0, complete: false, staleArtifacts: false }
  }
}

/**
 * Generate the repository wiki from the knowledge graph. The output directory is
 * fixed by GitNexus (`<repo>/.gitnexus/wiki/`); WorkMate returns the absolute paths
 * instead of duplicating the content. Generation is per-module LLM work, hence the
 * long default timeout.
 */
/**
 * Read the CLI's own summary lines. The CLI already states the mode, the page count
 * and the elapsed time — throwing that away was why a fast up-to-date run looked
 * identical to a real regeneration.
 */
export function parseWikiSummary(output: string): {
  upToDate: boolean
  mode?: string
  reportedPages?: number
  cliElapsedSeconds?: number
} {
  const mode = /Mode:\s*([a-z-]+)/i.exec(output)?.[1]
  const pages = /Pages:\s*(\d+)/i.exec(output)?.[1]
  const seconds = /generated successfully \(([\d.]+)s\)/i.exec(output)?.[1]
  return {
    upToDate: /already up to date/i.test(output),
    ...(mode !== undefined ? { mode } : {}),
    ...(pages !== undefined ? { reportedPages: Number(pages) } : {}),
    ...(seconds !== undefined ? { cliElapsedSeconds: Number(seconds) } : {}),
  }
}

export async function gitnexusWiki(
  projectRoot: string,
  options: { force?: boolean; lang?: string; review?: boolean; timeoutMs?: number } = {},
  signal?: AbortSignal,
): Promise<GitnexusWikiResult> {
  const root = validateProjectRoot(projectRoot)
  const wikiDir = join(root, '.gitnexus', 'wiki')
  const indexHtml = join(wikiDir, 'index.html')
  const startedAt = Date.now()
  // Fail fast with an actionable message instead of letting the CLI die on a missing
  // key and leaving the caller to misread an earlier run's artifacts as success.
  const credentials = resolveGitnexusApiKey({ ...credentialOptions, env: process.env })
  if (credentials.source === 'none') {
    const artifact = await inspectWiki(wikiDir, startedAt)
    return {
      output: '',
      wikiDir,
      indexHtml,
      pages: 0,
      complete: false,
      staleArtifacts: artifact.staleArtifacts,
      ...(artifact.staleArtifacts
        ? { warning: `目录里是上一次的产物（${artifact.pages} 个页面），本次未执行生成` }
        : {}),
      note:
        '缺少网关凭据，未执行生成：请把 key 放进钥匙串并设置 Config.gitnexusApiKeyKeychainService，' +
        '或 export ESP_XKW_KEY / GITNEXUS_API_KEY（GitNexus 只认 GITNEXUS_API_KEY/OPENAI_API_KEY）',
    }
  }

  const cliArgs: string[] = ['wiki', root]
  if (options.force === true) cliArgs.push('--force')
  if (options.lang !== undefined && options.lang !== '') cliArgs.push('--lang', options.lang)
  if (options.review === true) cliArgs.push('--review')

  try {
    const output = await execGitnexus(cliArgs, root, options.timeoutMs ?? 900_000, signal)
    const summary = parseWikiSummary(output)
    // An "already up to date" answer legitimately leaves older artifacts in place:
    // they are current, so the freshness guard must not flag them as stale.
    const artifact = await inspectWiki(wikiDir, summary.upToDate ? 0 : startedAt)
    return {
      output: output.trim() || '(no output)',
      wikiDir,
      indexHtml,
      ...artifact,
      ...(summary.upToDate ? { upToDate: true } : {}),
      ...(summary.mode !== undefined ? { mode: summary.mode } : {}),
      ...(summary.reportedPages !== undefined ? { reportedPages: summary.reportedPages } : {}),
      elapsedMs: Date.now() - startedAt,
      // The CLI can report success and still stop half-way (an LLM circuit breaker
      // aborts the loop). A missing reader is the honest signal of that (design D1).
      ...(artifact.complete
        ? {}
        : artifact.staleArtifacts
          ? {
              note:
                `本次命令未产出新产物；目录里是上一次的 ${artifact.pages} 个页面（缺本次的 index.html）——` +
                '确认网关凭据与代理后再重跑',
            }
          : {
              note:
                `生成中断：已写出 ${artifact.pages} 个页面但缺少 index.html（LLM 端点失败/超时/熔断最常见）——` +
                '重跑同一命令可补齐已存在页面之外的模块',
            }),
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const artifact = await inspectWiki(wikiDir, startedAt)
    // The shipped CLI can exit non-zero AFTER writing a complete wiki (observed:
    // 47 pages + index.html written, non-zero exit). Judge by artifacts, not by the
    // exit status: a complete wiki is a success with a warning, never a failure.
    if (artifact.staleArtifacts) {
      return {
        output: '',
        wikiDir,
        indexHtml,
        pages: 0,
        complete: false,
        staleArtifacts: true,
        warning: `目录里是上一次的产物（${artifact.pages} 个页面），本次失败：${detail}`,
        note:
          `gitnexus wiki failed: ${detail} — 目录里的 wiki 来自更早的一次成功运行，` +
          '本次没有产出新产物（凭据/端点问题先解决再重跑）',
      }
    }
    if (artifact.complete && artifact.pages > 0) {
      return {
        output: '',
        wikiDir,
        indexHtml,
        ...artifact,
        warning: `gitnexus wiki 退出非 0（${detail}），但产物完整：${artifact.pages} 个页面 + index.html`,
      }
    }
    return {
      output: '',
      wikiDir,
      indexHtml,
      ...artifact,
      note:
        `gitnexus wiki failed: ${detail}（产物：${artifact.pages} 个页面，complete=${artifact.complete}）— ` +
        'wiki 生成需要可用的 LLM 端点（~/.gitnexus/config.json，或先跑一次 ' +
        '`gitnexus wiki --provider <p> --model <m> --api-key <k>` 把配置存下来）',
    }
  }
}
