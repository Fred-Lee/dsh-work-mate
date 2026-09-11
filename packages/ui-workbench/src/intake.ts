/**
 * @helmsman/ui-workbench — 「对话 → 任务卡片」建档通道 (add-task-workitem-model T5.2).
 *
 * Host half of the WorkItem intake:
 *   POST api/task-from-conversation  { title, sessionId?, repo?, projectGroup?, stage?, summary? }
 *   GET  api/sessions                → 最近 DSH 会话门面 (id + title, 供选择器)
 *
 * 分层(与 `ArtifactRegisterLike` / `KnowledgeLike` 同一约定):
 *  - 本模块**只**依赖局部结构接口(BoardServiceLike / SessionsSeamLike /
 *    SessionQueryLike / SummarizerLike),不 import 任何同级插件的实现;
 *  - `helmsman.board` / `sessionQuery` / `sessionTitle` 都是**可选**依赖,由宿主
 *    在请求时经 `ctx.get` 惰性解析传入;board 缺失时抛明确错误(而不是 TypeError);
 *  - 摘要生成隔离且 fail-open:模型/生成器不可用或生成失败时,卡片照建,摘要退化为
 *    `generatedBy: 'fallback'`(最近消息前 ~200 字),绝不因摘要失败丢卡。
 *
 * 会话读取只用宿主已有缝隙:`ctx.get('sessions')`(内存态,同 generator)与
 * `ctx.get('sessionQuery')`(持久化读取,可读已结束会话)。缝隙读不到就降级为空。
 */
import { basename } from 'node:path'
import type { IncomingMessage } from 'node:http'
import { readJson, type MiniRouter, type RouteHandler } from './router.ts'

// ── 模型类型(与 openspec/changes/add-task-workitem-model/specs/task-workitem 对齐) ──

/** 四阶段(展示名见 STAGE_LABELS),顺序即推进方向。 */
export type Stage = 'requirements' | 'spec' | 'dev' | 'done'

export const STAGES: readonly Stage[] = ['requirements', 'spec', 'dev', 'done']

export const STAGE_LABELS: Record<Stage, string> = {
  requirements: '需求分析',
  spec: '规格设计',
  dev: '开发实施',
  done: '验收归档',
}

/** 关联 = 规范化引用 + 展示快照(label),不复制内容(design D3)。 */
export interface BoardAssociation {
  type: string
  refId: string
  label?: string
  /** 关联时间(epoch ms,由 board 落库;这里只在回显时出现)。 */
  at?: number
}

export type SummaryGeneratedBy = 'model' | 'manual' | 'fallback'

/** 摘要(design D4):board 只存不生成,生成在宿主。 */
export interface BoardSummary {
  text: string
  generatedBy: SummaryGeneratedBy
  /** 来源对话类型:`dsh`(本项目只有 DSH 会话可读)。 */
  source?: string
  /** 摘要写入时间(epoch ms) —— board 侧为权威值,服务会自行盖章。 */
  at?: number
}

export interface BoardRepoScope {
  baseRepo?: string
  projectGroup?: string
}

/** WorkItem 的最小结构面(未知字段原样透传;`: number` 与 board 模型一致 = epoch ms)。 */
export interface BoardWorkItemLike {
  id: string
  title?: string
  summary?: BoardSummary | null
  stage?: Stage
  repoScope?: BoardRepoScope
  associations?: BoardAssociation[]
  createdAt?: number
  updatedAt?: number
  [key: string]: unknown
}

/**
 * `board.create` 入参:仓库标识是 board 的硬要求(`baseRepo` 或 `projectGroup`
 * 至少一个),`associations` 是本宿主的**尽力而为**字段(不实现它的版本会忽略,
 * 关联随后由 `associate()` 落库)。
 */
export interface BoardCreateInput {
  title: string
  repoScope: BoardRepoScope
  summary?: BoardSummary
  stage?: Stage
  associations?: BoardAssociation[]
  [key: string]: unknown
}

