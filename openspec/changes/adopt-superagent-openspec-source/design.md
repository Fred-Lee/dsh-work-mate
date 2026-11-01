# Design — 把待办做成 Super-agent 的原生 Source

## Context

Super-agent 的领域模型只有一组概念：Source、Trigger、Thread、Channel、Policy、Eval、
Mandate、Ticket、Assignment、Subscription。它的 `SourceKind` 接口不是"适配器"，而是
**外部世界接入的唯一方式**：一个 kind 自带配置 schema、设置表单字段、健康条目、监听范围、
出站信道、有界上下文读取器、搜索、策略分片、执行环境变量和只读事实。

GitHub 与飞书就是按这个接口接进去的（`src/sources/github.ts:113`、
`feishu.ts:133`）。一个本地待办板和它们没有本质区别：它同样是一个外部世界的事件流，
同样需要"读取位置、什么算一个事件、回复写到哪里、评估时能看到什么上下文"。

上一版方案站在这个接口**外面**：自己存任务、自己算状态、用 HTTP 把 Trigger 推进去、
用代理读回 Ticket、再靠手写 profile 行避免整包被自动启用。这四个问题 Super-agent 已经
解决过，重复解决只会多出三份真相和一条易碎的接线。

本设计的选择是：**待办板成为一个真正的 Source**，WorkMate 只保留它独有的治理与知识。

### 已核实的契约事实

| 事实 | 证据 | 影响 |
| --- | --- | --- |
| SourceKind 必填 6 个字段 | `src/sources/kind.ts`：`kind/title/description/schema/fields/health` | 必须提供 zod schema 与设置表单 |
| `schema` 是 zod（调用 `safeParse`/`parse`） | `src/sources/registry.ts:57,72,135` | 子包 peer 依赖 `zod ^4`（原型用 4.4.3） |
| Source 可读 Ticket / Thread / Trigger | `src/sources/host.ts:46-62` | 投影可在进程内做，不需要 HTTP |
| Source 可注册环境变量 | `kind.ts` `environment.variables/values` | 任务事实进 worker，而非塞 prompt |
| Source 可提供有界上下文 | `kind.ts` `threadContext.read(part,cursor)` | 评估能读任务与工件，按页取 |
| Source 可声明策略分片 | `kind.ts` `policy.allowed/admission` | 谁可以创建待办由配置决定 |
| 等待属于 Source | `docs/001-domain.md` 拒绝概念表："A condition that needs waiting is an ordinary Source" | 依赖门控放在 Source |
| 装载会自动启用 bundle | `packages/boot/app-boot/src/profile-plugins.ts:101-125` | 独立包才能"装即启用"，整包方案会被连带启用 |
| 一次性委派不能当执行器 | `dsh-subagent-claude-code/README.zh.md` 已知限制 | Claude/Codex 只是 worker 内部手段 |

## Goals / Non-Goals

**Goals**

- 用 Super-agent 的原生 Source 接缝接入待办，不新增 HTTP 触发、不镜像状态、不手写接线。
- 让任务文件成为唯一的"人的输入"权威，执行事实全部来自 Super-agent。
- 把依赖等待、上下文读取、环境变量、策略与健康都放在 Source 应有的位置。
- 保留 WorkMate 独有的治理与知识，并明确它们在执行链路中的位置（ready 之后）。
- 迁移可回退：`taskExecutor=team` 仍可用。

**Non-Goals**

- 不改 Super-agent 的 Eval / Policy / Outbox / Effects / 领域模型。
- 不新增"待办"这一 Super-agent 概念；待办只是 Source 的事件。
- 不接 IM；不做云端存算分离；不做多实例编排。
- 不把 Claude Code / Codex 当作 Ticket 执行器。

## Decisions

### D1: 待办板是 Source，不是外部桥

**选择**：`workmate` kind，`kind='workmate'`，Thread key `workmate:<taskId>`。
**理由**：Source 的职责恰好覆盖"建待办 → 变成可执行请求 → 回写结果 → 给评估提供上下文"
的全部需求；用它就不需要自己再实现状态与投递语义。
**备选**：外部面板 + HTTP 触发（上一版）、GitHub Issue 作为载体、同进程直写 Engine。
前者重复造状态；中者污染 issue 列表且延迟一个轮询周期；后者绕过 Eval 的授权模型。

