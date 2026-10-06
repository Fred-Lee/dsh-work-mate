/**
 * Implicit project-root resolution (change `resolve-project-implicitly`).
 *
 * The user should not have to paste an absolute path just because they are already
 * talking about a project: a DSH session carries its own workspace cwd
 * (`agent.session.header.cwd`, the same source `tool-bash` and `tool-lsp` use), so
 * "当前项目" is knowable. Resolution order is explicit and fails with candidates
 * instead of guessing.
 */
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

/** Tokens that mean "the session's current project". */
export const CURRENT_PROJECT_TOKENS = new Set([
  '',
  '.',
  './',
  '当前项目',
  '本项目',
  '这个项目',
  '当前仓库',
  '本仓库',
  '这里',
  'cwd',
])

export interface AgentLike {
  session?: { header?: { cwd?: string } }
}

/** The session workspace cwd for this call, or undefined when none applies. */
export function sessionCwdOf(agent: AgentLike | undefined): string | undefined {
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

export interface KnownProject {
  name: string
  root: string
}

export interface ResolveProjectOptions {
  /** Raw user token: absolute path, relative path, project name, or a current-project token. */
  input?: string
  /** Session cwd (falls back to process.cwd() at the call site). */
  cwd?: string
  /** WorkMate-registered projects, used for name lookup. */
  projects?: readonly KnownProject[]
}

export type ResolveProjectResult = { root: string; how: string } | { error: string }

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Resolve the target project. Never invents a path: an unresolvable input returns
 * an error that lists what *is* available (current project + registered names).
 */
export function resolveProjectRoot(options: ResolveProjectOptions): ResolveProjectResult {
  const { input, cwd, projects = [] } = options
  const raw = (input ?? '').trim()

  if (CURRENT_PROJECT_TOKENS.has(raw)) {
    if (cwd === undefined || cwd === '') {
      return { error: '无法确定"当前项目"：这个会话没有工作目录，请给出绝对路径。' }
    }
    return { root: cwd, how: '当前项目（会话工作目录）' }
  }

  if (isAbsolute(raw)) {
    if (!existsSync(raw)) return { error: `路径不存在：${raw}` }
    if (!isDirectory(raw)) return { error: `不是目录：${raw}` }
    return { root: raw, how: '绝对路径' }
  }

  const named = projects.find((project) => project.name.toLowerCase() === raw.toLowerCase())
  if (named !== undefined) {
    if (!isDirectory(named.root)) return { error: `已注册项目 ${named.name} 的路径不可用：${named.root}` }
    return { root: named.root, how: `已注册项目 ${named.name}` }
  }

  if (cwd !== undefined && cwd !== '') {
    const relative = resolve(join(cwd, raw))
    if (isDirectory(relative)) return { root: relative, how: `相对当前项目：${raw}` }
  }

  const candidates = [
    ...(cwd !== undefined && cwd !== '' ? [`当前项目：${cwd}`] : []),
    ...projects.map((project) => `已注册：${project.name} → ${project.root}`),
  ]
  return {
    error:
      `无法解析项目 '${raw}'。可以直接省略参数（= 当前项目），或用绝对路径` +
      (candidates.length > 0 ? `，\n可用：${candidates.join('\n      ')}` : '。'),
  }
}