/**
 * `helmsman.board` 的局部结构接口 —— 除 `create` 外都是可选:board 的实现细节
 * (create 是否落 associations,以及各写方法返回的卡片快照)不在本包控制内,
 * 宿主按能力探测并对返回的卡片做归一化。
 */
export interface BoardServiceLike {
  create(input: BoardCreateInput): Promise<BoardWorkItemLike>
  update?(itemId: string, patch: Record<string, unknown>): Promise<BoardWorkItemLike | undefined | null>
  get?(itemId: string): Promise<BoardWorkItemLike | undefined | null>
  list?(): Promise<BoardWorkItemLike[]>
  advance?(itemId: string, to?: Stage): Promise<unknown>
  associate?(itemId: string, association: BoardAssociation): Promise<BoardWorkItemLike | undefined | null>
  setSummary?(itemId: string, summary: BoardSummary): Promise<BoardWorkItemLike | undefined | null>
}

// ── 会话缝隙(不新增会话 API,只用宿主已有通道) ─────────────────────────────

export interface ConversationMessage {
  role: 'user' | 'assistant'
  text: string
}

/** `ctx.get('sessions')`:内存态 SessionStore —— 只需要 `get(id)`(活会话有 seq/eventAt)。 */
export interface LiveSessionLike {
  seq?: number
  header?: { cwd?: string }
  eventAt?(seq: number): unknown
}

export interface SessionsSeamLike {
  get?(sessionId: string): unknown
  list?(): unknown
}

export interface SessionRecordLike {
  header?: { id?: string; createdAt?: number; cwd?: string }
  live?: boolean
  persisted?: boolean
}

/** `ctx.get('sessionQuery')`:持久化/活会话统一读取面。 */
export interface SessionQueryLike {
  listSessions?(): Promise<SessionRecordLike[]>
  readSession?(sessionId: string): Promise<{ events?: unknown[] }>
}

/** `ctx.get('sessionTitle')`:标题服务只接受活会话对象。 */
export interface SessionTitleLike {
  get?(session: unknown): { title?: string } | undefined
}

/** 摘要生成缝隙:`helmsman.generator` 的 `summarize`(本地发电机,非同级插件)。 */
export interface SummarizerLike {
  summarize?(request: { title?: string; text: string }): Promise<{ status?: string; text?: string; error?: string }>
}

export interface RecentSession {
  id: string
  title: string
  createdAt?: number
  live?: boolean
}

/** 惰性依赖集合 —— 每次请求解析(可选依赖必须运行时再 `ctx.get`)。 */
export interface IntakeDeps {
  board: () => BoardServiceLike | undefined
  sessions?: () => SessionsSeamLike | undefined
  sessionQuery?: () => SessionQueryLike | undefined
  sessionTitle?: () => SessionTitleLike | undefined
  summarizer?: () => SummarizerLike | undefined
  /** 便于测试注入的时钟(epoch ms)。@default () => Date.now() */
  now?: () => number
}

// ── 常量 ────────────────────────────────────────────────────────────────────

/** 建模时喂给模型的对话尾部长度上限(字符)。 */
const SUMMARY_INPUT_CHARS = 6000
/** 建档时读取的对话消息条数上限(取最近 N 条)。 */
const MAX_CONTEXT_MESSAGES = 40
/** 退化摘要长度(「最近消息前 ~200 字」)。 */
const FALLBACK_SUMMARY_CHARS = 200
/** 摘要行数上限(2–4 行契约)。 */
const MAX_SUMMARY_LINES = 4
/** 会话门面默认/最多返回条数。 */
const DEFAULT_SESSION_LIMIT = 20
const MAX_SESSION_LIMIT = 100
/** 活会话事件扫描窗口(内存态,避免超长会话全量扫描)。 */
const LIVE_SCAN_WINDOW = 400

// ── 建档 ────────────────────────────────────────────────────────────────────

