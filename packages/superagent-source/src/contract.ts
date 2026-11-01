/**
 * Super-agent 的**结构契约**（change `adopt-superagent-openspec-source`, task 2）。
 *
 * 这里不 `import` `@deepseek-ai/dsh-superagent`：它是 private 包、未发布，`SourceKind`
 * 也没有从包根导出。所有类型按它实际的字段形状声明，运行时用 `parseTicket` 之类的
 * 校验函数兜底——对方升级导致字段漂移时，测试先红，而不是在用户机器上静默出错。
 *
 * 事实来源（对照用，勿在此实现其行为）：
 *   - sources/kind.ts      → SourceKind / FieldSpec / EnvironmentInput
 *   - sources/host.ts      → SourceHost / SourceContext
 *   - core/model.ts        → Trigger / Thread / Ticket / Assignment / Execution
 *   - core/ports.ts        → ScopeResult / OutboundMessage
 */

export interface Localized {
  zh: string
  en: string
}

/** 触发者的身份。`source` 是必填——门禁按 `policy.sources[actor.source].allowed` 查人。 */
export interface ActorRef {
  source: string
  id: string
}

export interface ThreadRef {
  source: string
  id: string
}

/** Thread 的写侧地址；`address` 的格式由来源自己定义。 */
export interface ChannelRef {
  source: string
  thread: string
  address: Record<string, string>
}

/** 一条不可变事件。`text` 与 `meta` 是外部数据，不可信。 */
export interface Trigger {
  id: string
  source: string
  /** 第一条是承载 Eval 的主 Thread。 */
  threads: ThreadRef[]
  actor: ActorRef
  human: boolean
  addressed?: 'mention' | 'direct'
  at: string
  text: string
  channel?: ChannelRef
  url?: string
  meta: Record<string, unknown>
}

export interface Thread {
  key: string
  ref: ThreadRef
  createdAt: string
  lastAt?: string
  subscriptions: string[]
  context?: string[]
  meta?: Record<string, unknown>
}

export type AssignmentState = 'pending' | 'running' | 'ended'
export type ReportState = 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped'

export interface Assignment {
  id: string
  state: AssignmentState
  createdAt: string
  startedAt?: string
  endedAt?: string
  report?: { state: ReportState; summary: string; at: string }
}

export interface Attention {
  id: string
  question: string
  triggerId?: string
}

/** Executor 为 Ticket 选定的执行事实：短名与目录。 */
export interface Execution {
  name: string
  directory: string
  assignment: string
}

export type TicketOutcome = 'completed' | 'merged' | 'closed' | 'dropped' | 'stopped'

export interface Ticket {
  id: string
  title: string
  channels: ChannelRef[]
  ended?: { at: string; by: string; outcome: TicketOutcome; reason?: string }
  attention?: Attention
  assignments: Assignment[]
  execution?: Execution
  createdAt: string
  updatedAt: string
  /** 额外字段（mandate/inputs/threads…）：本来源不读，允许存在。 */
  [extra: string]: unknown
}

/** Channel 的出站消息；`kind` 只有三种，`reply` 同时承载 answer/result/attention。 */
export interface OutboundMessage {
  id: string
  channel: ChannelRef
  text: string
  kind: 'acknowledgement' | 'reply' | 'notice'
  ticketId?: string
}

export type ScopeResult = { listened: true; observed: boolean; row?: string } | { listened: false; reason: string }

export interface Health {
  state: 'starting' | 'ready' | 'paused' | 'error'
  detail: string
  at?: string
  code?: string
  values?: Record<string, string>
}

export interface FieldSpec {
  key: string
  label: Localized
  hint?: Localized
  advanced?: true
  type: 'switch' | 'select' | 'number' | 'text' | 'fact' | 'rows'
  readonly?: boolean
  [extra: string]: unknown
}

export interface EnvironmentInput<C> {
  deployment: { repository?: string; [extra: string]: unknown }
  config: C
  trigger?: Trigger
}

export interface VariableSpec {
  key: string
  description: Localized
}

export interface Advice {
  code: string
  [extra: string]: unknown
}

/**
 * Source 插件契约。必填 6 项，可选能力按 Super-agent 实现逐个声明。
 * `schema` 只要求具备 zod 的 `parse`/`safeParse`——运行时是鸭子类型，
 * 但错误类型依赖 `z.ZodError`，所以子包固定 zod 4.x。
 */
