# Review — 把 WorkMate 的待办做成 Super-agent 的原生 Source

> 交叉一致性审查报告。四节标题为机器可读约定，禁止改名或增删。
> `## CRITICAL 问题

<!-- 每条一个 checkbox，未勾选即阻断归档。 -->

- [x] CRIT-10 已解决：worktree 所有权未定义，两侧会各建一个目录，worker 的 cwd 只在
  Super-agent 那个里。已新增 `worktree-plan` capability 与 design D10b：WorkMate 只出计划
  （基线、分支名、端口）与回收，创建交给 `prepare`；`ready→implementing` 不再建目录。
- [x] CRIT-11 已解决：分支命名 `feature/<proposalId>` 无法绑定 PR，且同仓多 target 撞名。
  已改为 `workmate/$DSH_SUPERAGENT_NAME`，并说明短名只能由 `prepare` 从环境变量获得。
- [x] CRIT-12 已解决：端口键按提案分配会让一个提案的多条 Ticket 共用一段。已改为
  `${proposalId}--${project}--${taskId}`，`attempt` 复用，旧键在回收时兜底。
- [x] CRIT-13 已解决：回收不检查 Ticket 是否结束，可能删掉活跃 worker 的 cwd。已把
  "Ticket 已结束"加为回收第二前置，并在面板暴露遗留目录与手动回收。
` 中的每个条目是 checkbox：`- [ ]` = 未解决（阻断归档），
> `- [x]` = 已解决。

## 确认项

- [x] 确认：Source 是 Super-agent 唯一的扩展接缝。`src/sources/github.ts:113` 与
  `feishu.ts:133` 均以 `ctx.orchestrator.sources.register(kind)` 接入；管理 API 路由表
  （`src/app/http.ts:151-218`）没有创建工单端点，故"待办 → Trigger"是唯一直路。
- [x] 确认：`SourceKind` 六个必填字段（`kind/title/description/schema/fields/health`）
  与九个可选能力（`scope/channel/threadContext/find/repliesTo/policy/environment/
  refreshLabels/facts`）确实存在，spec 的「完整契约」逐条有落点。
- [x] 确认：`schema` 必须是 zod。`src/sources/registry.ts:57,72,135` 调用
  `kind.schema.parse` / `safeParse`；原型 `package.json` 为 `zod 4.4.3`。
- [x] 确认：Source 在进程内可读执行事实。`src/sources/host.ts:46-62` 暴露
  `threads.get/subscribed/describe/patch`、`tickets.get/open`、`triggers.get/latest`，
  故"不镜像状态、面板直接读权威"可行，不需要新建投影文件。
- [x] 确认：等待属于 Source。`docs/001-domain.md` 的拒绝概念表写明
  "A condition that needs waiting is an ordinary Source"，与 D5 依赖门控一致。
- [x] 确认：一次性子代理不能当执行器。`packages/subagent/subagent-claude-code/README.zh.md`
  的已知限制列出"不支持续接、恢复、池化、进度流"与"assistant 载荷仅包含最终文本"，
  与 proposal 的非目标一致。
- [x] 确认：独立 bundle 才能"装即启用"。`packages/boot/app-boot/src/profile-plugins.ts:101-125`
  会自动把声明了 `dsh.bundle.patch` 的新依赖加入 `dsh.profile.bundles`；若把入口放在整包里，
  会连带启用主入口。独立包方案消除了手写接线。
- [x] 确认：三份文件的三写者划分没有竞争。`tasks.json`（面板，原子写）、
  `inputs.jsonl`（面板，追加）、`tasks.jsonl`（Source，追加）各只有一端写入；
  Source 的消费游标存在自己的 `state`，不回写面板文件。
- [x] 确认：`tasks.jsonl` 的行种类是封闭且可由 `OutboundMessage.kind` 决定映射的：
  `acknowledgement→ack`、`reply→result`、`notice→notice`，不需要读文本猜种类。
- [x] 确认：回退策略完整。`taskExecutor` 单一开关；新增文件可删；`proposals.json` 与
  `team-runs.json` 结构不变；停用子包 bundle 即可断开桥接。
- [x] 确认：影响面已查。`TeamRunner` upstream 8 个节点、MEDIUM（`src/index.ts` 的
  `execute`/`apply`）；`registerTeamTools` 1 个节点、LOW；`registerApiRoutes` 的调用方为
  `mountWorkmateApi`、`src/api.test.ts`、`projectRouter`。索引落后 HEAD 12 commits，
  实现前 SHALL 先跑 `node .gitnexus/run.cjs analyze` 再复核。

