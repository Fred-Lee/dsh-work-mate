/**
 * 插件入口（change `adopt-superagent-openspec-source`, task 8；
 * 多实例参数化见 change `support-multi-repo-executors`, task 2）。
 *
 * 只做三件事：注册 kind、按 `pollSeconds` 跑扫描、把结果写成健康条目。
 *
 * 模块级 `inject = ['orchestrator']` 是**刻意的**：这个包存在的唯一理由就是跑在
 * Super-agent 的进程里；装到没有它的 profile 时保持等待，是准确的自我描述。
 */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SourceHost, SourceKind, SourceContext, Ticket } from './contract.ts'
import { threadKey } from './contract.ts'
import { createChannel } from './channel.ts'
import { threadContextOf } from './context.ts'
import { compactResults, readInputs, readResults, readTaskFile, type TaskRecord } from './files.ts'
import {
  DEFAULT_KIND,
  DESCRIPTION,
  FIELDS,
  KIND_PATTERN,
  POLICY_EXPLICIT,
  POLICY_FIELDS,
  factsOf,
  kindIdOf,
  policyRows,
  policySchema,
  titleOf,
  validateConfig,
  workmateConfigSchema,
  type WorkmateConfig,
} from './kind.ts'
import { taskPaths } from './paths.ts'
import { healthSummaryOf, repoMatches, scanOnce } from './watch.ts'
import { VARIABLES, environmentValues } from './environment.ts'
import { messageIdIssue } from './validate.ts'

export const name = 'workmate-superagent-source'
export const inject = ['orchestrator'] as const

/**
 * 插件层（profile / bundle 条目）配置：只决定**实例 id**。
 *
 * 为什么实例 id 不从 Source 设置里读：宿主按 kind 名注册来源，设置页也只能给已注册的
 * kind 存设置——第二个实例必须先注册出 `workmate-b` 这个 kind，才有地方填 `taskFile` /
 * `repos`。所以"我是哪个实例"只能由装载它的人给（profile 里两条 entry，各带
 * `config.kind`），其余字段仍从 `source.config(实例 id)` 读（tasks.md 任务 12 的部署方式）。
 */
export interface InstanceConfig {
  kind?: string
}

/**
 * 按实例派生的**唯一入口**：本文件里所有实例相关标识都从这里取，不再出现字面量。
 * 见 design D2 的表格：kind.kind / 健康条目 / state 键 / Trigger source / Thread key /
 * find 前缀 / config(id) / context({kind, health}) / report 条目。
 */
const sourceIdOf = (config: InstanceConfig | undefined): string => kindIdOf(config)

/**
 * 游标与待办→Ticket 映射都存在 Source 自己的 state 里，不回写面板独占的文件。
 * 键必须是字符串（宿主的 KV 是 SQLite TEXT 列，见 `contract.ts` 的 state 注释）。
 *
 * 键里必须带实例 id：宿主 KV 的键空间按来源家族共用（旧实现只有 `workmate-source:`），
 * 两个实例若共用 `workmate-source:cursor` 会互相覆盖游标——一个实例投过的回答另一个
 * 会漏掉，或者反复重投（design D2 的"串台后果"）。
 */
const STATE_PREFIX = 'workmate-source'
const stateKeyOf = (instanceId: string, suffix: 'cursor' | 'tickets'): string =>
  `${STATE_PREFIX}:${instanceId}:${suffix}`

/**
 * 迁移兼容（只读、只对默认实例）：本变更之前默认实例没有实例段，
 * 游标与 Ticket 映射分别是 `workmate-source:cursor` / `workmate-source:tickets`。
 * 升级后首轮靠它续上旧状态（尤其是**已结束**的 Ticket 映射——重启后 `tickets.open()`
 * 已经看不到它们，丢了会让依赖门控永久停在"等待"）。新写入一律走 `stateKeyOf`。
 */
const LEGACY_CURSOR_KEY = `${STATE_PREFIX}:cursor`
const LEGACY_TICKET_KEY = `${STATE_PREFIX}:tickets`

