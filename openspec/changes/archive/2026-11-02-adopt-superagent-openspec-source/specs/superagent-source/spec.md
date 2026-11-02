# superagent-source Specification

## Purpose

把"本地待办"实现成一个符合 Super-agent `SourceKind` 契约的完整来源：它像 GitHub、飞书一样
**是**一个外部世界的事件流，而不是挂在它外面的一层桥。所有执行事实由 Super-agent 产生，
Source 只负责读取意图、产生 Trigger、回写结果。

## ADDED Requirements

### Requirement: 作为独立 Source bundle 安装

SourceKind SHALL 位于独立包 `workmate-superagent-source`，该包 SHALL 声明
`dsh.bundle.patch` 并在自身的 `cordis.patch.yml` 中只声明一条 entry
（`- id: workmate-superagent-source / name: workmate-superagent-source`）。

该包 SHALL NOT 依赖 `@deepseek-ai/dsh-superagent`（不 import、不写
`dependencies`/`peerDependencies`）；与 Super-agent 之间 SHALL 只有运行期的
`ctx.orchestrator` 服务契约。

把它安装进 Super-agent 的 profile 后，宿主 SHALL 能通过标准插件管理流程启用它；
SHALL NOT 需要手工编辑 `dsh.profile.bundles` 或 `cordis.patch.yml`。

#### Scenario: 装包即启用

- **WHEN** 在 Super-agent 的 profile 中安装 `workmate-superagent-source`
- **THEN** 插件管理器把它列为一个新的 bundle 并启用，profile 中出现
  `workmate-superagent-source` 条目，无需手工改 bundles

#### Scenario: 无源码依赖

- **WHEN** 检查该包的 `package.json`
- **THEN** `dependencies`/`peerDependencies` 中不含任何 `dsh-superagent` 条目

#### Scenario: 装错 profile 只等待

- **WHEN** 该包被安装在没有 Super-agent 的 profile 里
- **THEN** 模块级 `inject` 让插件保持等待，不注册工具、不抛错、不阻断宿主启动

### Requirement: 完整的 SourceKind 契约

该 kind SHALL 实现 `SourceKind` 的必填字段：`kind`、`title`、`description`、`schema`、
`fields`、`health`；并 SHALL 实现以下可选能力：`scope`、`channel`、`threadContext`、
`find`、`policy`、`environment`、`facts`。

`kind` 值 SHALL 为 `workmate`；`schema` SHALL 用 zod 校验来源实例配置
（至少含 `taskFile`、`pollSeconds`、`maxPerScan`（默认 5）、`maxRowsPerTask`（默认 200）、
`interactive`、`copyFiles`（默认 `['.env', '.env.local']`），可选 `repoRoot` 与 `openspecRoot`），
无效配置 SHALL 使该实例被禁用而不是让进程崩溃（沿用 Super-agent 的 `resolve()` 语义）。

该 kind SHALL NOT 在自身配置里声明"接受规则"或任何授权开关：接受哪些工作由部署方的
`policy.rules` 决定，Source 既读不到也不该读写它；接入手册 SHALL 提供一个可直接粘贴的
规则文本，面板 SHALL 在被忽略时显示 Decision 原因与配置入口。

`health` 声明 SHALL 只包含本 kind 自有条目（如 `workmate`），SHALL NOT 抢占
`runtime` / `reply` / `worker` 等保留名或 effect 名。

#### Scenario: 配置非法不崩

- **WHEN** 存储的配置缺少 `taskFile` 或类型错误
- **THEN** 该实例被禁用并在来源页显示 `off`（Super-agent 的 `resolve()` 只禁用实例，
  不写健康错误），宿主的其他 Source 不受影响；`schema` SHALL 为每个字段提供默认值，
  使 `parse({})` 不抛错

#### Scenario: 必填字段齐全

- **WHEN** 宿主读取该 kind 的元数据
- **THEN** 六个必填字段均存在且类型正确，`title`/`description` 同时提供 `zh` 与 `en`

### Requirement: 三份文件与三个单写者

待办的存储 SHALL 拆成三份，各有唯一写者：

- `tasks.json`：人写的意图，**只由 WorkMate 面板写**。字段
  `id`/`title`/`intent`/`repo`/`baseBranch`/`acceptance`/`priority`/`mode`/`dependsOn`/
  `assigned`/`abandoned`/`attempt`/`createdBy`/`createdAt`/`updatedAt`；
  tmp+rename 原子写，损坏 fail-closed。