### D2: 独立 bundle 包，装即启用

**选择**：`packages/superagent-source/`，包名 `workmate-superagent-source`，自己声明
`dsh.bundle.patch`，`cordis.patch.yml` 只有一条 entry。装进 Super-agent 的 profile 后由
插件管理器自动启用。
**理由**：宿主会把任何声明了 bundle patch 的新依赖自动加入 `dsh.profile.bundles`
（`profile-plugins.ts:101-125`）。独立包让这套机制站在这边；整包方案会被连带启用主入口。
**备选**：同包第二入口 + 手写接线（会在下一次插件管理器操作时被自动启用整包）；
改 Super-agent 源码（跨仓交付且它的 `SourceKind` 未从包根导出）。

包内模块级 `inject` SHALL 为 `['orchestrator']`：这个包的唯一存在理由就是跑在
Super-agent 里，硬依赖是准确的自我描述；装错 profile 时它保持等待而不是半死不活。

### D2c: 仓库结构——根包保持单包，子包放进 `packages/`

**选择**：根目录仍是可安装的 `workmate4dsh`，新增 `pnpm-workspace.yaml`（只含
`packages/*`），子包放 `packages/superagent-source/`，各自有自己的 `package.json` 与
`cordis.patch.yml`。
**理由**：子包必须能被单独安装进 Super-agent 的 profile；如果它和主包共用一个 bundle
patch，宿主会把主入口一起插进去（见 D2 的备选分析）。把子包物理隔离是最直接的办法。
**代价**：仓库从"单包"变成"根包 + workspace 子包"，`pnpm install` 的语义与 lockfile
会变化。缓解：workspace 只含 `packages/*`，根包字段不变；profile 的 `link:` 直接指向根
目录，不受 workspace 影响；子包不发布到 npm，只在本地 `link:` 安装。
**边界**：根包的 `files` 不包含 `packages/`，所以发布根包时子包不会随之打进去——
这是有意的，两者本就分开安装。

### D3: 三份文件、三个单写者

| 文件 | 写者 | 内容 |
| --- | --- | --- |
| `tasks.json` | WorkMate 面板 | 人的意图与指派/放弃标记（原子写，损坏 fail-closed） |
| `inputs.jsonl` | WorkMate 面板 | 人后续的回答与补充（append-only） |
| `tasks.jsonl` | Source | 经 Channel 送达的消息（ack / reply / notice / error；append-only） |

**理由**：Super-agent 的 Outbox 用 receipt 保证"一条消息只发一次"，Source 用读取位置
保证"一个事件只收一次"。把两端的写入拆开，就不需要文件锁，也不会出现"面板覆盖了
Source 刚追加的行"。

**边界（审查修正）**：Channel 的 `OutboundMessage.kind` 只有 `acknowledgement` / `reply` /
`notice` 三种，且 `reply` 同时承载 answer、result 与 attention（`src/core/replies.ts:16,69-74,86`）。
因此 `tasks.jsonl` **不能**用来区分"进展/提问/结果"，也收不到 worker 的 progress——progress
走 relay 进主会话（`src/app/notices.ts:121-128`），从不经 Channel。落盘只记"这条消息经该
信道送达"，阶段与提问一律从 Ticket 投影读取。
**备选**：单一 `tasks.json` 两端读写（需要锁，且整表重写会丢追加）；只用 Super-agent 的
KV（面板进程读不到）。

### D4: 完整实现 SourceKind 的可选契约

**选择**：实现 `scope`、`channel`、`threadContext`、`find`、`policy`、`environment`、
`facts`、`health`，并全部接入。
**理由**：这不是"为了显得原生"，每一条都替代了一处外部桥的实现：
- `channel` → 替代 HTTP 回写；
- `threadContext` → 替代"把整份任务描述塞进 prompt"；
- `environment` → 替代 WorkMate 自己拼 prepare 参数；
- `policy` → 替代"面板操作者永远可信"的假设；
- `find` → 替代 WorkMate 自己建搜索索引；
- `health` → 替代"面板轮询探测它是否活着"。
**备选**：只实现必填字段 + 自建 HTTP 桥。否决：等于把上面六件事再做一遍。