- [x] 确认（worktree 缺口）：本变更原先只在 design 的保留表里写"多 target worktree 保留"，
  没有规定目录所有权与命名，而两套机制实际冲突：WorkMate 在 `ready→implementing` 建
  `<repo>/.workmates/<proposalId>` 并在 `archived` 删（`manager.ts:111,299-340`），
  Super-agent 在首次 launch 时由 `prepare` 建 `<executionRoot>/<ticket 短名>` 且
  **目录已存在即跳过 prepare、Ticket 结束后永不删除**（`executor/dsh.ts:247-262`、
  `docs/003-execution.md:51`）。已用新增 capability `worktree-plan` 与 design D10b 收口。
- [x] 确认：分支命名必须改。Super-agent 的 PR 归属规则是"分支最后一段等于 Ticket 短名"，
  而短名在 Eval 接受后才产生（`executor/dsh.ts:57`），所以只能由 `prepare` 用
  `$DSH_SUPERAGENT_NAME` 拼成 `workmate/<短名>`；`feature/<proposalId>` 既绑不上 PR，
  在同仓多 target 时也会撞名。
- [x] 确认：端口键要按任务。现在是 `${proposalId}--${project}`
  （`manager.ts:127-129`），一个提案的多条 Ticket 会共用一个段；改成
  `${proposalId}--${project}--${taskId}` 并让 `attempt` 复用。
- [x] 确认：回收要先看 Ticket 是否结束。`remove()` 现在只校验合并
  （`manager.ts:311-315`），不校验执行状态；删除活跃 worker 的 cwd 会直接毁掉正在进行的
  工作。新要求把"Ticket 已结束"作为第二前置。
- [x] 确认：`execution.directory` 可从管理 API 读到，所以回收路径有权威来源。
  依据 `src/app/views/records.ts:127` 的 `directory: attribute(ticket.execution?.directory)`，
  经 `ticketLine` → `ticketDetail` 暴露。

- [x] 确认（本轮优化）：proposal 的 What Changes 仍写"两个单写者文件"与"tasks.jsonl 记录进展"，
  与 spec/design 的三文件模型和 Channel 语义冲突；已同步为三份文件与"送达记录"。
- [x] 确认（本轮优化）：design 缺"配置"与"接口"两节，而 tasks 引用了多个端点与配置键；
  已补回，并把 `taskFile` 定为两侧必须相同的绝对路径（Super-agent 的 `stateDir` 是独立配置，
  `src/deployment.ts:16`）。
- [x] 确认（本轮优化）：覆盖矩阵曾漏 1 条需求（`Run / Task / Dispatch 模型` 的标题写法），
  现在 38 条需求全部有任务映射（脚本逐条比对）。
- [x] 确认（本轮优化）：proposal 缺落地切片、成功判据与停止条件；已补，使"什么时候该停"
  成为可执行判断而不是感觉。

- [x] 确认（第二轮）：归档死锁已消除。原设计下，若某 target 的待办被 Eval 忽略、
  从未产生 Ticket，`featureBranch` 永远为空，而归档前置要求"每个 target 的实现分支已合并"，
  提案会永久卡在 merging。已在 `lifecycle-state-machine` 增加"从未产生 Ticket 的 target
  在归档前置中跳过"与"全部无产出时不自动推进"。
- [x] 确认（第二轮）：回滚不再依赖执行器在线。原回滚脚本按 Ticket 投影定位目录，
  但 Super-agent 卸载后投影读不到；已在 `worktree-plan` 增加三级定位（缓存 → 命名推导 →
  目录扫描）与端口缺失显式告警。
- [x] 确认（第二轮）：游标能自愈。`inputs.jsonl` 被截断或替换时，原设计会永久跳过新行；
  已要求 Source 检测"最大 seq < 游标"并回退，`tasks.jsonl` 去重只扫尾部有界窗口。
- [x] 确认（第二轮）：指派后的观察是三个子状态而非两个。原设计把"面板已写入"直接说成
  "已投递评估"，中间跳过一次真实扫描；已拆成"已记录·待扫描 → 已投递·待接受 → 执行中"，
  每步都有服务端事实来源，符合"观察来自动作结果"的纪律。
- [x] 确认（第二轮）：停止条件里"explicit 仍被规则拦截"不可能发生（explicit 不走规则匹配），
  真实失败模式是"没被识别成 explicit、退化成 inferred 后才被规则拦"，已改。
