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

/**
 * 默认实例 id（change `support-multi-repo-executors`）。
 *
 * 宿主的 kind 注册表以 `kind.kind` 为键，重复即抛 `Source kind already registered`。
 * 所以"多实例"不是多包，而是同一个包注册多次、每次换一个 id：默认实例沿用 `workmate`，
 * 其余实例由 `kind` 字段给 `workmate-<suffix>` 之类。所有派生键（健康条目名、state
 * 前缀、Trigger `source`、Thread key 前缀）都必须从这个 id 来，否则两个实例会互相去重、
 * 互相覆盖健康报告或共用一个游标（design D2）。
 */
export const DEFAULT_KIND = 'workmate'

/** 实例 id 的合法形状：小写字母开头，只含小写字母/数字/连字符。 */
export const KIND_PATTERN = /^[a-z][a-z0-9-]*$/

/**
 * 仓库列表的配置形状：**对外输出永远是绝对路径数组**，但接受面板文本框写进来的字符串。
 *
 * Super-agent 的 `FieldSpec` 没有"字符串数组"这种表单类型：`rows` 只编辑记录数组
 * （`Record<string,string>[]`，且必须有 columns），直接声明成 rows 会在设置页渲染错误。
 * 所以面板用 `text` 字段（逗号/换行分隔），schema 在保存时归一成数组；用 JSON/API 直接写
 * `repos: ['/srv/a']` 同样有效。
 */
export const reposSchema = z.preprocess(
  (value) => (typeof value === 'string' ? value.split(/[\n,]/).map((part) => part.trim()).filter((part) => part !== '') : value),
  z.array(z.string().trim().min(1)).default([]),
)

/**
 * 实例配置。`taskFile` 无默认：必须由安装方填成与 WorkMate 一致的绝对路径。
 *
 * `repos` 是 `support-multi-repo-executors` 新增的路由字段：本实例负责的仓库绝对路径；
 * 空数组 = 不限制（旧部署行为不变）。设置页的文本框写的是逗号分隔字符串，schema 这里
 * 统一归一成数组（见 `reposSchema`），所以 JSON 里写数组、面板里写逗号分隔都能用。
 *
 * `kind`（实例 id）**不在这里**：Super-agent 的设置按已注册的 kind 存
 * （`settings.sources[kind.kind]`），第二个实例必须先注册出 `workmate-b` 才有地方填设置，
 * 所以 id 只能由装载它的插件条目 `config.kind` 给（`index.ts` 的 `InstanceConfig`）。
 * 这里仍接受可选的 `kind`，但只用于一致性校验：填了却与装载 id 不一致时健康报错，
 * 避免部署方以为改设置里的值能换实例。
 */