- `inputs.jsonl`：人后续追加的消息（回答、补充约束），**只由 WorkMate 面板追加**。
- `tasks.jsonl`：Source 的事实行（`ack`/`result`/`notice`/`error`）与关联引用，
  **只由 Source 追加**；读取端 SHALL 容忍撕裂尾行与非法行（忽略并计数）。

Source SHALL 读取 `inputs.jsonl` 中尚未消费的行（以 `seq` 为游标），把每一行转换为同一
Thread 上的 Trigger：`id = workmate:<taskId>:in:<seq>`（确定性、可重放）、
`human: true`、`addressed: 'mention'`、`actor = { source: 'workmate', id: 'workmate:<by>' }`、
`text = text`、`replyTo = 行内 replyTo`。消费位点 SHALL 记录在 Source 自己的状态里，
SHALL NOT 回写到面板独占的两个文件。

**没有 Ticket 时也投递。** 人在待办尚未被接受前补充的约束同样 SHALL 投递：它进入该
Thread，等 Eval 接单后成为已订阅线程上的输入；SHALL NOT 因为"还没有 Ticket"而丢弃或积压
到超时。

**游标必须能自愈**：若 `inputs.jsonl` 的最大 `seq` 小于 Source 记录的游标（文件被截断、
被外部替换或面板重建），Source SHALL 把游标重置到该文件的最小未消费位置，
SHALL 在 `health` 报告一次"游标回退"，SHALL NOT 永久跳过新行。
`tasks.jsonl` 的去重 SHALL 只扫描文件尾部一个有界窗口（最近 N 行），SHALL NOT 每次
全量读；窗口外的重复 SHALL 视为新行（宁可多一行展示，也不阻塞投递）。

三份文件 SHALL NOT 互相写入；SHALL NOT 出现第四个承载执行状态的文件。

`taskFile` SHALL 是**绝对路径**，且 SHALL 由安装方在 WorkMate 配置与 source 实例配置里
指向**同一个文件**；两侧 SHALL NOT 各自推导。

`tasks.jsonl` SHALL 有增长上限：单个待办超过 `maxRowsPerTask`（默认 200）行时，Source
SHALL 在扫描间隙把它压缩为最近 N 行（保留至少一条 `ack` 与最后一条 `result`/`error`），
以 tmp+rename 原子重写。压缩 SHALL 只由 Source 执行（它是唯一写者），SHALL NOT 改变
其他待办的行。Source SHALL 在 `health` 中报告：文件不存在、
不可读、`version` 不受支持、以及"路径与 WorkMate 声称的不一致"（当两侧都暴露路径时）。
`interactive=false` 时 Source SHALL 只读不投递，`channel.send` 仍 SHALL 写回（否则面板看不到
执行器的输出）。

#### Scenario: 两端不抢写

- **WHEN** 面板写入新待办的同时 Source 追加结果行
- **THEN** 两份文件各自完好；`tasks.json` 不出现追加行，`tasks.jsonl` 不出现整表重写

#### Scenario: 尾行撕裂可恢复

- **WHEN** `tasks.jsonl` 的最后一行只写了一半
- **THEN** 读取端忽略该行并继续给出一致结果，不抛错

#### Scenario: 超长日志被压缩

- **WHEN** 某待办的 `tasks.jsonl` 行数超过 `maxRowsPerTask`
- **THEN** Source 在扫描间隙把它压缩为最近 N 行，保留至少一条 `ack` 与最后一条
  `result`/`error`；其他待办的行不受影响；重写是原子的

#### Scenario: 路径不一致要报出来

- **WHEN** WorkMate 侧配置的 `taskFile` 与 source 实例配置的不是同一个绝对路径
- **THEN** Source 的 `health` 报告路径不一致，面板显示明确错误而不是静默不同步

### Requirement: 待办到一个 Thread 的映射与幂等 Trigger

每条待办 SHALL 映射为一个 Thread：`{ source: 'workmate', id: <taskId> }`。
Source SHALL 只在 `assigned=true` 且未产生过当前 `attempt` 的 Trigger 时产生 Trigger：