export interface SaveTaskResult {
  ok: true
  item: BoardWorkItemLike
  id: string
  stage: Stage
  summary: BoardSummary
  associations: BoardAssociation[]
  /** 已读到的来源对话上下文条数(0 = 缝隙不可用或空会话)。 */
  context: { messages: number; source: 'sessions' | 'sessionQuery' | 'none' }
  /** 非致命问题(关联/摘要回写失败等),卡片已建成。 */
  warnings: string[]
}

/**
 * 「会话 → 任务卡片」建档:读会话最近消息 → 生成 2–4 行中文摘要(失败退化)→
 * `helmsman.board.create` → 关联来源会话 → 返回可打开的卡片。
 */
export async function saveTaskFromConversation(
  deps: IntakeDeps,
  body: Record<string, unknown>,
): Promise<SaveTaskResult> {
  const title = typeof body.title === 'string' ? body.title.trim() : ''
  if (title === '') throw new Error('invalid title: 需要非空标题')

  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
  const stage = parseStage(body.stage)
  const manualSummary = typeof body.summary === 'string' ? body.summary.trim() : ''
  const at = deps.now?.() ?? Date.now()

  // 1. 卡片必须落在 board 上;插件缺失时给明确信息,而不是 TypeError。
  //    (放在读取会话/生成摘要之前:失败要快,也不该为此消耗一次模型调用。)
  const board = deps.board()
  if (!board) {
    throw new Error(
      '任务工作项服务不可用:未安装 @helmsman/board 插件(helmsman.board),无法建立任务卡片',
    )
  }

  // 2. 来源对话的最近消息(缝隙不可用/会话为空 → 空上下文,不阻塞建档)。
  const context = sessionId === ''
    ? { messages: [] as ConversationMessage[], source: 'none' as const }
    : await readRecentMessages(deps, sessionId)

  // 3. 仓库标识是 board 的硬要求:请求体 → 来源会话的 cwd → 明确报错。
  const repoScope = parseRepoScope(body.repo, body.projectGroup) ?? await sessionRepoScope(deps, sessionId)
  if (repoScope === undefined) {
    throw new Error('invalid repo: 需要 repo 或 projectGroup(或提供能解析出 cwd 的 sessionId)')
  }

  // 4. 摘要:手动 > 模型 > 退化(生成隔离 + fail-open)。
  const summary: BoardSummary = manualSummary !== ''
    ? { text: manualSummary, generatedBy: 'manual', ...(sessionId !== '' ? { source: 'dsh' } : {}), at }
    : await summarizeConversation(deps, { title, sessionId, messages: context.messages, at })

  // 关联 = 引用 + label 快照(design D3);`at` 由 board 落库时盖章。
  const conversationAssociation: BoardAssociation | undefined = sessionId === ''
    ? undefined
    : { type: 'conversation', refId: sessionId, label: title }

  // 5. create 带上摘要/阶段/仓库(关联是尽力而为字段,不实现它的版本会忽略)。
  let item = await board.create({
    title,
    repoScope,
    summary,
    stage,
    ...(conversationAssociation !== undefined ? { associations: [conversationAssociation] } : {}),
  })
  const id = typeof item?.id === 'string' && item.id !== '' ? item.id : ''
  if (id === '') throw new Error('board.create 未返回卡片 id')

  const warnings: string[] = []
  // 关联回写:create 未落 conversation 引用时补一次(不重复添加)。
  if (conversationAssociation !== undefined && !hasAssociation(item.associations, conversationAssociation)) {
    if (board.associate) {
      try {
        const updated = await board.associate(id, conversationAssociation)
        if (isWorkItem(updated)) item = updated
      } catch (err) {
        warnings.push(`会话关联写入失败: ${messageOf(err)}`)
      }
    } else {
      warnings.push('board 服务不支持 associate:来源会话未写入关联集')
    }
  }
  // 摘要回写:create 未落摘要时补一次(卡片仍可浏览)。
  if (!hasSummary(item.summary, summary.text) && board.setSummary) {
    try {
      const updated = await board.setSummary(id, summary)
      if (isWorkItem(updated)) item = updated
    } catch (err) {
      warnings.push(`摘要写入失败: ${messageOf(err)}`)
    }
  }

  const resolvedStage = ((item.stage ?? stage) as Stage)
  const resolvedSummary = isSummary(item.summary) ? item.summary : summary
  const associations = Array.isArray(item.associations)
    ? item.associations
    : conversationAssociation !== undefined
      ? [conversationAssociation]
      : []
  return {
    ok: true,
    item: { ...item, id, stage: resolvedStage, summary: resolvedSummary, associations },
    id,
    stage: resolvedStage,
    summary: resolvedSummary,
    associations,
    context: { messages: context.messages.length, source: context.source },
    warnings,
  }
}

