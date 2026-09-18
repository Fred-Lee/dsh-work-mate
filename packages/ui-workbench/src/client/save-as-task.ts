/**
 * 「保存为任务」 client logic — the browser half of the conversation→card intake
 * (change `add-task-kanban-board` task 5.4).
 *
 * It adds NO new write path: the action posts to the EXISTING host route
 * `POST {workbenchBase}/api/task-from-conversation` (change A … see
 * `docs/TASK-MODEL.md` §9), passing only `{ title, sessionId }`. `repo` is
 * deliberately omitted so the host falls back to the session's own `cwd`
 * (TASK-MODEL §9 step 2) — the browser has no business guessing a repo path.
 *
 * Everything here is pure so the interesting cases (which URL, which body, how
 * a refusal is worded) are testable without a DOM or a live host.
 */

/** Default mount of `@helmsman/ui-workbench`'s host half. */
export const DEFAULT_WORKBENCH_BASE = '/helmsman-workbench'

/** Swappable for tests; the host mount is a deployment detail. */
export interface SaveAsTaskOptions {
  base?: string
  fetchImpl?: typeof fetch
}

/** What the caller must supply to build a card. Both are required. */
export interface SaveAsTaskInput {
  /** Card title; also carried as the conversation association label. */
  title: string
  /** The DSH session the card is being cut from. */
  sessionId: string
}

/** Normalised outcome — never throws, so the caller always has something to say. */
export interface SaveAsTaskOutcome {
  ok: boolean
  /** The new card id when `ok`. */
  id?: string
  /** Card stage label as the host rendered it. */
  stageLabel?: string
  /** Generated summary text, when the host returned one. */
  summaryText?: string
  /** `model` | `manual` | `fallback` — whether a real model summarised it. */
  summarySource?: string
  /** How many conversation messages the host actually managed to read. */
  contextMessages?: number
  /** Non-fatal problems the host reported (the card still exists). */
  warnings?: string[]
  /** Honest refusal text when `ok` is false. Never a generic fallback. */
  reason?: string
}

export function intakeUrl(base: string = DEFAULT_WORKBENCH_BASE): string {
  return `${base.replace(/\/+$/, '')}/api/task-from-conversation`
}

/**
 * The request body. `stage` is left to the host default (`requirements`) —
 * the action cuts a card from a conversation, it does not decide the workflow.
 */
export function buildIntakeBody(input: SaveAsTaskInput): { title: string; sessionId: string } {
  return { title: input.title.trim(), sessionId: input.sessionId }
}

/** Client-side guard mirroring the host's `invalid title` refusal. */
export function validateIntake(input: SaveAsTaskInput): string | null {
  if (input.title.trim() === '') return '标题不能为空'
  if (input.sessionId.trim() === '') return '缺少会话上下文,无法建档'
  return null
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Maps a host response (any status) onto {@link SaveAsTaskOutcome}. */
export function parseIntakeResponse(status: number, body: unknown): SaveAsTaskOutcome {
  const payload = (body ?? {}) as Record<string, unknown>

  // The route reports refusals as `{ error }` with a 4xx/5xx status; the
  // wording is already specific ("invalid repo: 需要 repo 或 projectGroup…"),
  // so it is surfaced verbatim rather than replaced.
  if (status < 200 || status >= 300) {
    return { ok: false, reason: str(payload.error) ?? `建档失败(HTTP ${status})` }
  }
  if (payload.ok === false) {
    return { ok: false, reason: str(payload.error) ?? str(payload.reason) ?? '建档失败' }
  }

  const item = (payload.item ?? {}) as Record<string, unknown>
  const summary = (payload.summary ?? item.summary ?? {}) as Record<string, unknown>
  const context = (payload.context ?? {}) as Record<string, unknown>
  const id = str(payload.id) ?? str(item.id)
  if (id === undefined) {
    // A 2xx without an id means the card was NOT created — say so instead of
    // reporting a phantom success.
    return { ok: false, reason: '建档返回缺少卡片 id' }
  }

  const warnings = Array.isArray(payload.warnings)
    ? payload.warnings.filter((w): w is string => typeof w === 'string')
    : []

  return {
    ok: true,
    id,
    stageLabel: str(item.stageLabel) ?? str(item.stage),
    summaryText: str(summary.text),
    summarySource: str(summary.generatedBy),
    contextMessages: typeof context.messages === 'number' ? context.messages : undefined,
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

/**
 * Cuts a card from a conversation. Resolves for both success and refusal —
 * a refusal is an outcome the user must read, not an exception to swallow.
 * Only a transport failure (host unreachable) is turned into a reason string.
 */
export async function saveAsTask(
  input: SaveAsTaskInput,
  options: SaveAsTaskOptions = {},
): Promise<SaveAsTaskOutcome> {
  const invalid = validateIntake(input)
  if (invalid !== null) return { ok: false, reason: invalid }

  const doFetch = options.fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') return { ok: false, reason: '当前环境不支持 fetch,无法建档' }

  try {
    const res = await doFetch(intakeUrl(options.base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildIntakeBody(input)),
    })
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    return parseIntakeResponse(res.status, body)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: `无法连接宿主的建档通道:${message}` }
  }
}