export interface SourceKind<C extends Record<string, unknown> = Record<string, unknown>> {
  kind: string
  title: Localized
  description: Localized
  schema: {
    parse(value: unknown): C
    safeParse(value: unknown): { success: true; data: C } | { success: false; error: { issues: Array<{ message?: string }> } }
  }
  fields: FieldSpec[]
  health: string[]
  facts?(deployment: EnvironmentInput<C>['deployment'] | undefined): Record<string, Localized | string>
  scope?(input: { meta: Record<string, unknown> }, config: C): ScopeResult
  channel?: {
    allowed?(address: Record<string, string>, config: C): boolean
    send(host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'>
    link(address: Record<string, string>, links: Record<string, unknown>): { url: string; label: Localized }
  }
  threadContext?: {
    messageId(trigger: Trigger): string
    read(
      commands: unknown,
      trigger: Trigger,
      part: 'thread' | 'root' | 'parent',
      cursor: string | undefined,
      config: C,
    ): Promise<{ messages: ContextMessage[]; next?: string; body: Record<string, unknown>; status?: string }>
    images?(text: string): string[]
  }
  find?(query: string): { threads: string[]; terms: string[] }
  repliesTo?(trigger: Trigger): string | undefined
  policy?: {
    schema: SourceKind['schema']
    fields: FieldSpec[]
    explicit: Localized
    rows?(config: Record<string, unknown>): Array<{
      id: string
      label: Localized | string
      note: Localized
      cells: { listedUnaddressed: boolean; unlistedAddressed: boolean; unlistedUnaddressed: boolean }
    }>
  }
  environment?: {
    variables: readonly VariableSpec[]
    values(input: EnvironmentInput<C>): Record<string, string>
  }
}

/** 有界上下文中的一条消息；`bot` 标记机器写入，永不单独授权。 */
export interface ContextMessage {
  id: string
  from: string
  at: string
  text: string
  bot?: true
  deleted?: true
  reply_to?: string
  url?: string
  path?: string
  line?: number
}

export interface SourceContext {
  readonly deployment: EnvironmentInput<unknown>['deployment']
  readonly ready: Promise<void>
  configured(): boolean
  config<C extends Record<string, unknown>>(kind: string): C | undefined
  receive(trigger: Trigger): { stored: boolean; duplicate?: boolean; filtered?: Advice } | Promise<{ stored: boolean }>
  atomic<T>(work: () => T): T
  state: {
    get<V>(key: unknown): V | undefined
    set<V>(key: unknown, value: V | undefined): void
  }
  threads: {
    get(key: string): Thread | undefined
    subscribed(source: string): Thread[]
    describe(key: string, description: { label?: string; url?: string; facts?: Record<string, unknown> }): void
    patch(key: string, meta: Record<string, unknown>): void
  }
  tickets: {
    get(id: string): Ticket | undefined
    open(): Ticket[]
    bindThread(id: string, thread: ThreadRef, own: boolean): void
    threadClosed(thread: ThreadRef, outcome: 'merged' | 'closed', at: string): void
  }
  triggers: { get(id: string): Trigger | undefined; latest(thread: string): Trigger | undefined }
  notify(message: OutboundMessage): void
  report(entry: string, health: Health): void
  /** prepare 命令的执行环境；`send` 需要它，但本来源只读。 */
  readonly commands?: unknown
}

export interface SourceHost {
  readonly sources: {
    register(kind: SourceKind<Record<string, unknown>>): void
    [extra: string]: unknown
  }
  context(kind: { kind: string; health: readonly string[] }): SourceContext
}

/** 契约字段缺失时的可读错误；消息里带字段路径，便于对着 Super-agent 的升级定位。 */
export class ContractError extends Error {
  readonly code = 'CONTRACT_MISMATCH'
  constructor(message: string) {
    super(message)
    this.name = 'ContractError'
  }
}

/** 本来源在领域里的固定标识。 */
export const SOURCE = 'workmate'

/** Thread key 对所有来源统一是 `${source}:${id}`。 */
export const threadKey = (taskId: string): string => `${SOURCE}:${taskId}`

export const threadRef = (taskId: string): ThreadRef => ({ source: SOURCE, id: taskId })

/** 待办 → Trigger 的确定性 ID；同一 attempt 重复投递得到同一个 ID，由 `receive` 去重。 */
export const triggerId = (taskId: string, attempt: number): string => `${SOURCE}:${taskId}:${attempt}`

/** 人的回答 → Trigger 的确定性 ID（按 `inputs.jsonl` 的 seq）。 */
export const inputTriggerId = (taskId: string, seq: number): string => `${SOURCE}:${taskId}:in:${seq}`

export const channelRef = (taskId: string): ChannelRef => ({
  source: SOURCE,
  thread: taskId,
  address: { taskId },
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const mismatch = (path: string, expected: string): ContractError =>
  new ContractError(`Super-agent 返回的 ${path} 不是 ${expected}`)

const stringAt = (value: unknown, path: string): string =>
  typeof value === 'string' ? value : throwMismatch(path, '字符串')

/** 单独抛出，保证调用处能拿到 `never` 并完成类型窄化。 */
function throwMismatch(path: string, expected: string): never {
  throw mismatch(path, expected)
}

/**
 * 把管理 API 返回的一条 Ticket 读成契约形状。
 * 只校验本来源真正会读的字段；其余原样保留，避免对方新增字段时误报。
 */
export function parseTicket(value: unknown): Ticket {
  if (!isRecord(value)) throwMismatch('ticket', '对象')
  const id = stringAt(value['id'], 'ticket.id')
  const title = stringAt(value['title'] ?? '', 'ticket.title')
  const channels = Array.isArray(value['channels']) ? (value['channels'] as ChannelRef[]) : []
  const assignments = Array.isArray(value['assignments']) ? (value['assignments'] as Assignment[]) : []
  const createdAt = stringAt(value['createdAt'] ?? '', 'ticket.createdAt')
  const updatedAt = stringAt(value['updatedAt'] ?? createdAt, 'ticket.updatedAt')

  const endedRaw = value['ended']
  let ended: Ticket['ended']
  if (endedRaw !== undefined && endedRaw !== null) {
    if (!isRecord(endedRaw)) throwMismatch('ticket.ended', '对象')
    const outcome = stringAt(endedRaw['outcome'], 'ticket.ended.outcome')
    if (!['completed', 'merged', 'closed', 'dropped', 'stopped'].includes(outcome)) {
      throwMismatch('ticket.ended.outcome', 'completed|merged|closed|dropped|stopped')
    }
    ended = {
      at: stringAt(endedRaw['at'] ?? '', 'ticket.ended.at'),
      by: stringAt(endedRaw['by'] ?? '', 'ticket.ended.by'),
      outcome: outcome as TicketOutcome,
      ...(typeof endedRaw['reason'] === 'string' ? { reason: endedRaw['reason'] } : {}),
    }
  }

  const attentionRaw = value['attention']
  let attention: Attention | undefined
  if (attentionRaw !== undefined && attentionRaw !== null) {
    if (!isRecord(attentionRaw)) throwMismatch('ticket.attention', '对象')
    attention = {
      id: stringAt(attentionRaw['id'], 'ticket.attention.id'),
      question: stringAt(attentionRaw['question'], 'ticket.attention.question'),
      ...(typeof attentionRaw['triggerId'] === 'string' ? { triggerId: attentionRaw['triggerId'] } : {}),
    }
  }

  const executionRaw = value['execution']
  let execution: Execution | undefined
  if (executionRaw !== undefined && executionRaw !== null) {
    if (!isRecord(executionRaw)) throwMismatch('ticket.execution', '对象')
    execution = {
      name: stringAt(executionRaw['name'], 'ticket.execution.name'),
      directory: stringAt(executionRaw['directory'], 'ticket.execution.directory'),
      assignment: stringAt(executionRaw['assignment'] ?? '', 'ticket.execution.assignment'),
    }
  }

  // 管理 API 的视图把目录拍平成顶层 `directory`，不是 execution.directory。
  const flatDirectory = typeof value['directory'] === 'string' && value['directory'] !== '' ? value['directory'] : undefined
  const normalized: Execution | undefined = execution ??
    (flatDirectory === undefined ? undefined : { name: '', directory: flatDirectory, assignment: '' })

  return {
    // 未校验的字段原样带走：对方新增字段不应让我们失败，本来源只读自己声明的部分。
    ...value,
    id,
    title,
    channels,
    assignments,
    createdAt,
    updatedAt,
    ...(ended !== undefined ? { ended } : {}),
    ...(attention !== undefined ? { attention } : {}),
    ...(normalized !== undefined && normalized.directory !== '' ? { execution: normalized } : {}),
  }
}