### D5: 依赖门控在 Source，不在 Eval

**选择**：`dependsOn` 未满足的待办不产生 Trigger；健康条目显示等待数。
**理由**：Super-agent 明确把"需要等待的条件"归给 Source；Eval 每次只能看当前 Thread，
看不到别的 Thread 的完成情况。把门控放在 Source 是一次扫描、一次判断，且不浪费 Eval。
**备选**：先投递再让 Eval 忽略。否决：会产生大量噪音 Decision，也会让"待办被忽略"和
"前置未完成"无法区分。

### D6: 执行事实不镜像

**选择**：面板显示阶段时读取 Super-agent 的 Ticket 事实；`tasks.jsonl` 只记录**经由
Channel 投递的消息**，不是 Ticket 状态的副本。
**理由**：
- 阶段表是 Super-agent 的领域事实，镜像必然漂移（它已有 7 行阶段，还要处理 resume/retry）；
- Channel 消息是 Source 的出站事实，写进任务文件正是"消息已送达该信道"的证明，
  与 Super-agent 的 Outbox receipt 语义一致。
**备选**：Source 每轮把 Ticket 快照写进投影文件。否决：那是缓存，还要自己定义新鲜度与
失效；面板直接读权威更简单。
**读取方式**：面板宿主以服务端代理读取 `GET /orchestrator/api/tickets` 与
`GET /orchestrator/api/tickets/:id`（带 `x-orchestrator-request: 1`，仅 loopback）。
**字段名（审查修正）**：视图把目录拍平成顶层 `directory`（`src/app/views/records.ts:129`），
不是 `execution.directory`；空串会被省略，因此读不到时显示 `unknown`，不猜。
同一响应还包含 `environment`（`src/app/http.ts:116-120`），可直接看到该 Ticket 的环境变量。

### D7: 任务事实通过环境变量交给 worker

**选择**：`environment.variables` 注册 `DSH_SUPERAGENT_WORKMATE_TASK`、
`_ACCEPTANCE`、`_PRIORITY`、`_BASE_BRANCH`、可选 `_PROPOSAL`；`values({trigger})`
从 Trigger 的 `meta` 取。prepare 命令与 worker 提示都能读到。
**理由**：Super-agent 已有的执行环境机制就是为此设计的；prompt 里塞整段任务既超长又
不可机检。
**备选**：把任务写进 Trigger text。否决：text 是"人说的话"，不是结构化事实。

### D8: 有界上下文读取

**选择**：`threadContext.read` 支持 `thread`（分页）、`root`（原始意图）、`parent`
（被回复的消息）；机器写入的行标 `bot: true`。
**理由**：这是文章里 Inline & Spill 的原生落点——评估只拿到少量摘要与游标，需要更多时
按引用逐跳展开；`bot: true` 保证机器行永远不能单独授权新工作。
**备选**：把整份 `tasks.json` 内联进 prompt。否决：待办一多就挤爆窗口。

### D9: 身份与授权

**选择**：Trigger 的 `actor` 取待办的 `createdBy`；`human: true`、`addressed: 'mention'`。
部署方在 Super-agent 的 policy 里把操作者加入 `allowed`，并配置接受规则。
**理由**：面板不是"永远可信"的旁路；它必须像 GitHub 上的人一样被允许列表约束。
**备选**：面板自建"谁可以用"的设置。否决：两套授权，且与 Super-agent 的 Policy 版本脱节。

### D9b: 走 explicit 准入，不要求配置接受规则

**修正（审查发现原论证有误）**：原写"admission 表只决定门禁强度，`assessmentOutcome` 仍要求
至少一条规则匹配，绕不过去"——这是错的。Super-agent 对 `strength === 'explicit'` 的候选
**不走** `assessmentOutcome`（`src/app/assessment.ts:113` 直接抛 `EXPLICIT`），而是把它作为
候选卡交给主 Session 的 `orchestrator_route`，由 `engine.decide(accept)` 直接建单
（`src/app/tools/main.ts:95-105`）；`evals.decide` 只在非 explicit 时校验规则
（`src/core/evals.ts:152-154`）。