- [x] 确认（ReAct）：执行侧是标准 ReAct（worker 的推理-工具循环），未被本方案触碰；
  异步性来自"投递即返回、结果经 Ticket 事实观察"，比在 ReAct 里加 start/stop 更彻底。
  方案新增的只有"人的观察循环"，且明确禁止面板自己驱动执行步骤。详见 design
  「与 ReAct / ReWOO 的关系」。

## 疑问项

- 疑问（INFO）：面板与 Super-agent 跨进程的刷新方式——本期用 5 秒轮询，后续可换成它的
  领域事件或 SSE。不影响本期实现。
- 疑问（INFO）：子包是否在第二期上游到 Super-agent 仓库（它现在 `private` 且未导出
  `SourceKind` 类型）。本期留在本仓库。

三个原开放问题已收口为决定，见 design 的「已收口的决定」：
不预置接受规则（D9b）、有提案时读 OpenSpec 工件（D9c）、一实例一仓库（D9d）。


## 建议补充项

- 建议（安全）：D9c 的 `proposalId` 直接拼进 `<repoRoot>/<openspecRoot>/changes/<id>/`，
  实现时 SHALL 加 ID 白名单（`^[a-z0-9][a-z0-9-]*$`）与 `path.resolve` 前缀校验，
  防止任意文件被读进模型上下文（任务 23）。
- 建议（安全）：`channel.send` 的幂等依赖 `messageId`，而任务文件是本地可写路径。
  实现时 SHALL 校验 `messageId` 属于当前 Run 的 `OutboundMessage` 命名空间（前缀或长度），
  避免被伪造的行抑制真实回写（任务 23，按 32 位十六进制校验）。
- 建议（文档）：接入手册 SHALL 写明"explicit 准入需要把 `workmate:<createdBy>` 加入
  allowed，不需要写规则"；同时注明 explicit 候选仍由主 Session 路由。
- 建议（可测试性）：以下只能真机验收，SHALL 在任务 26 的验收清单（任务 28 执行）里逐项列出——
  装即启用（bundle 自动激活）、`prepare` 建 worktree、executor 环境变量可见、
  Channel 端到端回写、stop/retry、面板滚动与 320px 布局。
- 建议：`tasks.jsonl` 需要增长上限与轮转策略（例如按 taskId 保留最近 N 行），
  否则长期运行会无限增长（任务 24）；`inputs.jsonl` 的 `seq` 分配规则也要写明
  （单调递增、由面板在持有写锁时分配）。

- 建议：实现前重跑 GitNexus 索引（落后 12 commits），并用 `detect_changes` 复核
  `TeamRunner` / `registerTeamTools` / `registerApiRoutes` 的改动面。
- 建议：为 `tasks.jsonl` 的撕裂尾行与非法行补一条正证与一条反证用例（沿用
  `events.jsonl` 的读取纪律）。
- 建议：子包的 `verify:source` 必须在**没有 orchestrator** 的假 context 下加载一次，
  断言 0 注册、0 throw；这是它"装错 profile 只等待"的证据。
- 建议：面板的滚动与窄屏契约要有真机截图证据（jsdom 无布局引擎，测不出被祖先裁剪）。
- 建议：在 `docs/` 增加《Super-agent 接入手册》，写清 allowed 列表、接受规则、
  taskFile 路径与轮询间隔，以及"指派不等于开工"的人话解释。

## CRITICAL 问题

<!-- 每条一个 checkbox，未勾选即阻断归档。 -->

- [x] CRIT-10 已解决：worktree 所有权未定义，两侧会各建一个目录，worker 的 cwd 只在
  Super-agent 那个里。已新增 `worktree-plan` capability 与 design D10b：WorkMate 只出计划
  （基线、分支名、端口）与回收，创建交给 `prepare`；`ready→implementing` 不再建目录。
- [x] CRIT-11 已解决：分支命名 `feature/<proposalId>` 无法绑定 PR，且同仓多 target 撞名。
  已改为 `workmate/$DSH_SUPERAGENT_NAME`，并说明短名只能由 `prepare` 从环境变量获得。
- [x] CRIT-12 已解决：端口键按提案分配会让一个提案的多条 Ticket 共用一段。已改为
  `${proposalId}--${project}--${taskId}`，`attempt` 复用，旧键在回收时兜底。
- [x] CRIT-13 已解决：回收不检查 Ticket 是否结束，可能删掉活跃 worker 的 cwd。已把
  "Ticket 已结束"加为回收第二前置，并在面板暴露遗留目录与手动回收。


- [x] CRIT-14 已解决：依赖门控原设计用 `tasks.jsonl` 的 `result` 行判定前置完成，
  但 `OutboundMessage.kind` 只有 ack/reply/notice，`reply` 同时承载 answer/result/attention
  （`src/core/replies.ts:16,69-74,86`），提问会被误判成完成；progress 也从不经 Channel。
  已改为读 `ctx.tickets` 的终态事实，`tasks.jsonl` 只用于展示送达记录。
