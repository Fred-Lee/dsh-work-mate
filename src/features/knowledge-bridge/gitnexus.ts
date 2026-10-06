/**
 * GitNexus bridge — CLI direct connection (design D1 of `add-knowledge-bridge`):
 * the assumed `@deepseek-ai/dsh-mcp-client` does not exist in this ecosystem,
 * while the local `gitnexus` binary natively exposes everything we need.
 * execFile + argv array, cwd = the target project, hard timeout.
 */
import { basename, join } from 'node:path'
import { execFile } from 'node:child_process'
import { validateProjectRoot } from '../proposal/openspec.ts'

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
      { cwd, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, ...(signal !== undefined ? { signal } : {}) },
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
    return { output: output.trim() || '(no output)', wikiDir, indexHtml }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      output: '',
      wikiDir,
      indexHtml,
      note:
        `gitnexus wiki failed: ${detail} — ` +
        'wiki 生成需要 LLM 配置（~/.gitnexus/config.json，或先跑一次 ' +
        '`gitnexus wiki --provider <p> --model <m> --api-key <k>` 把配置存下来）',
    }
  }
}