**选择**：待办的 Trigger 用 `actor: { source: 'workmate', id: 'workmate:<createdBy>' }`、
`human: true`、`addressed: 'mention'`；部署方把 `workmate:<createdBy>` 加入该来源的
`policy.allowed` 即可获得 **explicit** 强度，**不需要写任何接受规则**。
**理由**：规则匹配是 inferred 候选的门槛；explicit 的语义本来就是"一个被允许的人明确要求"，
与面板创建的待办恰好一致。少一条配置，少一类"配错就全被忽略"的故障。
**代价与边界**：explicit 的候选仍由主 Session 路由（可能是另一个 LLM 的取舍），所以不是
"零判断"；若部署方希望连路由也省掉，唯一的替代是把 `unlistedAddressed` 配成 explicit，
但那会放开未列入 allowed 的人——不推荐，且 SHALL NOT 作为默认。
**回落**：若有人坚持走 inferred（例如批量导入的场景），才需要规则文本；接入手册保留该说明，
但默认路径不要求。

### D9c: 有提案时读 OpenSpec 工件，作为有界上下文

**选择**：`threadContext.root` 在 `proposalId` 非空且配置了 `repoRoot` 时，额外返回
`<repoRoot>/<openspecRoot>/changes/<proposalId>/` 下 `proposal.md`、`design.md`、
`tasks.md` 的带 `path`/`line` 摘录；固定顺序、每文件上限、超出给续读游标。
**理由**：Eval 的职责是判断"是否在范围内"，而提案是范围的权威载体。只给一句待办原文让
模型猜，是"被忽略"和"做偏"的主要来源。`ContextMessage` 的 `path`/`line` 字段本就是为
代码评论上下文设计的，这不是硬塞。
**备选**：面板在创建时把工件摘录写进任务文件。否决：摘录会过期，而提案会持续修改。
**边界**：未关联提案不扫仓库；不读其他目录；每文件有上限，靠游标展开。

### D9d: 一个实例只服务一个仓库，多仓就多实例

**选择**：面板按待办的 `repo` 判断是否可指派；与实例仓库不一致时显示「未接入执行器」，
不写 `assigned`。多仓库由多个 Super-agent 实例承担；本期只支持一个实例。
**理由**：两处单仓库假设是硬的——`DSH_SUPERAGENT_GITHUB_REPOSITORY` 由 GitHub Source
注册、是部署级 `owner/name`，worker 的 `gh` 操作会指向它；Ticket 跟踪 PR 也依赖 GitHub
Source 的 Thread 订阅，仓库 B 的 PR 既看不到也等不到合并结束。靠 prepare 分支跨仓会
在这两处静默出错。
**备选**：Source 用 `meta.repo` 让 prepare 命令分支。否决：会把"看得见的失败"变成
"看不见的错误仓库操作"。
**代价**：多 target 提案在只有主仓实例时只能执行主仓任务；面板如实标注，第二期按
`repo` 路由到不同 endpoint。

### D10: 回退与降级

- `taskExecutor` 默认 `superagent`；`team` 是显式回退，面板标注"回退执行器"。
- Super-agent 离线：面板仍可写意图（文件不依赖它），卡片显示"执行器离线"，
  SHALL NOT 显示"已投递"。
- Source 未安装/未启用：`GET /workmate/api/tasks` 仍能列出待办，执行列显示 `unknown`。

### D10b: worktree 的所有权：规划归 WorkMate，创建归 Super-agent

Super-agent 的 Executor 已经规定了目录的生命周期：`<executionRoot>/<ticket 短名>`，
首次 launch 时由 `executor.prepare` 命令创建（`executor/dsh.ts:247-262`），
**目录已存在就视为已准备好、不再跑 prepare**（`:434-437`），
且 **Ticket 结束后从不删除目录**（`executor/dsh.ts:247-262`、`docs/003-execution.md:51`）。
WorkMate 现有实现则相反：`ready→implementing` 时在 `<repo>/.workmates/<proposalId>` 建，
`archived` 时删（`manager.ts:111,299`）。两边同时建会得到两个目录，worker 的 cwd 却只在
Super-agent 那个里。

**选择**：把职责拆开。