type TicketMap = Record<string, string>

/** 用 Thread 反查 Ticket：本来源的 Trigger 都带 `meta.taskId`，Channel address 同源。 */
function ticketIdFor(tickets: readonly Ticket[], taskId: string): string | undefined {
  return tickets.find((ticket) => ticket.channels.some((channel) => channel.address['taskId'] === taskId))?.id
}

export function apply(ctx: Context, instanceConfig: InstanceConfig = {}): void {
  const orchestrator = (ctx as unknown as { orchestrator?: SourceHost }).orchestrator
  if (orchestrator === undefined) return

  // 实例 id 只能由装载它的插件条目给（注册先于设置，见上方 InstanceConfig 注释）。非法 id
  // 直接让装载失败：registry 用 kind 作键，`Workmate` 之类的写法会让来源页、健康条目名与
  // state 键变得不可预测。装错 profile 时上面已经安静返回，这里抛错不会伤害那种情况。
  const declaredKind = instanceConfig.kind?.trim()
  if (declaredKind !== undefined && declaredKind !== '' && !KIND_PATTERN.test(declaredKind)) {
    throw new Error(`workmate-superagent-source: 实例 id 必须匹配 ${String(KIND_PATTERN)}（实际：${declaredKind}）`)
  }

  // 实例 id 只在这里算一次，后面所有派生标识都用它（design D2 的纪律）。
  const instanceId = sourceIdOf(instanceConfig)
  const cursorKey = stateKeyOf(instanceId, 'cursor')
  const ticketKey = stateKeyOf(instanceId, 'tickets')

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

    const rawConfig = (): Record<string, unknown> => source.config<Record<string, unknown>>(instanceId) ?? {}
    const checkedConfig = (): ReturnType<typeof validateConfig> => validateConfig(rawConfig())
    const configOf = (): WorkmateConfig | undefined => {
      const checked = checkedConfig()
      return checked.ok ? checked.config : undefined
    }
    const reposOf = (): readonly string[] => configOf()?.repos ?? []

    // 待办 → Ticket 映射；默认实例额外合并旧键（见 LEGACY_TICKET_KEY 注释）。
    const ticketMapOf = (): TicketMap => {
      const current = source.state.get<TicketMap>(ticketKey) ?? {}
      if (instanceId !== DEFAULT_KIND) return current
      const legacy = source.state.get<TicketMap>(LEGACY_TICKET_KEY) ?? {}
      return { ...legacy, ...current }
    }

    const kind: SourceKind<WorkmateConfig> = {
      kind: instanceId,
      // 标题按实例区分：来源页/设置页按 kind 列出实例，两个实例同名会分不清谁是谁。
      title: titleOf(instanceId),
      description: DESCRIPTION,
      schema: workmateConfigSchema,
      fields: FIELDS,
      // 健康条目名与注册键同源：窗格/管理页按名字claim 句柄，名字不同才能各自可见。
      health: [instanceId],
      facts: () => {
        const repos = reposOf()
        return factsOf({
          instance: instanceId,
          taskFile: configOf()?.taskFile ?? '',
          pending: cachedTasks.filter(
            (task) => task.assigned && !task.abandoned && repoMatches(task.repo, repos),
          ).length,
          waitingOnDependency: 0,
        }) as Record<string, { zh: string; en: string } | string>
      },
      scope: () => ({ listened: true, observed: false }),
      channel: createChannel({
        taskFile: () => configOf()?.taskFile ?? '',
        currentTasks: () => cachedTasks,
        onInvalidMessageId: (value) =>
          source.report(instanceId, { state: 'error', detail: messageIdIssue(value).reason }),
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
        const repos = reposOf()
        const hit = cachedTasks.find(
          (task) => repoMatches(task.repo, repos) && (task.title.includes(query) || task.id.includes(query)),
        )
        // Thread key 带实例前缀：否则两个实例对同一待办返回同一个 key，搜索会串台。
        return { threads: hit === undefined ? [] : [threadKey(hit.id, instanceId)], terms: [] }
      },
      repliesTo: (trigger) => {
        const replyTo = trigger.meta['replyTo']
        return typeof replyTo === 'string' ? replyTo : undefined
      },
      // 只声明"谁能发起工作"：`allowed` 里是 `workmate:<createdBy>`。接受规则属于部署方的
      // `policy.rules`，本 kind 既不读也不写（design D9b）。
      policy: {
        schema: policySchema,
        fields: POLICY_FIELDS,
        explicit: POLICY_EXPLICIT,
        rows: policyRows,
      },
      environment: { variables: VARIABLES, values: (input) => environmentValues(input) },
    }

    // 注册必须先于 `context()`：健康句柄表在那一步才被 claim 出来。
    const released = orchestrator.sources.register(kind as unknown as SourceKind<Record<string, unknown>>)
    const unregister = typeof released === 'function' ? released : (): void => undefined
    // 注册键、健康条目、config 查询全用同一个实例 id，不走 DEFAULT_KIND 字面量。
    source = orchestrator.context({ kind: instanceId, health: [instanceId] })

    const tick = async (): Promise<void> => {
      if (disposed || running) return
      const checked = checkedConfig()
      if (!checked.ok) {
        // 报出 validateConfig 的具体原因：多实例后配置可能错在 `repos`（相对路径），
        // 只说 taskFile 会把人引到错误的方向。
        source.report(instanceId, { state: 'error', detail: `配置不可用：${checked.reason}` })
        return
      }
      const config = checked.config
      // 设置里的 `kind` 只做一致性校验：真正决定注册 id 的是插件条目 config.kind，
      // 填成别的值说明部署方误解了配置位置，必须报出来而不是静默忽略。
      if (config.kind !== undefined && config.kind !== instanceId) {
        source.report(instanceId, {
          state: 'error',
          detail: `设置里的 kind（${config.kind}）与装载实例 id（${instanceId}）不一致：id 由插件条目的 config.kind 决定`,
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
        const map = { ...ticketMapOf() }
        const open = source.tickets.open()
        for (const task of cachedTasks) {
          if (map[task.id] !== undefined) continue
          const id = ticketIdFor(open, task.id)
          if (id !== undefined) map[task.id] = id
        }
        source.state.set(ticketKey, map)

        const outcome = await scanOnce(
          {
            receive: (trigger) => source.receive(trigger) as { stored: boolean; duplicate?: boolean },
            terminalOf: (taskId) => {
              const ticketId = ticketMapOf()[taskId]
              if (ticketId === undefined) return undefined
              const ended = source.tickets.get(ticketId)?.ended?.outcome
              return ended === 'completed' || ended === 'merged' || ended === 'closed' || ended === 'dropped' || ended === 'stopped'
                ? ended
                : undefined
            },
            readCursor: () =>
              source.state.get<number>(cursorKey) ??
              (instanceId === DEFAULT_KIND ? source.state.get<number>(LEGACY_CURSOR_KEY) : undefined) ??
              0,
            writeCursor: (seq) => source.state.set(cursorKey, seq),
          },
          {
            tasks: tasks.tasks,
            inputs: inputs.rows,
            source: instanceId,
            repos: config.repos,
            maxPerScan: config.maxPerScan,
            interactive: config.interactive,
            now: () => new Date(),
          },
        )

        const summary = healthSummaryOf(outcome, results.rows)
        source.report(instanceId, { ...summary, at: new Date().toISOString() })

        if (results.rows.length > config.maxRowsPerTask) {
          await compactResults(paths.results, config.maxRowsPerTask).catch(() => undefined)
        }
      } catch (error) {
        source.report(instanceId, {
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
      source.report(instanceId, { state: 'starting', detail: '已注册，等待首轮扫描' })
      void tick()
    })

    return () => {
      disposed = true
      clearInterval(timer)
      unregister()
    }
  }, `workmate-superagent-source: kind + watch (${instanceId})`)
}
