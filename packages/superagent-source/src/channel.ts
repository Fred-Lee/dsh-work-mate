/**
 * Channel：把 Super-agent 的出站消息写回 `tasks.jsonl`（task 7）。
 *
 * 关键约束（来自审查 CRIT-2 / 事实核查）：
 *   - `OutboundMessage.kind` 只有 ack / reply / notice 三种，**不按文本猜种类**；
 *   - `tasks.jsonl` 是**送达记录**，不是执行状态：`reply` 同时承载 answer/result/attention，
 *     所以"回答过/已完成/待回答"一律从 Ticket 投影读；
 *   - 幂等靠 `messageId`，并且只认 Super-agent 的 32 位十六进制格式。
 */
import type { ChannelRef, Localized, OutboundMessage, SourceKind } from './contract.ts'
import { isValidMessageId } from './validate.ts'
import { appendResult, readResults, readTaskFile, type ResultKind, type TaskRecord } from './files.ts'
import { taskPaths } from './paths.ts'

export interface ChannelOptions {
  taskFile: () => string
  /** 当前任务表的只读快照（由入口层在每轮扫描后更新），用于同步的 `allowed`。 */
  currentTasks: () => readonly TaskRecord[]
  /** 面板深链前缀；不可达时返回空 url。 */
  panelBase?: string
  /** 收到格式非法的 messageId 时调用；入口把它转成健康错误。 */
  onInvalidMessageId?: (value: string) => void
  now?: () => Date
}

const KIND_MAP: Record<OutboundMessage['kind'], ResultKind> = {
  acknowledgement: 'ack',
  reply: 'reply',
  notice: 'notice',
}

const LABEL: Localized = { zh: 'WorkMate 任务', en: 'WorkMate task' }

/** `OutboundMessage.kind` → `tasks.jsonl` 的 kind；固定映射，不读文本。 */
export function resultKindOf(kind: OutboundMessage['kind']): ResultKind {
  return KIND_MAP[kind]
}

/** 从 Channel address 里取 taskId；缺了就无从写回。 */
export function taskIdOf(channel: ChannelRef | undefined): string | undefined {
  const value = channel?.address['taskId']
  return typeof value === 'string' && value !== '' ? value : undefined
}

export function createChannel(options: ChannelOptions): NonNullable<SourceKind['channel']> {
  const now = options.now ?? (() => new Date())

  return {
    allowed(address) {
      const taskId = typeof address['taskId'] === 'string' ? address['taskId'] : ''
      return options.currentTasks().some((task) => task.id === taskId)
    },

    async send(_host, message) {
      const taskId = taskIdOf(message.channel)
      // 没有 taskId 的消息本来源无处可写；返回 gone 让 Super-agent 停止重试。
      if (taskId === undefined) return 'gone'

      // 待办被删除后不再接收——返回 gone 让它丢弃而不是无限重试。
      if (!options.currentTasks().some((task) => task.id === taskId)) {
        const reloaded = await readTaskFile(options.taskFile()).catch(() => undefined)
        if (reloaded === undefined || !reloaded.tasks.some((task) => task.id === taskId)) return 'gone'
      }

      if (!isValidMessageId(message.id)) {
        options.onInvalidMessageId?.(message.id)
        // 拒绝写入，但返回 sent 以避免 Outbox 无限重试一条格式已坏的 id。
        return 'sent'
      }

      const paths = taskPaths(options.taskFile())
      const existing = await readResults(paths.results).catch(() => ({ rows: [], skipped: 0, maxSeq: 0 }))
      const nextSeq = Math.max(0, ...existing.rows.filter((row) => row.taskId === taskId).map((row) => row.seq)) + 1
      await appendResult(paths.results, {
        seq: nextSeq,
        taskId,
        kind: resultKindOf(message.kind),
        messageId: message.id,
        ...(message.ticketId !== undefined && message.ticketId !== '' ? { ticketId: message.ticketId } : {}),
        text: message.text,
        at: now().toISOString(),
      })
      return 'sent'
    },

    link(address) {
      const taskId = typeof address['taskId'] === 'string' ? address['taskId'] : ''
      if (taskId === '' || options.panelBase === undefined || options.panelBase === '') {
        return { url: '', label: LABEL }
      }
      const base = options.panelBase.replace(/\/$/, '')
      return { url: `${base}/?task=${encodeURIComponent(taskId)}`, label: LABEL }
    },
  }
}
