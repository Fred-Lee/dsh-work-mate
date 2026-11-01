/**
 * 插件入口（change `adopt-superagent-openspec-source`, task 8）。
 *
 * 只做三件事：注册 kind、按 `pollSeconds` 跑扫描、把结果写成健康条目。
 *
 * 模块级 `inject = ['orchestrator']` 是**刻意的**：这个包存在的唯一理由就是跑在
 * Super-agent 的进程里；装到没有它的 profile 时保持等待，是准确的自我描述。
 */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SourceHost, SourceKind, SourceContext, Ticket } from './contract.ts'
import { createChannel } from './channel.ts'
import { threadContextOf } from './context.ts'
import { compactResults, readInputs, readResults, readTaskFile, type TaskRecord } from './files.ts'
import {
  DESCRIPTION,
  FIELDS,
  HEALTH_ENTRY,
  KIND,
  TITLE,
  factsOf,
  validateConfig,
  workmateConfigSchema,
  type WorkmateConfig,
} from './kind.ts'
import { taskPaths } from './paths.ts'
import { healthSummaryOf, scanOnce } from './watch.ts'
import { VARIABLES, environmentValues } from './environment.ts'
import { messageIdIssue } from './validate.ts'

export const name = 'workmate-superagent-source'
export const inject = ['orchestrator'] as const

/**
 * 游标与待办→Ticket 映射都存在 Source 自己的 state 里，不回写面板独占的文件。
 * 键必须是字符串（宿主的 KV 是 SQLite TEXT 列，见 `contract.ts` 的 state 注释）。
 */
const STATE_PREFIX = 'workmate-source:'
const CURSOR_KEY = `${STATE_PREFIX}cursor`
const TICKET_KEY = `${STATE_PREFIX}tickets`

type TicketMap = Record<string, string>

const ticketMapOf = (source: SourceContext): TicketMap => source.state.get<TicketMap>(TICKET_KEY) ?? {}

/** 用 Thread 反查 Ticket：本来源的 Trigger 都带 `meta.taskId`，Channel address 同源。 */
function ticketIdFor(tickets: readonly Ticket[], taskId: string): string | undefined {
  return tickets.find((ticket) => ticket.channels.some((channel) => channel.address['taskId'] === taskId))?.id
}

