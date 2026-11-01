/**
 * 三份单写者文件（change `adopt-superagent-openspec-source`, task 3）。
 *
 * | 文件 | 写者 | 内容 |
 * | tasks.json   | WorkMate 面板 | 人的意图（原子写，损坏 fail-closed） |
 * | inputs.jsonl | WorkMate 面板 | 人后续的回答（append-only） |
 * | tasks.jsonl  | 本 Source     | 送达记录（append-only，不是执行状态） |
 *
 * 读取端一律容忍 `tasks.jsonl` / `inputs.jsonl` 的撕裂尾行与非法行（忽略并计数），
 * 因为 append-only 文件在进程被杀时必然会出现半行。`tasks.json` 相反：它是整表
 * 原子替换，读到坏 JSON 说明有东西在破坏约定，必须 fail-closed 而不是当成空表。
 */
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export type TaskPriority = 'P0' | 'P1' | 'P2'
export type TaskMode = 'superagent' | 'proposal' | 'record'

export interface TaskRecord {
  id: string
  title: string
  intent: string
  repo: string
  baseBranch: string
  acceptance: string
  priority: TaskPriority
  mode: TaskMode
  dependsOn: string[]
  assigned: boolean
  abandoned: boolean
  attempt: number
  createdBy: string
  proposalId?: string
  ports?: number[]
  createdAt: string
  updatedAt: string
}

export interface TaskFile {
  version: 1
  tasks: TaskRecord[]
}

export interface InputRow {
  seq: number
  taskId: string
  text: string
  by: string
  at: string
  replyTo?: string
}

export type ResultKind = 'ack' | 'reply' | 'notice' | 'error'

export interface ResultRow {
  seq: number
  taskId: string
  kind: ResultKind
  messageId?: string
  /** 该消息属于哪个 Ticket；WorkMate 靠它把任务与 Ticket 对上（不靠标题匹配）。 */
  ticketId?: string
  text: string
  at: string
}

export class TaskFileError extends Error {
  readonly code = 'TASK_FILE_INVALID'
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'TaskFileError'
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asString = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback)
const asBoolean = (value: unknown, fallback = false): boolean => (typeof value === 'boolean' ? value : fallback)
const asNumber = (value: unknown, fallback = 0): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)

const asPriority = (value: unknown): TaskPriority =>
  value === 'P0' || value === 'P1' || value === 'P2' ? value : 'P2'

const asMode = (value: unknown): TaskMode =>
  value === 'superagent' || value === 'proposal' || value === 'record' ? value : 'record'

/** 逐字段归一：缺字段用默认值，坏字段被忽略，未知字段不保留（任务记录是结构化输入）。 */
export function normalizeTask(value: unknown): TaskRecord | undefined {
  if (!isRecord(value)) return undefined
  const id = asString(value['id']).trim()
  if (id === '') return undefined
  return {
    id,
    title: asString(value['title'], id),
    intent: asString(value['intent']),
    repo: asString(value['repo']),
    baseBranch: asString(value['baseBranch'], 'main'),
    acceptance: asString(value['acceptance']),
    priority: asPriority(value['priority']),
    mode: asMode(value['mode']),
    dependsOn: Array.isArray(value['dependsOn'])
      ? value['dependsOn'].filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
      : [],
    assigned: asBoolean(value['assigned']),
    abandoned: asBoolean(value['abandoned']),
    attempt: Math.max(0, Math.trunc(asNumber(value['attempt']))),
    createdBy: asString(value['createdBy'], 'workmate:panel'),
    ...(typeof value['proposalId'] === 'string' && value['proposalId'] !== ''
      ? { proposalId: value['proposalId'] }
      : {}),
    ...(Array.isArray(value['ports'])
      ? { ports: value['ports'].filter((entry): entry is number => typeof entry === 'number' && Number.isInteger(entry)) }
      : {}),
    createdAt: asString(value['createdAt'], ''),
    updatedAt: asString(value['updatedAt'], asString(value['createdAt'], '')),
  }
}

