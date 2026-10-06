/**
 * GitNexus bridge — CLI direct connection (design D1 of `add-knowledge-bridge`):
 * the assumed `@deepseek-ai/dsh-mcp-client` does not exist in this ecosystem,
 * while the local `gitnexus` binary natively exposes everything we need.
 * execFile + argv array, cwd = the target project, hard timeout.
 */
import { basename, join } from 'node:path'
import { readdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { validateProjectRoot } from '../proposal/openspec.ts'
import { withGitnexusApiKey } from './gitnexus-credentials.ts'

/**
 * Env variable WorkMate maps onto GITNEXUS_API_KEY for spawned `gitnexus` calls
 * (`Config.gitnexusApiKeyFromEnv`). Module-scoped so the single exec chokepoint
 * — and every caller — stays unaware of credential plumbing.
 */
let apiKeyFromEnv = ''

export function setGitnexusApiKeyEnv(name: string): void {
  apiKeyFromEnv = name
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
        env: withGitnexusApiKey(process.env, apiKeyFromEnv),
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
}

/** Read the artifact directory: claims about success are checked against files. */
async function inspectWiki(wikiDir: string): Promise<{ pages: number; complete: boolean }> {
  try {
    const entries = await readdir(wikiDir)
    return { pages: entries.filter((entry) => entry.endsWith('.md')).length, complete: entries.includes('index.html') }
  } catch {
    return { pages: 0, complete: false }
  }
}

/**
 * Generate the repository wiki from the knowledge graph. The output directory is
 * fixed by GitNexus (`<repo>/.gitnexus/wiki/`); WorkMate returns the absolute paths
 * instead of duplicating the content. Generation is per-module LLM work, hence the
 * long default timeout.
 */
export async function gitnexusWiki(
  projectRoot: string,
  options: { force?: boolean; lang?: string; review?: boolean; timeoutMs?: number } = {},
  signal?: AbortSignal,
): Promise<GitnexusWikiResult> {
  const root = validateProjectRoot(projectRoot)
  const wikiDir = join(root, '.gitnexus', 'wiki')
  const indexHtml = join(wikiDir, 'index.html')
  const cliArgs: string[] = ['wiki', root]
  if (options.force === true) cliArgs.push('--force')
  if (options.lang !== undefined && options.lang !== '') cliArgs.push('--lang', options.lang)
  if (options.review === true) cliArgs.push('--review')

  try {
    const output = await execGitnexus(cliArgs, root, options.timeoutMs ?? 900_000, signal)
    const artifact = await inspectWiki(wikiDir)
    return {
      output: output.trim() || '(no output)',
      wikiDir,
      indexHtml,
      ...artifact,
      // The CLI can report success and still stop half-way (an LLM circuit breaker
      // aborts the loop). A missing reader is the honest signal of that (design D1).
      ...(artifact.complete
        ? {}
        : {
            note:
              `生成中断：已写出 ${artifact.pages} 个页面但缺少 index.html（LLM 端点失败/超时/熔断最常见）——` +
              '重跑同一命令可补齐已存在页面之外的模块',
          }),
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const artifact = await inspectWiki(wikiDir)
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
