/**
 * 有界上下文读取（change `adopt-superagent-openspec-source`, task 7）。
 *
 * `thread` 分页读人的消息与送达记录；`root` 读原始意图（并在关联提案时附上
 * OpenSpec 工件摘录）；`parent` 读被回复的那条。
 *
 * 机器写入的行一律标 `bot: true`：它们能提供上下文，但永远不能单独授权新工作。
 * 工件摘录带 `path`/`line`、有字符上限、超出部分给续读游标（Inline & Spill）。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ContextMessage, Trigger } from './contract.ts'
import type { InputRow, ResultRow, TaskRecord } from './files.ts'
import { taskPaths } from './paths.ts'
import { readInputs, readResults, readTaskFile } from './files.ts'
import { resolveChangeDir } from './validate.ts'

export interface ContextOptions {
  taskFile: () => string
  /** OpenSpec 工件读取根：`<repoRoot>/<openspecRoot>/changes`；未配置时为 undefined（不读盘）。 */
  changesRoot: () => string | undefined
  /** 每个工件的字符上限。 */
  artifactChars?: number
  /** `thread` 每页条数。 */
  pageSize?: number
}

export interface ContextPart {
  messages: ContextMessage[]
  next?: string
  body: Record<string, unknown>
  status?: string
}

const ARTIFACT_FILES = ['proposal.md', 'design.md', 'tasks.md'] as const
const DEFAULT_ARTIFACT_CHARS = 4000
const DEFAULT_PAGE = 20

const messageOf = (row: InputRow): ContextMessage => ({
  id: `in:${row.seq}`,
  from: row.by,
  at: row.at,
  text: row.text,
  ...(row.replyTo !== undefined ? { reply_to: row.replyTo } : {}),
})

const resultMessageOf = (row: ResultRow): ContextMessage => ({
  id: `out:${row.seq}`,
  from: 'superagent',
  at: row.at,
  text: row.text,
  bot: true,
})

/** 把工件切成带行号的片段；超出上限时给出续读入口。 */
export function artifactMessages(
  content: string,
  path: string,
  limit: number,
  offset = 0,
): { messages: ContextMessage[]; truncated: boolean; totalChars: number } {
  const slice = content.slice(offset, offset + limit)
  const truncated = offset + limit < content.length
  const startLine = content.slice(0, offset).split('\n').length
  const messages: ContextMessage[] = slice
    .split('\n')
    .map((line, index) => ({ line, number: startLine + index }))
    .filter((entry) => entry.line.trim() !== '')
    .map((entry) => ({
      id: `${path}:${entry.number}`,
      from: 'openspec',
      at: '',
      text: entry.line,
      bot: true,
      path,
      line: entry.number,
    }))
  return { messages, truncated, totalChars: content.length }
}

export const threadContextOf = (options: ContextOptions): NonNullable<{
  messageId(trigger: Trigger): string
  read(
    commands: unknown,
    trigger: Trigger,
    part: 'thread' | 'root' | 'parent',
    cursor: string | undefined,
    config: unknown,
  ): Promise<ContextPart>
}> => {
  const pageSize = options.pageSize ?? DEFAULT_PAGE
  const limit = options.artifactChars ?? DEFAULT_ARTIFACT_CHARS

  const taskOf = async (trigger: Trigger): Promise<TaskRecord | undefined> => {
    const file = await readTaskFile(options.taskFile()).catch(() => undefined)
    if (file === undefined) return undefined
    return file.tasks.find((task) => task.id === trigger.threads[0]?.id)
  }

  return {
    messageId(trigger) {
      return trigger.id
    },

    async read(_commands, trigger, part, cursor) {
      const taskId = trigger.threads[0]?.id ?? ''
      const paths = taskPaths(options.taskFile())
      const task = await taskOf(trigger)
      const body: Record<string, unknown> = {
        taskId,
        title: task?.title ?? '',
        repo: task?.repo ?? '',
        baseBranch: task?.baseBranch ?? '',
        priority: task?.priority ?? '',
      }

      if (part === 'root') {
        const messages: ContextMessage[] = []
        if (task !== undefined) {
          messages.push({
            id: `intent:${task.id}`,
            from: task.createdBy,
            at: task.createdAt,
            text: task.intent,
          })
          if (task.acceptance !== '') {
            messages.push({
              id: `acceptance:${task.id}`,
              from: task.createdBy,
              at: task.createdAt,
              text: `验收标准：${task.acceptance}`,
              bot: true,
            })
          }
        }
        const root = options.changesRoot()
        const proposalId = task?.proposalId
        if (root !== undefined && proposalId !== undefined) {
          const dir = resolveChangeDir(root, proposalId)
          if (dir !== undefined) {
            for (const name of ARTIFACT_FILES) {
              const content = await readFile(join(dir, name), 'utf8').catch(() => undefined)
              if (content === undefined) continue
              // cursor 形如 `<file>:<offset>`：只对指定文件按偏移续读。
              const requested = cursor?.startsWith(`${name}:`) === true ? Number(cursor.slice(name.length + 1)) : 0
              const offset = Number.isFinite(requested) && requested >= 0 ? requested : 0
              const slice = artifactMessages(content, `${proposalId}/${name}`, limit, offset)
              messages.push(...slice.messages)
              if (slice.truncated) {
                return {
                  messages,
                  next: `${name}:${offset + limit}`,
                  body,
                  status: 'truncated',
                }
              }
            }
          }
        }
        return { messages, body }
      }

      const [inputs, results] = await Promise.all([
        readInputs(paths.inputs).catch(() => ({ rows: [], skipped: 0, maxSeq: 0 })),
        readResults(paths.results).catch(() => ({ rows: [], skipped: 0, maxSeq: 0 })),
      ])
      const mine = inputs.rows.filter((row) => row.taskId === taskId)
      const outs = results.rows.filter((row) => row.taskId === taskId)

      if (part === 'parent') {
        const replyTo = typeof trigger.meta['replyTo'] === 'string' ? trigger.meta['replyTo'] : undefined
        if (replyTo === undefined) return { messages: [], body, status: 'no-parent' }
        const target = mine.find((row) => `in:${row.seq}` === replyTo)
        if (target === undefined) {
          const out = outs.find((row) => `out:${row.seq}` === replyTo)
          return out === undefined
            ? { messages: [], body, status: 'gone' }
            : { messages: [resultMessageOf(out)], body }
        }
        return { messages: [messageOf(target)], body }
      }

      // thread：人的消息与送达记录按时间合并，最新的 pageSize 条 + 向前翻页游标。
      const merged = [...mine.map(messageOf), ...outs.map(resultMessageOf)].sort((left, right) =>
        left.at.localeCompare(right.at) || left.id.localeCompare(right.id),
      )
      const end = cursor !== undefined ? Number(cursor) : merged.length
      const safeEnd = Number.isFinite(end) && end > 0 ? Math.min(end, merged.length) : merged.length
      const start = Math.max(0, safeEnd - pageSize)
      return {
        messages: merged.slice(start, safeEnd),
        ...(start > 0 ? { next: String(start) } : {}),
        body,
      }
    },
  }
}