/** 读 `tasks.json`：不存在 → 空表；不是合法 JSON 或结构不对 → `TaskFileError`（fail-closed）。 */
export async function readTaskFile(file: string): Promise<TaskFile> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return { version: 1, tasks: [] }
    throw new TaskFileError(`读取任务文件失败：${file}`, { cause: error })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new TaskFileError(`任务文件不是合法 JSON：${file}`, { cause: error })
  }
  if (!isRecord(parsed) || parsed['version'] !== 1 || !Array.isArray(parsed['tasks'])) {
    throw new TaskFileError(`任务文件结构不受支持（需要 version: 1 + tasks 数组）：${file}`)
  }
  const tasks: TaskRecord[] = []
  for (const entry of parsed['tasks']) {
    const normalized = normalizeTask(entry)
    if (normalized === undefined) {
      throw new TaskFileError(`任务记录缺少 id（${file}）`)
    }
    tasks.push(normalized)
  }
  return { version: 1, tasks }
}

/** 按 id 找一条；重复 id 取第一条（写入端保证唯一，这里不额外抛错）。 */
export function findTask(file: TaskFile, taskId: string): TaskRecord | undefined {
  return file.tasks.find((task) => task.id === taskId)
}

interface JsonlReadResult<T> {
  rows: T[]
  /** 被忽略的行数（撕裂尾行或非法行）。 */
  skipped: number
  /** 文件里出现过的最大 seq。 */
  maxSeq: number
}

function parseJsonl<T>(raw: string, normalize: (value: Record<string, unknown>) => T | undefined): JsonlReadResult<T> {
  const rows: T[] = []
  let skipped = 0
  let maxSeq = 0
  for (const line of raw.split('\n')) {
    const text = line.trim()
    if (text === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      skipped += 1
      continue
    }
    if (!isRecord(parsed)) {
      skipped += 1
      continue
    }
    const normalized = normalize(parsed)
    if (normalized === undefined) {
      skipped += 1
      continue
    }
    rows.push(normalized)
    const seq = (normalized as { seq?: number }).seq
    if (typeof seq === 'number' && seq > maxSeq) maxSeq = seq
  }
  return { rows, skipped, maxSeq }
}

const normalizeInput = (value: Record<string, unknown>): InputRow | undefined => {
  const seq = asNumber(value['seq'], -1)
  const taskId = asString(value['taskId']).trim()
  if (seq < 0 || taskId === '') return undefined
  return {
    seq,
    taskId,
    text: asString(value['text']),
    by: asString(value['by'], 'workmate:panel'),
    at: asString(value['at']),
    ...(typeof value['replyTo'] === 'string' && value['replyTo'] !== '' ? { replyTo: value['replyTo'] } : {}),
  }
}

const normalizeResult = (value: Record<string, unknown>): ResultRow | undefined => {
  const seq = asNumber(value['seq'], -1)
  const taskId = asString(value['taskId']).trim()
  const kind = value['kind']
  if (seq < 0 || taskId === '') return undefined
  if (kind !== 'ack' && kind !== 'reply' && kind !== 'notice' && kind !== 'error') return undefined
  return {
    seq,
    taskId,
    kind,
    ...(typeof value['messageId'] === 'string' && value['messageId'] !== '' ? { messageId: value['messageId'] } : {}),
    ...(typeof value['ticketId'] === 'string' && value['ticketId'] !== '' ? { ticketId: value['ticketId'] } : {}),
    text: asString(value['text']),
    at: asString(value['at']),
  }
}

/** 读 `inputs.jsonl`；不存在视为空。 */
export async function readInputs(file: string): Promise<JsonlReadResult<InputRow>> {
  const raw = await readFile(file, 'utf8').catch((error: unknown) => {
    if ((error as { code?: string }).code === 'ENOENT') return ''
    throw new TaskFileError(`读取人在输入失败：${file}`, { cause: error })
  })
  return parseJsonl(raw, normalizeInput)
}

/** 读 `tasks.jsonl`；不存在视为空。 */
export async function readResults(file: string): Promise<JsonlReadResult<ResultRow>> {
  const raw = await readFile(file, 'utf8').catch((error: unknown) => {
    if ((error as { code?: string }).code === 'ENOENT') return ''
    throw new TaskFileError(`读取送达记录失败：${file}`, { cause: error })
  })
  return parseJsonl(raw, normalizeResult)
}