/** 卡片快照守卫:board 的写方法返回更新后的 WorkItem,桩实现可能返回空。 */
function isWorkItem(value: BoardWorkItemLike | undefined | null): value is BoardWorkItemLike {
  return value !== undefined && value !== null && typeof value === 'object'
    && typeof (value as BoardWorkItemLike).id === 'string'
}

function isSummary(value: unknown): value is BoardSummary {
  return typeof (value as BoardSummary | undefined)?.text === 'string'
}

function parseStage(raw: unknown): Stage {
  if (raw === undefined || raw === null || raw === '') return 'requirements'
  if (typeof raw === 'string' && (STAGES as readonly string[]).includes(raw)) return raw as Stage
  throw new Error(`invalid stage: ${String(raw)}(可选 ${STAGES.join(' | ')})`)
}

function parseRepoScope(repo: unknown, projectGroup: unknown): BoardRepoScope | undefined {
  const baseRepo = typeof repo === 'string' && repo.trim() !== '' ? repo.trim() : undefined
  const group = typeof projectGroup === 'string' && projectGroup.trim() !== '' ? projectGroup.trim() : undefined
  if (baseRepo === undefined && group === undefined) return undefined
  return { ...(baseRepo !== undefined ? { baseRepo } : {}), ...(group !== undefined ? { projectGroup: group } : {}) }
}

function hasAssociation(list: BoardAssociation[] | undefined, wanted: BoardAssociation): boolean {
  if (!Array.isArray(list)) return false
  return list.some((a) => a?.type === wanted.type && a?.refId === wanted.refId)
}