| 事 | 谁负责 | 落点 |
| --- | --- | --- |
| 基线分支、分支名、端口段、任务 ID | WorkMate（规划） | `tasks.json` + `ports.json` |
| 执行环境变量 | Source | `DSH_SUPERAGENT_WORKMATE_BASE/BRANCH/PORTS/TASK` |
| 创建目录 | Super-agent 的 `executor.prepare` 命令 | 首次 launch 时 `git worktree add "$DSH_SUPERAGENT_DIR" ...` |
| 回收与端口释放 | WorkMate | `archived` 时读 `execution.directory` 后 `git worktree remove` |

执行根 SHALL 配成 `<repo>/.workmates`，使目录仍落在仓库旁、沿用既有排除规则
（`.git/info/exclude` 与 `.gitignore` 里已有 `.workmates/`）。这样既保留"worktree 在仓库旁"
的既有约定，又让 Super-agent 拥有它的 cwd。

**分支命名**：`workmate/$DSH_SUPERAGENT_NAME`。Super-agent 的 PR 归属规则是"分支最后一段
等于 Ticket 短名"（`src/sources/github-pull.ts:26-28`），但成立还需两个前提：PR 由**智能体
账号**从 `deployment.repository` 的 head 仓库开出（`:23-25`），且该仓库有启用中的 GitHub
Source 在轮询。没有 GitHub Source 时不会有任何 PR 绑定——这种情况下工单只能靠 `ready`
报告结束。短名在 Eval 接受后才产生，所以只能由 `prepare` 从环境变量拼，不能由 WorkMate
预先写入。

**prepare 必须幂等**：重试或人在 Thread 上发言后会再次尝试 prepare（`docs/003-execution.md:51`），
而 `git worktree add -b` 在分支已存在时会失败。模板 SHALL 先判断分支/目录是否存在，存在则
复用；SHALL NOT 依赖一次性成功。

**端口**：按任务分配（`${proposalId}--${project}--${taskId}`），随 `attempt` 复用；
`prepare` 把它追加进 `.env`。分配表仍在 WorkMate，因为它是跨进程的全局资源。

**回收前置**：Ticket 已结束 **且** 分支已合并。现在 `remove()` 只校验合并
（`manager.ts:311`），不校验 Ticket 状态；新增后者，避免把仍在执行的 worker 的 cwd 删掉。
Super-agent 不删目录，所以面板必须列出"已结束但目录还在"的遗留项，并提供手动回收。

### D10c: target 的分支与基线由 Ticket 投影回写

`ready→implementing` 不再创建目录后，`targets[].featureBranch` 与 `baseCommit` 失去唯一
写入点，而归档前置（`archive/service.ts:448-459`）和 G5 合并（`:894-905`）仍读它们。
因此 Source 在观察到 Ticket 后 SHALL 把 `execution.directory` 的末段与 `workmate/<短名>`
分支回写到对应 target；`baseCommit` SHALL 在首次观察到该分支时取
`git rev-parse <baseBranch>`。回写 SHALL 幂等，SHALL NOT 覆盖已存在的不同值（冲突要报错而不是静默改）。

### D11: 保留、降级与删除

| 组件 | 处理 |
| --- | --- |
| `proposal` / OpenSpec / `planHash` / G2 | 保留，成为执行前的方案门 |
| 写域机检、计划漂移、审查独立性、审查证据门 | 保留，成为 `ready` 之后的收口 |
| 多 target worktree 与隔离视图 | 保留规划与回收；创建移到 Super-agent 的 `prepare`（见 D10b） |
| GitNexus / wiki / vault / 语义检索 | 保留，独立于执行链路 |
| `TeamRunner` / `TeamCoordinator` / 角色派发 | 默认关闭；`team` 模式下才启用 |
| 团队控制台 | 降为只读投影 |
| `metrics` / `bands` / `decision` | 本期不动，但不再作为主视图的默认内容 |

## 配置

主入口（`src/config.ts`，Schemastery 与 interface 同步）：

```ts
taskExecutor: 'superagent' | 'team' = 'superagent'
taskFile: string   // 默认解析为 <$DSH_HOME>/workmate/tasks.json 的绝对路径；面板展示它
superagentEndpoint: string = 'http://127.0.0.1:3082'
superagentTimeoutMs: number = 5000
superagentPollSeconds: number = 5
metricsEnabled: boolean = false
```

