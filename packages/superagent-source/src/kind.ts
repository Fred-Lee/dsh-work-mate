/**
 * SourceKind 元数据与配置（change `adopt-superagent-openspec-source`, task 5）。
 *
 * `schema` 必须是 zod：Super-agent 用 `safeParse`/`parse` 校验实例配置，并在失败时
 * 禁用实例。这里给**每个字段都提供默认值**，保证 `parse({})` 不抛——否则它的
 * `instances()`/`scope()` 会整体抛错，把设置页、来源页与 intake 一起弄坏。
 *
 * 配置里**没有**"接受规则"：接受哪些工作属于部署方的 `policy.rules`，Source 既读不到
 * 也不该写（design D9b）。
 */
import { z } from 'zod'
import type { FieldSpec, SourceKind } from './contract.ts'

/** 实例配置。`taskFile` 无默认：必须由安装方填成与 WorkMate 一致的绝对路径。 */
export const workmateConfigSchema = z
  .object({
    // 必须给默认值：Super-agent 的 resolve() 在 safeParse 失败时会回落调用 parse({})，
    // 那时如果这里抛错，设置页/来源页/intake 会整体坏掉。空串由 validateConfig 判为不可用。
    taskFile: z.string().default(''),
    pollSeconds: z.number().int().min(1).max(3600).default(5),
    maxPerScan: z.number().int().min(0).max(200).default(5),
    maxRowsPerTask: z.number().int().min(2).max(100_000).default(200),
    /** 只读模式：读任务、写回执，但不产生 Trigger。 */
    interactive: z.boolean().default(false),
    copyFiles: z.array(z.string()).default(['.env', '.env.local']),
    repoRoot: z.string().optional(),
    openspecRoot: z.string().default('openspec'),
  })
  .strict()

export type WorkmateConfig = z.infer<typeof workmateConfigSchema>

export const KIND = 'workmate'
export const HEALTH_ENTRY = 'workmate'

export const TITLE = { zh: 'WorkMate 待办', en: 'WorkMate tasks' } as const
export const DESCRIPTION = {
  zh: '读取 WorkMate 的任务文件，把待办变成可评估的请求；执行结果写回同一份文件。',
  en: 'Reads the WorkMate task file, turns todos into assessable requests, and writes results back to the same file.',
} as const

/** 设置表单字段；`rows`/`fact` 由 Super-agent 的通用渲染器处理。 */
export const FIELDS: FieldSpec[] = [
  {
    key: 'taskFile',
    type: 'text',
    label: { zh: '任务文件', en: 'Task file' },
    hint: { zh: '必须是绝对路径，且与 WorkMate 配置指向同一个文件', en: 'Absolute path; must match the one WorkMate writes' },
  },
  {
    key: 'interactive',
    type: 'switch',
    label: { zh: '投递待办', en: 'Submit todos' },
    hint: { zh: '关闭时只读取并回写，不产生任何请求', en: 'Off: read and reply only, submit nothing' },
  },
  {
    key: 'pollSeconds',
    type: 'number',
    label: { zh: '扫描间隔（秒）', en: 'Scan every (seconds)' },
    advanced: true,
  },
  {
    key: 'maxPerScan',
    type: 'number',
    label: { zh: '单轮最多投递', en: 'Max submissions per scan' },
    hint: { zh: '人的回答不受此限', en: 'Human replies are not capped' },
    advanced: true,
  },
  {
    key: 'maxRowsPerTask',
    type: 'number',
    label: { zh: '单任务记录上限', en: 'Max rows per task' },
    hint: { zh: '超出后压缩为最近若干行', en: 'Older rows are compacted away' },
    advanced: true,
  },
  {
    key: 'repoRoot',
    type: 'text',
    label: { zh: '仓库根（可选）', en: 'Repository root (optional)' },
    hint: { zh: '填了才会读取该仓库的 OpenSpec 工件作为评估上下文', en: 'Needed to read OpenSpec artifacts as assessment context' },
  },
  {
    key: 'openspecRoot',
    type: 'text',
    label: { zh: 'OpenSpec 目录', en: 'OpenSpec directory' },
    advanced: true,
  },
]

/**
 * 健康条目只能报本 kind 声明过的名字。四个状态里 `error` 只在"连续多轮失败"时才用
 * （沿用 Super-agent 对 Source 失败的纪律：单次读盘失败记在 Thread 上，不报警）。
 */
export const HEALTH_STATES = ['starting', 'ready', 'paused', 'error'] as const

/** 供 `facts()` 使用的只读事实：来自本 Source 的 state，不读盘。 */
export interface KindFactsInput {
  taskFile: string
  pending: number
  waitingOnDependency: number
  lastScanAt?: string
}

export function factsOf(input: KindFactsInput): Record<string, { zh: string; en: string } | string> {
  return {
    taskFile: input.taskFile,
    pending: { zh: `待投递 ${input.pending} 条`, en: `${input.pending} pending` },
    waiting: { zh: `等待依赖 ${input.waitingOnDependency} 条`, en: `${input.waitingOnDependency} waiting on dependencies` },
    lastScan: input.lastScanAt ?? { zh: '尚未扫描', en: 'not scanned yet' },
  }
}

/**
 * 校验一条配置是否可用于本 Source。
 * 返回 `ok: false` 时调用方应保持沉默（不投递、只报健康），而不是抛错。
 */
export function validateConfig(raw: unknown):
  | { ok: true; config: WorkmateConfig }
  | { ok: false; reason: string } {
  const parsed = workmateConfigSchema.safeParse(raw ?? {})
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return { ok: false, reason: first?.message ?? 'invalid configuration' }
  }
  const taskFile = parsed.data.taskFile.trim()
  if (taskFile === '') return { ok: false, reason: 'taskFile 未配置：必须是 WorkMate 任务文件的绝对路径' }
  if (!taskFile.startsWith('/')) {
    return { ok: false, reason: `taskFile 必须是绝对路径：${taskFile}` }
  }
  return { ok: true, config: parsed.data }
}

/** 只在测试与类型层使用：确认本文件导出的形状满足 SourceKind 的必填字段。 */
export const kindMetadataShape: Pick<SourceKind<WorkmateConfig>, 'kind' | 'title' | 'description' | 'fields' | 'health'> = {
  kind: KIND,
  title: TITLE,
  description: DESCRIPTION,
  fields: FIELDS,
  health: [HEALTH_ENTRY],
}