function hasSummary(summary: BoardSummary | null | undefined, text: string): boolean {
  return typeof summary?.text === 'string' && summary.text === text
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ── 摘要 ────────────────────────────────────────────────────────────────────

/** 摘要提示词:2–4 行中文,不要列表符号,不要客套。 */
export function buildSummaryPrompt(title: string, text: string): string {
  const lines = [
    '请阅读下面这次开发对话的最近消息,并用中文 2 到 4 行总结:对话主题、当前的进展/结论、以及下一步。',
    '要求:直接输出摘要正文,不要标题、不要列表符号、不要客套话,每行一个要点。',
  ]
  if (title !== '') lines.push(`卡片标题(供参考): ${title}`)
  lines.push('', '对话内容:', text)
  return lines.join('\n')
}

/**
 * 生成摘要。任何失败(生成器缺失、抛错、空输出)→ 退化摘要,调用方不会因此丢卡。
 */
async function summarizeConversation(
  deps: IntakeDeps,
  opts: { title: string; sessionId: string; messages: ConversationMessage[]; at: number },
): Promise<BoardSummary> {
  const source = opts.sessionId !== '' ? 'dsh' : undefined
  const fallback = (): BoardSummary => ({
    text: fallbackSummaryText(opts.messages, { title: opts.title, sessionId: opts.sessionId }),
    generatedBy: 'fallback',
    ...(source !== undefined ? { source } : {}),
    at: opts.at,
  })
  const summarizer = deps.summarizer?.()
  if (!summarizer?.summarize) return fallback()
  const text = conversationText(opts.messages)
  if (text === '') return fallback()
  try {
    const result = await summarizer.summarize({ title: opts.title, text })
    if (result?.status !== undefined && result.status !== 'completed') {
      console.warn(`[helmsman/ui-workbench] summary generation failed (${result.error ?? result.status}); using fallback`)
      return fallback()
    }
    const cleaned = normalizeSummary(result.text ?? '')
    if (cleaned === '') return fallback()
    return { text: cleaned, generatedBy: 'model', ...(source !== undefined ? { source } : {}), at: opts.at }
  } catch (err) {
    console.warn(`[helmsman/ui-workbench] summary generation threw (${messageOf(err)}); using fallback`)
    return fallback()
  }
}

/** 事件流 → 提示词文本(最近消息,带上限截断)。 */
export function conversationText(messages: ConversationMessage[]): string {
  const parts: string[] = []
  let chars = 0
  for (let i = messages.length - 1; i >= 0 && chars < SUMMARY_INPUT_CHARS; i--) {
    const m = messages[i]!
    const line = `${m.role === 'user' ? '用户' : '助手'}: ${collapse(m.text)}`
    parts.unshift(line)
    chars += line.length
  }
  return parts.join('\n')
}

/**
 * 退化摘要:最近消息前 ~200 字(从最新往回凑够长度后按时间正序拼接)。
 * 读不到任何消息时给出可继续编辑的占位文本。
 */
export function fallbackSummaryText(
  messages: ConversationMessage[],
  opts: { title: string; sessionId?: string },
): string {
  const parts: string[] = []
  let chars = 0
  for (let i = messages.length - 1; i >= 0 && chars < FALLBACK_SUMMARY_CHARS; i--) {
    const m = messages[i]!
    const line = `${m.role === 'user' ? '用户' : '助手'}: ${collapse(m.text)}`
    parts.unshift(line)
    chars += line.length
  }
  const joined = parts.join('\n').trim()
  if (joined === '') {
    return `${opts.title} —— 由对话建档,未读取到会话内容,摘要待补充。`
  }
  return joined.length > FALLBACK_SUMMARY_CHARS ? `${joined.slice(0, FALLBACK_SUMMARY_CHARS)}…` : joined
}

/** 折叠到 2–4 行:去掉列表符号与空行,最多 4 行。 */
export function normalizeSummary(raw: string): string {
  const lines = raw
    .split('\n')
    .map((line) => line.trim().replace(/^[-*•·]\s*/, '').replace(/^\d+[.、)]\s*/, '').replace(/^#{1,6}\s*/, ''))
    .filter((line) => line !== '')
  return lines.slice(0, MAX_SUMMARY_LINES).join('\n').slice(0, 600)
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

// ── 会话读取 ────────────────────────────────────────────────────────────────

/**
 * 仓库标识回退:board 要求 `baseRepo`/`projectGroup` 至少一个,而调用方可能只给了
 * `sessionId` —— 这时用该会话的 cwd 作为 `baseRepo`(DSH 会话的工作目录通常就是
 * 目标仓库)。仍然解析不到 → undefined,由调用方抛明确错误。
 */
export async function sessionRepoScope(
  deps: IntakeDeps,
  sessionId: string,
): Promise<BoardRepoScope | undefined> {
  if (sessionId === '') return undefined
  const live = liveSessionFrom(deps, sessionId)
  const liveCwd = typeof live?.header?.cwd === 'string' ? live.header.cwd.trim() : ''
  if (liveCwd !== '') return { baseRepo: liveCwd }
  const query = deps.sessionQuery?.()
  if (query?.listSessions) {
    try {
      const records = await query.listSessions()
      const record = Array.isArray(records) ? records.find((r) => r?.header?.id === sessionId) : undefined
      const cwd = typeof record?.header?.cwd === 'string' ? record.header.cwd.trim() : ''
      if (cwd !== '') return { baseRepo: cwd }
    } catch (err) {
      console.warn(`[helmsman/ui-workbench] session cwd lookup failed (${messageOf(err)})`)
    }
  }
  return undefined
}

/**
 * 读某会话的最近消息。只用宿主已有缝隙:活会话(`sessions.get` + `eventAt`)优先,
 * 其次持久化读取(`sessionQuery.readSession`);都不可用 → 空上下文。
 */
export async function readRecentMessages(
  deps: IntakeDeps,
  sessionId: string,
  limit = MAX_CONTEXT_MESSAGES,
): Promise<{ messages: ConversationMessage[]; source: 'sessions' | 'sessionQuery' | 'none' }> {
  const live = liveSessionFrom(deps, sessionId)
  if (live !== undefined) {
    const events = eventsFromLive(live)
    if (events.length > 0) return { messages: messagesFromEvents(events, limit), source: 'sessions' }
  }
  const query = deps.sessionQuery?.()
  if (query?.readSession) {
    try {
      const snapshot = await query.readSession(sessionId)
      const events = Array.isArray(snapshot?.events) ? snapshot.events : []
      if (events.length > 0) return { messages: messagesFromEvents(events, limit), source: 'sessionQuery' }
    } catch (err) {
      console.warn(`[helmsman/ui-workbench] session transcript unavailable (${messageOf(err)}); continuing without context`)
    }
  }
  return { messages: [], source: 'none' }
}

/** 活会话的尾部事件(内存态;从后往前取到上限即停)。 */
function eventsFromLive(live: LiveSessionLike, window = LIVE_SCAN_WINDOW): unknown[] {
  if (typeof live.eventAt !== 'function') return []
  const length = Number(live.seq)
  if (!Number.isFinite(length) || length <= 0) return []
  const out: unknown[] = []
  const from = Math.max(0, length - window)
  // 从尾部往前读:最近的消息在最后,凑够条数即可(顺序由调用方反转恢复)。
  for (let seq = length - 1; seq >= from; seq--) {
    const event = live.eventAt(seq)
    if (event !== undefined) out.push(event)
  }
  return out.reverse()
}

/** 事件数组(时间正序)→ 最近 `limit` 条对话消息。 */
function messagesFromEvents(events: unknown[], limit: number): ConversationMessage[] {
  const messages: ConversationMessage[] = []
  for (let i = events.length - 1; i >= 0 && messages.length < limit; i--) {
    const message = messageFromEvent(events[i])
    if (message !== undefined) messages.unshift(message)
  }
  return messages
}

/** 单条事件 → 对话消息(只取人写的用户消息与助手的文本回复)。 */
function messageFromEvent(event: unknown): ConversationMessage | undefined {
  const e = event as { type?: unknown; data?: any } | undefined
  if (e === undefined || typeof e.type !== 'string') return undefined
  if (e.type === 'assistant/message') {
    const text = blocksText(e.data?.message?.content)
    return text === '' ? undefined : { role: 'assistant', text }
  }
  if (e.type === 'user/message') {
    // 工具结果消息的 role 也是 user —— 只保留真正来自人的消息。
    const sourceKind = e.data?.source?.kind
    if (typeof sourceKind === 'string' && sourceKind !== 'user') return undefined
    const text = blocksText(e.data?.content)
    return text === '' ? undefined : { role: 'user', text }
  }
  return undefined
}

function blocksText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((b): b is { type: string; text: string } =>
      typeof (b as { type?: unknown })?.type === 'string'
      && (b as { type: string }).type === 'text'
      && typeof (b as { text?: unknown }).text === 'string')
    .map((b) => b.text)
    .join('')
    .trim()
}

// ── 会话门面 ────────────────────────────────────────────────────────────────

/**
 * 最近 DSH 会话门面(id + title),供「从会话建档」选择器使用。
 * 缝隙不可用 → 空列表 + `available: false`(UI 显示提示而不是报错)。
 */
export async function getRecentSessions(
  deps: IntakeDeps,
  limit = DEFAULT_SESSION_LIMIT,
): Promise<{ sessions: RecentSession[]; available: boolean }> {
  const query = deps.sessionQuery?.()
  const seam = deps.sessions?.()
  if (!query?.listSessions && !seam?.list) return { sessions: [], available: false }
  let records: SessionRecordLike[]
  try {
    if (query?.listSessions) {
      const listed = await query.listSessions()
      records = Array.isArray(listed) ? listed : []
    } else {
      const listed = seam?.list?.()
      records = Array.isArray(listed) ? (listed as SessionRecordLike[]) : []
    }
  } catch (err) {
    console.warn(`[helmsman/ui-workbench] recent sessions unavailable (${messageOf(err)})`)
    return { sessions: [], available: false }
  }
  const sessions: RecentSession[] = []
  for (const record of records) {
    const id = typeof record?.header?.id === 'string' && record.header.id !== '' ? record.header.id : ''
    if (id === '') continue
    const createdAt = typeof record?.header?.createdAt === 'number' ? record.header.createdAt : undefined
    sessions.push({
      id,
      title: sessionTitleOf(deps, id, record),
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(record?.live === true ? { live: true } : {}),
    })
  }
  sessions.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  const capped = Math.max(1, Math.min(limit, MAX_SESSION_LIMIT))
  return { sessions: sessions.slice(0, capped), available: true }
}

/** 标题尽力而为:sessionTitle 快照 → 会话首条用户消息 → 会话 id。 */
function sessionTitleOf(deps: IntakeDeps, id: string, record: SessionRecordLike): string {
  const live = liveSessionFrom(deps, id)
  if (live !== undefined) {
    try {
      const snapshot = deps.sessionTitle?.()?.get?.(live)
      if (typeof snapshot?.title === 'string' && snapshot.title.trim() !== '') return snapshot.title.trim()
    } catch {
      // 标题服务失败不影响门面
    }
    const firstUser = firstUserTextFromLive(live)
    if (firstUser !== '') return firstUser.slice(0, 60)
  }
  const cwd = record?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? `${basename(cwd)} · ${id.slice(0, 12)}` : id
}

/** 活会话的首条用户消息(从头部起有限扫描)。 */
function firstUserTextFromLive(live: LiveSessionLike, window = LIVE_SCAN_WINDOW): string {
  if (typeof live.eventAt !== 'function') return ''
  const length = Number(live.seq)
  if (!Number.isFinite(length) || length <= 0) return ''
  const to = Math.min(length, window)
  for (let seq = 0; seq < to; seq++) {
    const message = messageFromEvent(live.eventAt(seq))
    if (message?.role === 'user') return message.text
  }
  return ''
}

/** `sessions.get(id)` → 活会话(缺失/异常一律 undefined)。 */
function liveSessionFrom(deps: IntakeDeps, sessionId: string): LiveSessionLike | undefined {
  const seam = deps.sessions?.()
  if (!seam?.get) return undefined
  try {
    const session = seam.get(sessionId)
    if (session === undefined || session === null || typeof session !== 'object') return undefined
    return session as LiveSessionLike
  } catch {
    return undefined
  }
}

// ── 路由注册 ────────────────────────────────────────────────────────────────

/**
 * 把建档通道挂到宿主路由上(与既有 REST 面同一 MiniRouter 约定)。
 * 只新增路由,不改动任何既有端点。
 */
export function registerIntakeRoutes(router: MiniRouter, deps: IntakeDeps): void {
  const createTask: RouteHandler = async (params, query, req: IncomingMessage) =>
    saveTaskFromConversation(deps, await readJson(req))

  const sessions: RouteHandler = async (params, query) => {
    const raw = Number(query.get('limit'))
    const limit = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_SESSION_LIMIT
    return getRecentSessions(deps, limit)
  }

  router.add('POST', '/api/task-from-conversation', createTask)
  router.add('GET', '/api/sessions', sessions)
}
