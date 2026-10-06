/**
 * `/workmate` slash command (change `add-workmate-command`).
 *
 * Why this exists: a chat request like "整理一下 X 的 wiki" leaves tool choice to the
 * model — it may bypass `workmate_wiki_generate` and run `gitnexus wiki` directly,
 * where the SSE-normalizing proxy is not running and the gateway key is not injected.
 * The host's command registry runs a handler **without sending the command to the
 * model** (`@deepseek-ai/dsh-commands`), so `/workmate wiki <path>` is deterministic.
 *
 * Parsing is pure and testable; the handler only wires existing bridges.
 */

export type WorkmateAction = 'help' | 'status' | 'wiki'

export interface WorkmateInput {
  action: WorkmateAction
  projectRoot?: string
  force: boolean
  reanalyze: boolean
  lang?: string
}

export interface ParseFailure {
  error: string
}

const USAGE = [
  '/workmate wiki [项目] [--force] [--reanalyze] [--lang chinese]  — 生成 / 更新项目 wiki',
  '/workmate status [项目]                                        — 只读：索引新鲜度 + wiki 产物',
  '  项目可省略（= 当前项目 / 会话工作目录），也可给项目名、相对路径或绝对路径',
  '/workmate help                                                 — 显示本帮助',
].join('\n')

export function workmateUsage(): string {
  return USAGE
}

/**
 * Parse the text following `/workmate`. Unknown subcommands and missing/invalid
 * paths fail loudly — a command that silently guesses is worse than one that helps.
 */
export function parseWorkmateInput(rawInput: string): WorkmateInput | ParseFailure {
  const tokens = rawInput.trim().split(/\s+/).filter((token) => token !== '')
  if (tokens.length === 0 || tokens[0] === 'help' || tokens[0] === '--help' || tokens[0] === '-h') {
    return { action: 'help', force: false, reanalyze: false }
  }
  const [action, ...rest] = tokens
  if (action !== 'wiki' && action !== 'status') {
    return { error: `未知子命令 '${action}'。\n\n${USAGE}` }
  }
  let projectRoot: string | undefined
  let force = false
  let reanalyze = false
  let lang: string | undefined
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] as string
    if (token === '--force' || token === '-f') force = true
    else if (token === '--reanalyze' || token === '--analyze') reanalyze = true
    else if (token === '--lang') {
      const value = rest[index + 1]
      if (value === undefined) return { error: '--lang 需要一个值（例如 --lang chinese）' }
      lang = value
      index += 1
    } else if (token.startsWith('--')) return { error: `未知旗标 '${token}'。\n\n${USAGE}` }
    else if (projectRoot === undefined) projectRoot = token
    else return { error: `多余参数 '${token}'（路径只能给一个）。\n\n${USAGE}` }
  }
  return {
    action,
    ...(projectRoot !== undefined ? { projectRoot } : {}),
    force,
    reanalyze,
    ...(lang !== undefined ? { lang } : {}),
  }
}