- `id`：`workmate:<taskId>:<attempt>`；同一 `attempt` 重复扫描 SHALL 返回 `duplicate`；
- `actor`：`{ source: 'workmate', id: 'workmate:<createdBy>' }`（`ActorRef` 必须带 `source`，
  门禁按 `policy.sources[actor.source].allowed` 查人）；`createdBy` 来自待办的创建者标识；
- `human`：`true`；`addressed`：`'mention'`；
- `text`：待办原文（`intent`），SHALL 原样投递，不改写、不追加实施建议；
- `channel`：`{ source: 'workmate', thread: <taskId>, address: { taskId } }`；
- `meta`：`taskId`、`repo`、`baseBranch`、`acceptance`、`priority`、`ports`、可选 `proposalId`；
- `at`：待办 `updatedAt`。

Source SHALL NOT 直接创建 Ticket 或 Decision，SHALL NOT 绕过 Eval。
Source SHALL NOT 调用 `tickets.bindThread`、`tickets.threadClosed` 或 `notify`：这三个是
`SourceContext` 暴露的写能力，其中 `threadClosed` 会结束 Ticket，`bindThread` 会改订阅；
本来源只经 `receive` 投递，出站一律走 `channel.send`。

#### Scenario: 重复扫描不重复开单

- **WHEN** Source 每轮扫描同一条已产生 Trigger 的待办
- **THEN** `receive` 返回 `duplicate`，不产生第二张 Ticket

#### Scenario: 重试是新尝试

- **WHEN** 待办的 `attempt` 递增
- **THEN** 生成新的确定性 ID 并投递，旧 Ticket 的结束事实保留在 `tasks.jsonl`

### Requirement: 单轮投递有上限且顺序确定

一轮扫描 SHALL 最多投递 `maxPerScan` 条（默认 5，可在实例配置中改），SHALL NOT 在一轮内
把积压全部投递。排序 SHALL 为：`priority`（P0 > P1 > P2）→ `createdAt` 升序 → `id` 字典序，
使新任务的放行可预测、可复现。

超过上限的待办 SHALL 留到下一轮，SHALL NOT 记为错误；`health` SHALL 报告"待投递 n 条"。
该上限 SHALL NOT 影响 `inputs.jsonl` 的投递——人的回答 SHALL 优先于新任务，一轮内
全部投递。

**重启后的重复不额外处理。** Source SHALL 依赖 Trigger 的确定性 ID 与 `receive` 的
`duplicate` 去重，SHALL NOT 自己维护"已投递集合"作为第二份真相；重启后重发同一 ID 是
允许的，结果应仍是 `duplicate`。

#### Scenario: 积压不会一次打满评估

- **WHEN** 30 条待办同时变为可投递，`maxPerScan=5`
- **THEN** 第一轮只投 5 条，其余留待后续；健康条目显示待投递数，不报错

#### Scenario: 回答优先于新任务

- **WHEN** 同一轮里既有 5 条新任务、又有 2 条人的回答
- **THEN** 2 条回答全部投递，新任务按上限截断

#### Scenario: 重启后重发仍去重

- **WHEN** Source 在投递后、记录游标前重启
- **THEN** 下一轮重发同一 `workmate:<taskId>:<attempt>`，`receive` 返回 `duplicate`，
  不产生第二张 Ticket

### Requirement: 依赖门控属于 Source

待办的 `dependsOn` SHALL 由 Source 判断：只有当前置待办的全部 Ticket 都已结束且终态为
`completed` / `merged` / `closed` 时 SHALL 产生 Trigger；被 `stopped` / `dropped` 的前置
SHALL 视为"不会完成"，其下游 SHALL 停在等待并在 `health` 中报告需要人处理。
判定依据 SHALL 是 `ctx.tickets` 的终态事实，SHALL NOT 依赖 `tasks.jsonl` 的行——
`reply` 既可能是"结果"也可能是"提问"，用它判完成会把提问误判成完成。

该门控 SHALL NOT 交给 Eval 或 Ticket；SHALL NOT 通过"先投递再忽略"实现。

#### Scenario: 依赖未满足不投递

- **WHEN** 待办 B 依赖 A，且 A 尚无 `result` 行
- **THEN** B 不产生 Trigger，健康条目显示等待数

#### Scenario: 依赖满足后自动放行

- **WHEN** A 的结果行写入 `tasks.jsonl`
- **THEN** 下一轮扫描为 B 产生 Trigger，无需人工再点指派

### Requirement: Channel 把执行事实写回任务文件