export const workmateConfigSchema = z
  .object({
    // kind 可选：它不是注册来源（注册 id 来自插件条目 `config.kind`），只做一致性校验。
    kind: z.string().trim().regex(KIND_PATTERN).optional(),
    // 必须给默认值：Super-agent 的 resolve() 在 safeParse 失败时会回落调用 parse({})，
    // 那时如果这里抛错，设置页/来源页/intake 会整体坏掉。空串由 validateConfig 判为不可用。
    taskFile: z.string().default(''),
    // 元素只要求非空：空数组语义是"不限制仓库"，单个空串没有意义，必须挡住。
    // 面板的 text 字段写字符串（逗号/换行分隔），先归一成数组再校验元素。
    repos: reposSchema,
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

/**
 * 实例 id 的**唯一派生点**（design D2）。
 *
 * 入参放宽成 `{ kind?: string }`：完整实例配置与插件层（bundle 条目）配置都能传进来。
 * 正则校验留给 schema（`parse` 会拒绝非法 id）；这里只负责"没配就是默认实例"，
 * 不抛错——apply 阶段抛错会让整个 profile 装载失败。
 */
export function kindIdOf(config: { kind?: string } | undefined): string {
  return config?.kind?.trim() || DEFAULT_KIND
}

export const TITLE = { zh: 'WorkMate 待办', en: 'WorkMate tasks' } as const
export const DESCRIPTION = {
  zh: '读取 WorkMate 的任务文件，把待办变成可评估的请求；执行结果写回同一份文件。',
  en: 'Reads the WorkMate task file, turns todos into assessable requests, and writes results back to the same file.',
} as const

/**
 * 实例标题：默认实例沿用原名，其余实例在标题后带实例 id。
 * 来源页与设置页按 kind 列出实例，标题相同的话多个实例无法区分（健康条目名虽不同，
 * 但那是技术标识，不该要求部署者拿它对照）。
 */
export function titleOf(instanceId: string): { zh: string; en: string } {
  if (instanceId === DEFAULT_KIND) return { ...TITLE }
  return { zh: `${TITLE.zh}（${instanceId}）`, en: `${TITLE.en} (${instanceId})` }
}

/** 设置表单字段；`rows`/`fact` 由 Super-agent 的通用渲染器处理。 */
export const FIELDS: FieldSpec[] = [
  {
    // 只读事实：真实的注册 id 来自插件条目 `config.kind`，设置页不能改它。
    // 用 fact 而不是 text，避免部署者以为在设置里改这个值能换实例。
    key: 'instance',
    type: 'fact',
    label: { zh: '实例 ID', en: 'Instance id' },
    hint: {
      zh: '由装载本包的 profile 条目的 config.kind 决定（默认 workmate）；改 id 必须改条目并重启宿主。',
      en: 'Set by the profile entry config.kind that loads this package (default workmate); changing it needs an entry edit and a host restart.',
    },
  },
  {
    key: 'taskFile',
    type: 'text',
    label: { zh: '任务文件', en: 'Task file' },
    hint: { zh: '必须是绝对路径，且与 WorkMate 配置指向同一个文件', en: 'Absolute path; must match the one WorkMate writes' },
  },
  {
    key: 'repos',
    type: 'text',
    label: { zh: '负责的仓库', en: 'Repositories served' },
    hint: {
      zh: '仓库的绝对路径，逗号分隔；留空表示不限制（所有仓库都投）。',
      en: 'Absolute repository paths, comma-separated; empty means every repository.',
    },
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
 * 来源的 policy 分片（`allowed` + `admission`）。
 *
 * 这里**只**声明"谁可以发起工作"：接受规则属于部署方的 `policy.rules`，本 kind 既读不到
 * 也不该写。`admission` 由 Super-agent 的 `AdmissionTableSchema` 单独校验（`registry.ts`
 * 的 `validatePolicy` 会把它摘出来），所以这个 schema 只覆盖 `allowed` 与其它自有键。
 */
export const policySchema = z
  .object({
    allowed: z
      .array(z.object({ id: z.string().trim().min(1).max(200), name: z.string().trim().max(100).optional() }).strict())
      .default([]),
  })
  .strict()

export const POLICY_FIELDS: FieldSpec[] = [
  {
    key: 'allowed',
    type: 'rows',
    label: { zh: '能发起工作的创建者', en: 'Creators that may originate work' },
    hint: {
      zh: '填 `workmate:<createdBy>`（面板默认就是 `workmate:panel`）。列入的人发出的待办才算明确请求；不在名单里的人要靠准入表放行。',
      en: 'Use `workmate:<createdBy>` (the panel writes `workmate:panel`). Todos from listed creators are explicit requests; anyone else depends on the admission table.',
    },
    columns: [{ key: 'id', type: 'text', label: { zh: '创建者', en: 'Creator' }, pattern: '[A-Za-z0-9:.\\-]+' }],
  },
]

export const POLICY_EXPLICIT = {
  zh: '名单里的创建者在任务文件里建的待办，就是对本来源的明确请求。',
  en: "A todo a listed creator wrote in the task file is an explicit request to this Source.",
} as const

/**
 * 准入表的行：本来源只有一个观察范围（任务文件），所以只有一行。
 * `unlistedAddressed` 是唯一可能被用到的格子——本来源的 Trigger 恒为 `mention`。
 */
export const policyRows = (_stored: Record<string, unknown>): Array<{
  id: string
  label: { zh: string; en: string } | string
  note: { zh: string; en: string }
  cells: { listedUnaddressed: boolean; unlistedAddressed: boolean; unlistedUnaddressed: boolean }
}> => [
  {
    id: 'tasks',
    label: { zh: '任务文件', en: 'Task file' },
    note: { zh: '唯一观察范围', en: 'The only scope' },
    // 未列入的人发出的待办总是带 `addressed: 'mention'`：只影响这一个格子。
    cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false },
  },
]

/**
 * 健康条目只能报本 kind 声明过的名字。四个状态里 `error` 只在"连续多轮失败"时才用
 * （沿用 Super-agent 对 Source 失败的纪律：单次读盘失败记在 Thread 上，不报警）。
 */
export const HEALTH_STATES = ['starting', 'ready', 'paused', 'error'] as const

/** 供 `facts()` 使用的只读事实：来自本 Source 的 state，不读盘。 */
export interface KindFactsInput {
  /** 本实例的注册 id（`kind` 由插件条目 config 决定，设置页只读展示它）。 */
  instance: string
  taskFile: string
  pending: number
  waitingOnDependency: number
  lastScanAt?: string
}

export function factsOf(input: KindFactsInput): Record<string, { zh: string; en: string } | string> {
  return {
    instance: input.instance,
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
  // repos 是要和待办里的 repo 做字符串比较的（见 watch.ts 的 normalizeRepoPath）：
  // 相对路径既不可能是待办的 repo，也无法靠 basename 猜——直接判不可用，免得静默一条都不投。
  for (const repo of parsed.data.repos) {
    if (!repo.startsWith('/')) {
      return { ok: false, reason: `repos 必须是绝对路径：${repo}` }
    }
  }
  return { ok: true, config: parsed.data }
}

/**
 * 只在测试与类型层使用：确认本文件导出的形状满足 SourceKind 的必填字段。
 * 这里用**默认实例**的 id 展示静态形状；运行期注册用的是 `kindIdOf(config)`，
 * 绝不能再从模块常量取健康条目名（否则多实例会共用一个健康条目）。
 */
export const kindMetadataShape: Pick<SourceKind<WorkmateConfig>, 'kind' | 'title' | 'description' | 'fields' | 'health'> = {
  kind: DEFAULT_KIND,
  title: TITLE,
  description: DESCRIPTION,
  fields: FIELDS,
  health: [DEFAULT_KIND],
}