子包（Super-agent 的 source 实例配置，zod）：

```ts
taskFile: string          // 必填，绝对路径，无默认（必须填 WorkMate 展示的那个路径）
pollSeconds: number = 5
maxPerScan: number = 5        // 单轮最多投递条数；回答不受此限
maxRowsPerTask: number = 200  // tasks.jsonl 单待办行数上限，超出则压缩
interactive: boolean = false   // 只读/投递的总闸
copyFiles: string[] = ['.env', '.env.local']
repoRoot?: string         // 有它才读 OpenSpec 工件
openspecRoot?: string = 'openspec'
```

**两侧必须指向同一个 `taskFile`。** 这是唯一的隐式耦合：WorkMate 的 profile 与
Super-agent 的 profile 可能使用不同的 `$DSH_HOME`（后者有自己的 `stateDir` 配置，
`src/deployment.ts:16`），因此 `taskFile` SHALL 由安装方显式填写绝对路径，
SHALL NOT 依赖两端各自推导。面板的健康检查 SHALL 在启动时比对"我写的文件"与
"Source 配置的文件"是否一致，不一致时显示明确错误而不是静默不同步。

## 接口（WorkMate 面）

| 端点 | 方法 | 作用 |
| --- | --- | --- |
| `/workmate/api/tasks` | GET | 任务卡 + 投影后的阶段（服务端聚合三份文件 + Ticket） |
| `/workmate/api/tasks` | POST | 新建待办（三种方式之一） |
| `/workmate/api/tasks/:id/assign` | POST | 置 `assigned=true`、`abandoned=false`、`attempt+1` |
| `/workmate/api/tasks/:id/reply` | POST | 追加到 `inputs.jsonl` |
| `/workmate/api/tasks/:id/retry` | POST | 同 assign，但要求当前 attempt 已失败 |
| `/workmate/api/tasks/:id/stop` | POST | 代理 Super-agent 的 stop 并置 `abandoned` |
| `/workmate/api/tasks/:id/reopen` | POST | 置 `abandoned=false`，不递增 attempt |
| `/workmate/api/superagent/health` | GET | 代理探测 `GET /orchestrator/api/state` |
| `/workmate/api/worktrees/leftover` | GET | 已结束但目录仍在的 Ticket |
| `/workmate/api/worktrees/reclaim` | POST | 手动回收（二次确认在面板） |

所有动作写 `events.jsonl`（动作、任务 ID、操作者、结果）。

## 数据格式

```ts
// tasks.json · version 1 · 只由面板写
interface TaskFile {
  version: 1
  tasks: Array<{
    id: string                     // task-<ts>-<n>
    title: string
    intent: string                 // 人写原文，不改写
    repo: string
    baseBranch: string
    acceptance: string
    priority: 'P0' | 'P1' | 'P2'
    mode: 'superagent' | 'proposal' | 'record'
    dependsOn: string[]
    assigned: boolean
    abandoned: boolean
    attempt: number
    createdBy: string              // workmate:<name>
    proposalId?: string
    /** 端口段（WorkMate 分配，Source 注册为环境变量） */
    ports?: number[]
    createdAt: string
    updatedAt: string
  }>
}
```

```ts
// inputs.jsonl · 只由面板追加（seq 单调递增，由面板在持有写锁时分配）
{ seq: number, taskId: string, text: string, by: string, at: string, replyTo?: string }
// tasks.jsonl · 只由 Source 追加（送达记录，不是执行状态）
{ seq: number, taskId: string, kind: 'ack'|'reply'|'notice'|'error',
  messageId?: string, text: string, at: string }
```

## SourceKind 实现骨架

```ts
export const name = 'workmate-superagent-source'
export const inject = ['orchestrator']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(kind), 'workmate: source kind')
  ctx.effect(() => { const stop = watch(ctx.orchestrator.context(kind)); return stop }, 'workmate: watch')
}

const kind: SourceKind = {
  kind: 'workmate',
  title: { zh: 'WorkMate 待办', en: 'WorkMate tasks' },
  description: { zh: '…', en: '…' },
  schema,            // zod: taskFile / pollSeconds / interactive / repoRoot? / openspecRoot?
  fields,            // 设置表单字段
  health: ['workmate'],
  scope({ meta }) { return { listened: true, observed: false } },
  channel: { allowed, send, link },
  threadContext: { messageId, read },
  find(query) { … },
  policy: { schema, fields, explicit },
  environment: { variables, values },
  facts(config) { … },
}
```