该 kind SHALL 实现 `channel.send(message)`：把送达的消息追加为 `tasks.jsonl` 的一行，
种类固定取 `message.kind`（`acknowledgement → ack`、`reply → reply`、`notice → notice`），
SHALL NOT 依据文本内容猜测种类，并以 `message.id` 幂等——同一 ID 重复投递 SHALL 不追加第二行。

`message.id` SHALL 校验格式（Super-agent 的确定性 ID 是 32 位小写十六进制，
`src/core/ids.ts:3-5`）；不符合 SHALL 拒绝写入并 `report` 一条健康错误，
SHALL NOT 静默接受任意字符串。该检查防的是本地文件被外部脚本写入伪造行后抑制真实回写，
不是身份认证。

该文件 SHALL NOT 被当作执行状态：`reply` 在 Super-agent 同时承载 answer、result 与 attention
（`OutboundMessage.kind` 只有三种），worker 的 progress 从不过 Channel。因此面板的"回答过/
已完成/待回答"SHALL 全部从 Ticket 投影读取，`tasks.jsonl` 只用于展示"哪些消息送达过"。

`channel.send` SHALL 返回 `'sent'`；只有在待办已从 `tasks.json` 被删除时才 SHALL 返回
`'gone'`，使 Super-agent 丢弃该消息而不是无限重试。

`channel.link(address)` SHALL 返回面板深链（`/workmate/?task=<taskId>`），无宿主面板时
SHALL 返回空 `url` 而不报错。

`channel.allowed(address)` SHALL 在待办仍存在时返回 `true`。

#### Scenario: 结果写回且幂等

- **WHEN** 同一 `message.id` 被投递两次
- **THEN** `tasks.jsonl` 只有一行；面板显示该结果

#### Scenario: 待办被删除后不再重试

- **WHEN** 待办已从 `tasks.json` 删除，而 Super-agent 仍要回写
- **THEN** `channel.send` 返回 `'gone'`，消息被记为该来源不再接收

### Requirement: 有界上下文读取

该 kind SHALL 实现 `threadContext.read(commands, trigger, part, cursor, config)`，
支持 `thread`（按时间分页，`cursor` 向前翻页）、`root`（该待办原始意图）与
`parent`（人消息所回复的那条）。

当待办的 `proposalId` 非空且实例配置了 `repoRoot` 时，`root` SHALL 额外以带
`path`/`line` 的 `ContextMessage` 给出来自
`<repoRoot>/<openspecRoot>/changes/<proposalId>/` 的 `proposal.md`、`design.md`、
`tasks.md` 摘录：固定顺序、每文件字符上限、超出部分给续读入口（Inline & Spill）。
未关联提案或未配置 `repoRoot` 时 SHALL 只读任务历史，SHALL NOT 扫描仓库其他目录。

工件路径 SHALL 校验：`proposalId` SHALL 匹配 `^[a-z0-9][a-z0-9-]*$`，拼接结果 SHALL
经 `path.resolve` 后仍位于 `<repoRoot>/<openspecRoot>/changes/` 之内；不满足时 SHALL 跳过
工件读取并 `report` 一条健康错误，SHALL NOT 读取任何越界文件。

返回的 `ContextMessage` SHALL 带稳定 `id`、`from`、`at`、`text`；机器写入的行 SHALL 标记
`bot: true`，使它们永远不能单独授权新工作。读取 SHALL 有页大小上限，SHALL NOT 一次返回
整份历史。

`threadContext.messageId(trigger)` SHALL 返回承载该 Trigger 的消息 id。

#### Scenario: 分页读取

- **WHEN** 某待办有 200 条历史，评估读取第一页
- **THEN** 只返回页大小内的最新消息与 `next` 游标

#### Scenario: 机器行不授权

- **WHEN** 上下文里包含 Source 自己写入的 `notice` 行
- **THEN** 该消息带 `bot: true`，不构成对人的请求的授权

#### Scenario: 关联提案时读到方案

- **WHEN** 待办带 `proposalId` 且配置了 `repoRoot`
- **THEN** `root` 返回带文件路径与行号的 `proposal.md`/`design.md`/`tasks.md` 摘录，
  超出上限的部分可通过游标续读

#### Scenario: 未关联提案不扫仓库

- **WHEN** 待办没有 `proposalId`
- **THEN** 上下文只包含任务历史，不读取任何 `openspec/` 文件

### Requirement: 执行环境变量与策略