export interface Unconsumed {
  rows: InputRow[]
  /** true 表示游标大于文件最大 seq（文件被截断/替换），已按"全部重读"处理。 */
  cursorReset: boolean
}

/**
 * 取尚未消费的人输入。游标自愈：`maxSeq < cursor` 说明文件被截断或替换过，
 * 这时回退到全部行（Trigger 的确定性 ID 保证重放不会产生第二张 Ticket）。
 */
export function unconsumedInputs(input: JsonlReadResult<InputRow>, cursor: number): Unconsumed {
  if (input.rows.length === 0) return { rows: [], cursorReset: input.maxSeq !== 0 && cursor > input.maxSeq }
  if (cursor > input.maxSeq) {
    return { rows: input.rows, cursorReset: true }
  }
  return { rows: input.rows.filter((row) => row.seq > cursor), cursorReset: false }
}

/** 追加一行人输入（面板侧使用；本文件里只作为契约夹具的对照实现）。 */
export async function appendInput(file: string, row: Omit<InputRow, 'at'> & { at?: string }): Promise<InputRow> {
  const full: InputRow = { ...row, at: row.at ?? new Date().toISOString() }
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, `${JSON.stringify(full)}\n`, 'utf8')
  return full
}

const DEDUPE_WINDOW = 200

/**
 * 追加一条送达记录。`messageId` 在尾部有界窗口内去重——窗口外的重复视为新行
 * （宁可多展示一行，也不因为要扫全量而阻塞投递）。
 */
export async function appendResult(file: string, row: ResultRow): Promise<{ appended: boolean }> {
  const existing = await readResults(file)
  if (row.messageId !== undefined) {
    const tail = existing.rows.slice(-DEDUPE_WINDOW)
    if (tail.some((entry) => entry.messageId === row.messageId)) return { appended: false }
  }
  // 同一待办内 seq 必须递增：倒退的追加一律拒绝，避免读取端把新行当旧行。
  const maxSeq = Math.max(0, ...existing.rows.filter((entry) => entry.taskId === row.taskId).map((entry) => entry.seq))
  if (row.seq <= maxSeq) return { appended: false }
  await mkdir(dirname(file), { recursive: true })
  await appendFile(file, `${JSON.stringify(row)}\n`, 'utf8')
  return { appended: true }
}

/**
 * 压缩单个待办的送达记录：超过 `maxRowsPerTask` 时保留最近 N 行，
 * 并保证至少留下一条 `ack` 与最后一条 `result`/`error`。只由本 Source 调用（唯一写者）。
 */
export async function compactResults(file: string, maxRowsPerTask = 200): Promise<{ removed: number }> {
  const existing = await readResults(file)
  if (existing.rows.length === 0) return { removed: 0 }
  const byTask = new Map<string, ResultRow[]>()
  for (const row of existing.rows) {
    const list = byTask.get(row.taskId) ?? []
    list.push(row)
    byTask.set(row.taskId, list)
  }
  const kept = new Map<string, ResultRow[]>()
  let removed = 0
  for (const [taskId, rows] of byTask) {
    if (rows.length <= maxRowsPerTask) {
      kept.set(taskId, rows)
      continue
    }
    const tail = rows.slice(-maxRowsPerTask)
    const firstAck = rows.find((row) => row.kind === 'ack')
    if (firstAck !== undefined && !tail.includes(firstAck)) {
      tail[0] = firstAck
      // 保持 seq 顺序：放回时按 seq 排序即可。
      tail.sort((a, b) => a.seq - b.seq)
    }
    const lastOutcome = [...rows].reverse().find((row) => row.kind === 'error' || (row.kind === 'reply' && row.text !== ''))
    if (lastOutcome !== undefined && !tail.includes(lastOutcome)) {
      tail.push(lastOutcome)
      tail.sort((a, b) => a.seq - b.seq)
    }
    removed += rows.length - tail.length
    kept.set(taskId, tail)
  }
  if (removed === 0) return { removed: 0 }
  const ordered = [...kept.values()].flat().sort((a, b) => a.seq - b.seq)
  const tmp = `${file}.tmp`
  await writeFile(tmp, ordered.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
  await rename(tmp, file)
  return { removed }
}