export function apply(ctx: Context): void {
  const orchestrator = (ctx as unknown as { orchestrator?: SourceHost }).orchestrator
  if (orchestrator === undefined) return

  // 顺序是硬的：**先注册 kind，再取 context**。宿主的 `SourceContext.report` 在构造时
  // 就把 `kind.health` 解析成句柄表（`sourceContextOf`），注册前取到的是一张空表，
  // 之后所有 report 都会被静默丢弃——健康条目会永远停在注册时的 `starting`。
  ctx.effect(() => {
    let cachedTasks: TaskRecord[] = []
    let disposed = false
    let nextScanAt = 0
    let running = false
    // 由第二个 effect 赋值；host 调这些回调时必然已经注册并赋过值。
    let source!: SourceContext

    const rawConfig = (): Record<string, unknown> => source.config<Record<string, unknown>>(KIND) ?? {}
    const configOf = (): WorkmateConfig | undefined => {
      const checked = validateConfig(rawConfig())
      return checked.ok ? checked.config : undefined
    }

    const kind: SourceKind<WorkmateConfig> = {
      kind: KIND,
      title: TITLE,
      description: DESCRIPTION,
      schema: workmateConfigSchema,
      fields: FIELDS,
      health: [HEALTH_ENTRY],
      facts: () =>
        factsOf({
          taskFile: configOf()?.taskFile ?? '',
          pending: cachedTasks.filter((task) => task.assigned && !task.abandoned).length,
          waitingOnDependency: 0,
        }) as Record<string, { zh: string; en: string } | string>,
      scope: () => ({ listened: true, observed: false }),
      channel: createChannel({
        taskFile: () => configOf()?.taskFile ?? '',
        currentTasks: () => cachedTasks,
        onInvalidMessageId: (value) =>
          source.report(HEALTH_ENTRY, { state: 'error', detail: messageIdIssue(value).reason }),
      }),
      threadContext: threadContextOf({
        taskFile: () => configOf()?.taskFile ?? '',
        changesRoot: () => {
          const config = configOf()
          if (config?.repoRoot === undefined || config.repoRoot === '') return undefined
          return join(config.repoRoot, config.openspecRoot, 'changes')
        },
      }),
      find: (query) => {
        const hit = cachedTasks.find((task) => task.title.includes(query) || task.id.includes(query))
        return { threads: hit === undefined ? [] : [`${KIND}:${hit.id}`], terms: [] }
      },
      repliesTo: (trigger) => {
        const replyTo = trigger.meta['replyTo']
        return typeof replyTo === 'string' ? replyTo : undefined
      },
      environment: { variables: VARIABLES, values: (input) => environmentValues(input) },
    }

    // 注册必须先于 `context()`：健康句柄表在那一步才被 claim 出来。
    const released = orchestrator.sources.register(kind as unknown as SourceKind<Record<string, unknown>>)
    const unregister = typeof released === 'function' ? released : (): void => undefined
    source = orchestrator.context({ kind: KIND, health: [HEALTH_ENTRY] })

    const tick = async (): Promise<void> => {
      if (disposed || running) return
      const config = configOf()
      if (config === undefined) {
        source.report(HEALTH_ENTRY, {
          state: 'error',
          detail: '配置不可用：taskFile 未填或不是绝对路径',
        })
        return
      }
      running = true
      try {
        const paths = taskPaths(config.taskFile)
        const tasks = await readTaskFile(paths.tasks)
        cachedTasks = tasks.tasks
        const [inputs, results] = await Promise.all([readInputs(paths.inputs), readResults(paths.results)])

        // 先刷新待办 → Ticket 映射，再扫描：否则第一轮永远看不到已知 Ticket 的终态，
        // 依赖门控会整体晚一轮（测试里表现为"b 要等下一轮才放行"）。
        const map = { ...ticketMapOf(source) }
        const open = source.tickets.open()
        for (const task of cachedTasks) {
          if (map[task.id] !== undefined) continue
          const id = ticketIdFor(open, task.id)
          if (id !== undefined) map[task.id] = id
        }
        source.state.set(TICKET_KEY, map)

        const outcome = await scanOnce(
          {
            receive: (trigger) => source.receive(trigger) as { stored: boolean; duplicate?: boolean },
            terminalOf: (taskId) => {
              const ticketId = ticketMapOf(source)[taskId]
              if (ticketId === undefined) return undefined
              const ended = source.tickets.get(ticketId)?.ended?.outcome
              return ended === 'completed' || ended === 'merged' || ended === 'closed' || ended === 'dropped' || ended === 'stopped'
                ? ended
                : undefined
            },
            readCursor: () => source.state.get<number>(CURSOR_KEY) ?? 0,
            writeCursor: (seq) => source.state.set(CURSOR_KEY, seq),
          },
          {
            tasks: tasks.tasks,
            inputs: inputs.rows,
            maxPerScan: config.maxPerScan,
            interactive: config.interactive,
            now: () => new Date(),
          },
        )

        const summary = healthSummaryOf(outcome, results.rows)
        source.report(HEALTH_ENTRY, { ...summary, at: new Date().toISOString() })

        if (results.rows.length > config.maxRowsPerTask) {
          await compactResults(paths.results, config.maxRowsPerTask).catch(() => undefined)
        }
      } catch (error) {
        source.report(HEALTH_ENTRY, {
          state: 'error',
          detail: `扫描失败：${error instanceof Error ? error.message : String(error)}`,
        })
      } finally {
        running = false
        nextScanAt = Date.now() + Math.max(1000, config.pollSeconds * 1000)
      }
    }

    // 单一定时器：每 500ms 看一次是否到点，配置改了 pollSeconds 也立刻生效。
    const timer = setInterval(() => {
      if (disposed || running) return
      if (Date.now() < nextScanAt) return
      void tick()
    }, 500)

    void source.ready.then(() => {
      if (disposed) return
      source.report(HEALTH_ENTRY, { state: 'starting', detail: '已注册，等待首轮扫描' })
      void tick()
    })

    return () => {
      disposed = true
      clearInterval(timer)
      unregister()
    }
  }, 'workmate-superagent-source: kind + watch')
}