该 kind SHALL 注册执行环境变量（`environment.variables` + `values`），至少：
`DSH_SUPERAGENT_WORKMATE_TASK`、`_ACCEPTANCE`、`_PRIORITY`、`_BASE_BRANCH`、
`_PORTS`、`_COPY`，可选 `_PROPOSAL`。值 SHALL 来自当前待办与部署配置；
SHALL NOT 包含任何凭据。

`_BASE_BRANCH` SHALL 是该待办的基线分支，`_PORTS` SHALL 是逗号分隔的端口段，
`_COPY` SHALL 是需要从主检出复制的文件列表（空白分隔）；这三项 SHALL 供 `prepare`
命令直接使用，使 worker 的 worktree 由 Super-agent 创建而不是由 WorkMate 预先创建。

**取值来源必须可达**（`environment.values({ deployment, config, trigger })`，
签名见 `src/sources/kind.ts:25`）：`_PORTS` SHALL 取自 Trigger 的 `meta.ports`（Source 在
投递时从任务记录写入，因此 `meta` SHALL 增加 `ports: number[]`）；`_COPY` SHALL 取自来源实例
配置的 `copyFiles`（`schema` SHALL 含该字段，默认 `['.env', '.env.local']`）；
SHALL NOT 依赖读取任务文件的实时状态——`values` 只在投递时按 Trigger 计算一次。

该 kind SHALL 实现 `policy`（`allowed` + `admission` 表）：默认只允许安装方显式列入的
创建者发起工作；面板来源的显式请求 SHALL 能被配置为 `explicit` 准入。

#### Scenario: 变量进入 prepare 与 worker

- **WHEN** 某待办产生 Ticket 并准备目录
- **THEN** prepare 命令与 worker 提示都能读到该待办的验收标准与基线分支

#### Scenario: 未授权创建者被拒

- **WHEN** 某待办的 `createdBy` 不在 allowed 列表且准入表未放行
- **THEN** 该 Trigger 被 Eval 前的 gate 拒绝并记录原因

### Requirement: 健康、事实与查找

该 kind SHALL 声明并只报告自有健康条目，至少报告：读取失败、配置问题、等待依赖条数、
投放失败的待办数。健康条目 SHALL 只在连续多轮失败后才报 `error`，单次读取失败 SHALL
只记录在该 Thread 上（沿用 Super-agent 对 Source 失败的既有纪律）。

该 kind SHALL 实现 `find(query)`：支持按任务标题与 `taskId` 找到对应 Thread。

该 kind SHALL 实现 `facts(deployment)`（签名是 `facts(deployment: Deployment | undefined)`，
没有 config 参数，见 `src/sources/kind.ts:91`）：返回任务文件路径、已挂起待办数与上次扫描
时间等只读事实；这些值 SHALL 来自 Source 自己的 `state`（KV），SHALL NOT 在 `facts` 里读盘。

#### Scenario: 单次失败不报警

- **WHEN** 某一轮读取任务文件抛错，下一轮恢复
- **THEN** 健康条目保持可用，错误记在该 Thread 上

#### Scenario: 可搜索

- **WHEN** 在面板搜索框输入某个任务标题
- **THEN** `find` 返回该任务对应的 Thread key

### Requirement: Thread 描述与回复关联

该 kind SHALL 在该待办的 Thread 经首个 Trigger 的 `receive` 建立之后调用
`threads.describe(key, { label, facts })`（`describe` 对不存在的 Thread 是 no-op，
先描述会丢失），把标题、仓库、优先级与验收标准发布到 Super-agent 自己的 Thread 页；
label SHALL 是待办标题，SHALL NOT 是内部 ID。

该 kind SHALL 实现 `repliesTo(trigger)`：当 `inputs.jsonl` 的行声明了 `replyTo` 时返回该
消息 id，使 Super-agent 能把回答挂到正确的上一条消息；无 `replyTo` 时返回 `undefined`。

#### Scenario: 来源页可读

- **WHEN** 打开 Super-agent 的 Trigger/Thread 页并查看该来源
- **THEN** 每个 Thread 显示待办标题与仓库/优先级事实，而不是裸 ID

#### Scenario: 回复挂到正确消息

- **WHEN** 人回答的是某条提问而不是最新消息
- **THEN** Trigger 的回复关联指向前一条消息，Super-agent 的 Thread 视图据此缩进显示