## 与 ReAct / ReWOO 的关系

这个问题值得单列，因为二者在本方案里扮演不同角色。

**执行侧是 ReAct。** Super-agent 的 worker 是标准的 ReAct 循环：模型交替进行推理与工具
调用（`bash` / `fs` / `subagent`），直到调用 `orchestrator_report` 结束。它的循环不被外层
打断——WorkMate 无法、也不应该干涉 worker 的第 N 步。

**但异步性不在 ReAct 层面。** 文章 §4.1 说的异步 ReAct（`start()` 立即返回、结果作为新事件
投递）**在 Super-agent 里对上游是隐式成立的**，因为上游根本没有"调用 worker"这个动作：
WorkMate 投递 Trigger 后就返回，worker 何时开始、跑多少步、何时报告，全部通过
Ticket/Assignment 事实观察。这比在 ReAct 里加 `start`/`stop` 工具更彻底——**待办板不是
ReAct 的一个动作，而是它的上游事件源。**

**循环本身在哪：**
1. Source 的扫描循环（`pollSeconds`）—— 读意图、投递 Trigger；
2. Super-agent 的 Eval/Ticket/Assignment 循环 —— 接受、派发、等待汇报；
3. worker 的 ReAct 循环 —— 逐步执行；
4. 人的观察循环 —— 面板读取阶段、回答、验收。

第 4 个循环是本方案**唯一新增**的循环，也是最容易被做成阻塞式的那一个。因此
`task-intake` 要求阶段只读投影、动作只写意图，面板 SHALL NOT 自己"驱动"任何一步。
人在面板点"回答"，等于在 Thread 上说一句话，不是给 worker 发一个同步请求。

**为什么不做 ReWOO（先规划全部步骤再执行）。** Super-agent 的 Eval 已经承担了"先判断
要不要做、范围到哪"，而 worker 内部仍是 ReAct。若在 WorkMate 侧再做一次全局规划
（把待办拆成步骤树、预先生成工具调用），会出现两层规划互相推翻，且与"Eval 是唯一
授权入口"冲突。`TASKS.json` 的 DAG 只在团队模式保留，正是这个边界的体现。

**代价。** 待办板无法给 worker 提供"第 3 步失败就回滚第 2 步"这类跨步控制——它只能
看到 Assignment 的终态与 report，中间步骤是黑盒。这是 Super-agent 刻意的信息边界
（"推理、工具通信、usage、diff 不进父会话"），接受它，换取并发与恢复能力。

## 与既有能力的边界

| 既有能力 | 本变更后 | 边界规则 |
| --- | --- | --- |
| 八态提案 | 保留 | 执行事实不再推进状态；`implementing` 前置按执行器分流 |
| `planHash` / G2 | 保留 | 批准后写待办，不再建 Run |
| 写域机检 / 计划漂移 / 审查独立性 / 审查证据门 | 保留 | 仍在 `ready` 之后判定，读取 Ticket 证据与任务报告 |
| `teamEvidenceGate` | 保留 | 有 `TASKS.json` 的变更仍要求 `TEST.md` / `TEAM-REVIEW.md` |
| 归档编排 | 保留 | 回收 worktree 改读 Ticket `directory`；其余步骤不变 |
| Swarm（任务级并行） | 冻结 | 与 `taskExecutor` 无关；不再作为默认执行路径 |
| TeamRunner / 角色派发 | 回退 | 只在 `taskExecutor=team` 时启用 |
| metrics / bands / decision | 冻结 | 默认不渲染；不再新增节点 |
| GitNexus / wiki / vault | 保留 | 与执行链路无耦合 |
| `/workmate` 斜杠命令 / chat action | 视使用情况 | 不在本变更范围 |

## Risks / Trade-offs