- [x] CRIT-15 已解决：G2 批准后"写实现待办"在 tasks.md 里没有落点。已新增任务 19
  （`service.ts` 的 G2 交接 + 待办写入），并更新覆盖矩阵。
- [x] CRIT-16 已解决：`lifecycle-state-machine` 与 `multi-target-worktree` 仍要求
  `ready→implementing` 建 `feature/<proposalId>`，与本变更冲突。已为这两个 capability 补
  MODIFIED delta，按 `taskExecutor` 分流。
- [x] CRIT-17 已解决：`targets[].featureBranch/baseCommit` 的唯一写入点是 implementing 副作用
  （`archive/service.ts:496-518`），禁用后归档前置（`:448-459`）与 G5 合并（`:894-905`）
  会因缺分支失败。已新增 D10c 与任务 20（从 Ticket 投影回写，幂等、冲突报错）。
- [x] CRIT-18 已解决：子包测试不在 `vitest.config.ts` 的 include（仅 `src/**`），而
  `check-test-integrity.mjs` 仓库级发现 `**/*.test.ts`，`pnpm verify:test` 会红；
  `tsconfig.json` 的 `rootDir: src` 也不覆盖 `packages/**`。已新增任务 21。
- [x] CRIT-19 已解决：`TicketOutcome` 有 5 值（`src/core/model.ts:273`），列映射漏了 `dropped`，
  且 `ticketStage` 把 `ended` 作为第一分支（`src/core/stage.ts:10`）。已补齐五值映射与
  "先判 ended"的约束；覆盖矩阵补「执行器与仓库一对一」。
- [x] CRIT-20 已解决：回滚只讲 `taskExecutor=team`，新端口键与 `workmate/` 目录无人回收。
  已在 Migration 写明"回滚三件事"，并新增任务 22（回滚脚本与演练）。
- [x] CRIT-1 已解决：原 spec 的「任务文件是两个单写者的文件」与正文的三份文件矛盾。
  已改名为「三份文件与三个单写者」，并把 `inputs.jsonl` 的写者与消费游标写清楚。
- [x] CRIT-2 已解决：Channel 行种类原写"按内容映射为 progress 或 result"，无法机检且会
  误判。已改为固定映射 `acknowledgement→ack`、`reply→result`、`notice→notice`，
  并在 design 的 `tasks.jsonl` 枚举同步。
- [x] CRIT-3 已解决：`zod` 若作 peer，pnpm 隔离安装下可能解析不到 Super-agent 的嵌套副本。
  已改为子包**直接依赖** `zod ^4`，并说明两份 zod 并存的安全性（仅 duck-typing 使用）。
- [x] CRIT-4 已解决：`inject=['orchestrator']` 的硬依赖与"装错 profile 不崩"需要明确边界。
  已在 spec 增加"装错 profile 只等待"场景，并说明这是该专用包的自我描述，不是通用插件的
  懒装配策略。
- [x] CRIT-5 已解决：`workbench-panel` 的旧「工作台信息架构与共享控件」规定主区默认是
  提案列表，与本变更的"主视图为任务"冲突。已用 MODIFIED 改写该要求，并 ADDED「主视图为
  任务」，两处一致。
- [x] CRIT-6 已解决：`team-orchestration` 旧「G2 批准即启动」仍写"协调器直接创建 Run"，
  与默认执行器冲突。已补 MODIFIED 版本，按 `taskExecutor` 分流。
- [x] CRIT-7 已解决：`schema` 里的 `acceptedRule` 既不可执行也不可校验（规则在
  `policy.rules`，`SourceContext` 读不到），会制造"面板保证接单"的假承诺。已从 schema、
  design 骨架与任务 5 中移除，改为接入手册提供可粘贴规则文本 + 面板显示忽略原因（D9b）。
- [x] CRIT-8 已解决：`threadContext` 原只读任务历史，Eval 缺少方案上下文。已补充
  "有 `proposalId` 且配置 `repoRoot` 时读 OpenSpec 三件套摘录"的要求与反证场景（D9c），
  并在任务 7 落实。
- [x] CRIT-9 已解决：多仓库若靠 prepare 命令分支，会在 `gh` 目标仓库与 PR 订阅两处静默出错。
  已确定一实例一仓库，面板按 `repo` 判断可指派性，非本仓显示「未接入执行器」（D9d），
  并在 `task-intake` 增加对应要求与场景。