- **原型不稳定**（`private`、单提交、research code）→ 独立包、结构类型、契约测试、
  `taskExecutor=team` 回退；桥接失败不影响提案与归档。
- **zod 版本耦合**（`schema` 必须是 zod，Super-agent 用 4.4.3）→ 子包把 `zod ^4` 作为
  **直接依赖**而不是 peer：pnpm 的隔离 node_modules 不会把 Super-agent 的嵌套 zod 提升到
  profile 根，peer 解析容易落空；两份 zod 并存是安全的，因为 `schema` 只被当作
  带 `safeParse`/`parse` 的对象使用，没有 `instanceof` 依赖。
- **Eval 可能忽略待办**（`assessmentOutcome` 要求至少一条规则匹配）→ D9b：不预置规则、
  不写对方配置；接入手册给可粘贴文本；面板如实显示"已投递评估 / 已忽略 + 原因"。
- **单仓库**（`deployment.ts:46`）→ D9d：面板按 `repo` 判断可指派性，非本仓显示
  「未接入执行器」；多仓靠多实例，不靠 prepare 分支。
- **工件读取的新鲜度** → 每轮读取磁盘上的当前文件，不做缓存；摘录带上 `path`/`line`，
  用户与模型都能据此判断是否过期。
- **两套 worktree 同时存在**（旧 `ready→implementing` 创建 + 新 prepare 创建）→ D10b：
  关闭旧路径；已存在的 worktree 由迁移脚本识别为兼容项，不重复创建。
- **分支改名影响 PR 归属** → `workmate/<短名>`；旧的 `feature/<id>` 只用于回退执行器。
- **Super-agent 不删目录** → 面板列出遗留项并提供手动回收；自动回收只发生在归档并满足前置。
- **依赖门控只有单层** → 不做跨仓库 DAG；复杂依赖仍由 `TASKS.json` 的规划结果展开成
  多个 `dependsOn` 链。
- **Channel 的 `link` 深链**依赖 WorkMate 面板可达 → 不可达时返回空 url，不报错。
- **面板滚动契约回退** → 保留 `fix-panel-scroll`，真机截图验收（jsdom 测不出）。

## Migration

- 新增文件，无数据迁移；`tasks.json` 不存在视为空。
- **回滚需要三件事，缺一不可**（审查补充）：① `taskExecutor=team`；② 停用
  `workmate-superagent-source` bundle；③ 运行一次回收脚本，按 Ticket 投影的 `directory`
  清理 `workmate/<短名>` 的 worktree 与分支，并释放新键（`${proposalId}--${project}--${taskId}`）
  占用的端口。缺少 ③ 时，回退后目录与端口会永久泄漏。
- **已进入 implementing 的提案**：`featureBranch`/`baseCommit` 原先只在 implementing 副作用里
  写入（`archive/service.ts:496-518`）；新路径下该副作用不再建目录，必须由 Ticket 投影回写，
  否则归档前置（`service.ts:448-459`）与 G5 合并（`:894-905`）会因缺分支而失败。见 D10c。
- 首次上线建议只启用 `interactive=false`（Source 只读、不产生 Trigger），先用
  面板验证"待办 → Thread → 评估"的投影是否正确，再打开。

## 已收口的决定

原列的三个开放问题已全部决定，不再作为待定项：

| 问题 | 决定 | 依据 |
| --- | --- | --- |
| 是否预置接受规则 | **不预置、不代写**；手册给可粘贴文本，面板显示忽略原因 | 规则属于部署方 Policy；Source 读不到也写不了（D9b） |
| 是否读 OpenSpec 工件 | **读**，仅当 `proposalId` 非空且配置 `repoRoot`；带路径行号、有上限、可续读 | 提案是范围的权威载体；`ContextMessage.path/line` 本就为此设计（D9c） |
| 多仓库怎么做 | **一实例一仓库**；面板按 `repo` 判断可指派；多仓多实例 | `DSH_SUPERAGENT_GITHUB_REPOSITORY` 与 PR 订阅都是部署级单仓库（D9d） |

遗留的真·未知（不影响本期实现）：面板与 Super-agent 跨进程的刷新方式（本期轮询 5 秒，
后续可换它的领域事件）；子包是否在第二期上游到 Super-agent 仓库。
