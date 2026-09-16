# Helmsman 架构说明

## 1. 在 DSH 插件体系中的位置

Helmsman 是一组**标准第三方 DSH 插件**（纯 ESM，`dsh.bundle.patch` → `cordis.patch.yml`），
通过 `dsh plugin --profile <p> add ./packages/<pkg>` 装入 profile，由 loader 按
`insert` 行挂进 cordis 插件树。每个插件遵循 DSH 契约：

```ts
export const name = '@helmsman/<pkg>'       // 诊断显示
export const inject = ['tools', ...]        // 硬依赖：服务未就绪则 fiber PENDING
export function apply(ctx: Context, config) // 挂载点
```

服务注册用 `ctx.provide('<name>', value)`（点号名合法），跨插件获取用
`ctx.get('<name>')`（可选依赖**必须延迟到运行时解析**，见 §4 竞态）。
非 cordis 管理的资源一律包 `ctx.effect(() => disposer)`。
本套插件没有任何 `export default`，全部具名导出。

## 2. 服务拓扑

```
helmsman.worktree   (provide) ←─ inject ── orchestrator
helmsman.topology   (provide, 自足)           │
helmsman.orchestrator (provide) ←─ inject ── adapter-{claude,codex,pi,oh-my-pi}
helmsman.artifacts  (provide, 自足) ←─ 惰性 ctx.get ── ui-dashboard / ui-workbench / orchestrator
helmsman.board      (provide, 自足) ←─ 惰性 ctx.get ── ui-workbench(建档) / ui-board(看板)
webServer (DSH 内置) ←─ inject ── ui-dashboard, ui-diff, ui-workbench, ui-board
```

- **worktree**：`git worktree add -b helmsman/<taskId>-<agent>`，记录 baseSha；
  diff = `git diff --binary <baseSha>`（`--intent-to-add` 让未跟踪文件可见）；
  合并 = 工作区 diff 生成 patch → 主仓库 `git apply`（stdin）→ `git commit`；
  冲突时 apply 失败、主仓库原状不动，返回 conflictFiles。
  惰性集成社区插件 `vws`（dsh-virtual-workspace）：每次创建/删除时
  `ctx.get('vws')`，失败不阻塞。
- **memory-topology**：`~/.helmsman/topologies/<group>.json`（组名 URI 编码，
  CJK 安全）；`normalizeTopology` 在读写两侧做形状清洗，坏文件降级为 null。
  依赖图是**服务级**模型：`restDependencies` 键为调用方，**一对 (from, to) 恰好一条边**；
  只声明「A 调用 B」而不细分接口时用**服务级边**编码 —— `{ toServiceId, endpoints: [], method: '*' }`
  （`SERVICE_LEVEL_METHOD`），归一化**保留**该形态（不填默认 `GET`、不造占位路径），端点明细是
  可选补充。去重落在**持久化路径**（服务 `saveTopology` + `TopologyStore.save`）：同一对服务
  再次写入时按 `mergeDependencyEdge` 把明细并入既有边、明细内部按 (method, endpoint) 去重，
  因此配置页 / 导入 / 直接 HTTP 三条写入路径共享同一不变量且保存幂等。展示按「有无明细」
  逐点降级：配置页 `A ──▶ B`，`describeTopology` 注入文本 `- A --▶ B`。
  扫描器零依赖：Maven 用轻量标签匹配（含 `${property}` 解析、dependencyManagement、
  modules、parent 链接推导）；REST 扫描支持 Spring / NestJS / Express 三类注解
  与路由，带深度/文件数/大小上限与 realpath 符号链接逃逸检查。
- **出站扫描与依赖推导（memory-topology）**：「谁调谁」由两层构成——
  `scan-outbound.ts` 扫**对外发起**的调用与基址线索（Java `@FeignClient`（含
  `${…internal-bc-es.name}` 这类**占位符键**：取键里标识服务名的那一段作目标、
  能从本地配置解析出值就当补充证据、解析不出就标注「值未解析」但不丢线索）、
  `RestTemplate` / `WebClient` / `HttpClient`；JS/TS `axios` / `fetch` / `http(s)`，
  模板插值归一为 `/api/users/{}/orders`；外加 `*.base-url` / `*.url` / `*.host`
  配置键、k8s service DNS 与 `http://<svc>:<port>` 基址），`derive-dependencies.ts`
  把线索折成**候选**：名称档=高（服务级候选）、路径档=中（带命中端点，
  先精确再按段形状归一化 `/api/users/{id}` ↔ `/api/users/{userId}`，Feign 前缀
  占位符未解析时只按方法级路径匹配并标注「前缀未解析」），按 (from, to) 合并
  （证据/端点取并集、置信度取高档）、排除自环、**无证据不产出候选**，未登记目标
  **保留**并标 `targetDeclared: false`，会与既有图成环的候选**标注**而非丢弃。
  两个模块都沿用 `scan-rest` 的同一套上限与 root containment，且不做任何网络请求。
- **仓库内依赖声明（memory-topology）**：依赖索引可以**前移进项目**——每个仓库在
  `<repo>/.helmsman/dependencies.yml` 声明**自己的出站依赖**（`version` / `service`
  （必填，是每条边的调用方）/ `dependencies[]`，每项必填 `to` + 可选
  `method`/`endpoints`/`critical`；只声明出站，不声明入站）。声明作为**第四个导入源**
  （`source: 'helmsman-declaration'`）接入既有 `importPreview → 人工核对 → importApply`
  链路：解析结果就是既有 `ImportPreview`（`services[]` + `dependencies[]`），
  人复用的还是那个「预览 → 勾选 → 应用」对话框，应用走的还是同一条
  `applyPreview` 合并 + 保存去重路径——**没有第二套审核 UI，也没有新的写入路径**。
  - `declaration.ts`：解析与回写互为往返（`renderDeclaration` 的输出能被
    `parseDeclaration` 解析回等价集合）。缺 `service` 或某条依赖缺 `to` → 整体报错、
    **不产出部分边**；文件缺失 → 明确的 `missing` 结果（非错误）；存在但解析失败 →
    报出完整的问题清单且**不应用任何边**。
    回写只序列化 `declared` 边（`derived` 不写入，避免把系统发现静默固化成「仓库声明」）。
  - **边的来源标记**：`RestDependencyEdge.source?: 'declared' | 'derived'`（**可选新增**，
    缺省即 `declared`，故存量数据自然参与调和）。`normalizeTopology` 保留两个合法值、
    其余丢弃为缺省；`mergeDependencyEdge` 在同一对上取更保守的一方（任一 `declared`
    则结果 `declared`，推导确认不能把声明边降级）；只有 `derived` 会被显式写出，
    `'declared'` 保持隐式缺省（存量文件字节稳定）、导出 YAML 也沿用该编码。
  - **重新抓取的调和规则**：对声明服务，文件是其 `declared` 边的唯一事实源——文件里有的
    补上/并入、文件里没有的 `declared` 边移除；`derived` 边**不增不删**（同一对若被文件
    声明则合并，来源按 `declared`、明细取并集）。因此重复抓取**幂等**，且不会冲掉此前
    确认过的推导结果。抓取只读、离线（只读本地文件与已存拓扑）。
  - 未登记目标沿用推导变更的「登记并确认」路径（预览里标出、勾选即登记），使应用后不会
    立刻产生体检里的悬空引用；回写只产出「建议提交到仓库」的提示与目标路径，**不执行任何
    git 操作**。
- **声明漂移核对（memory-topology）**：声明会腐烂——代码里新增/删除一个出站调用，声明文件不会
  自己跟着变。两侧数据此时都已存在，`declaration-drift.ts` 只做**比对与呈现**（不新增扫描能力、
  不改声明格式、不改依赖图）：以 `readDeclaration` 读到的**声明边**为一侧（它是「是否已声明」的
  **准绳**），以 `deriveDependencies` 的**代码候选**为另一侧，按 (from, to) 服务对分成
  `consistent`（两侧都有）/ `staleDeclared`（仅声明有）/ `undeclared`（仅代码有）。
  - **置信度口径**：判定只认**高置信（名称档）**候选；**中置信（路径档）**候选单列为
    「可能未声明（中置信）」并**不计入** `undeclared`——路径档按模板归一化匹配，可能把通用路径
    命中多个服务（本仓早期版本就因此产出过一条假阳性依赖），判定清单必须保持可信、不能掺噪声。
    （相应地，一条**已声明**的服务对只要有任何一档代码证据就不会被报成「未找到证据」，其
    `confidence` 会如实标为 `medium`——判定用高档，中档可见但不制造假结论。）
  - **两个输入面，无第三事实源**：① 仓库内声明文件（人的意图，只读读取）；② 静态离线的代码扫描
    候选（现实）。核对不引入新的采集通道，也不试图提高扫描召回率。
  - **只读边界（硬约束）**：核对不写声明文件、不改拓扑、不增删任何边，界面也**没有**「一键修复」；
    `staleDeclared` 的处置是**人去改声明文件**，`undeclared` 的处置是**跳进既有候选确认流程**
    （`applyCandidates`，登记目标/确认依赖都在那边）。只读入口
    `checkDeclarationDrift(group, service)` → `GET api/topology/drift?group=&service=`；`available:false`
    与未挂载 404 的降级语义与 `declaration`/`health` 路由一致。
  - **与图级体检的分工（并列而不合并，design D5）**：`checkHealth` 看图的**自洽**（环/悬空引用/
    孤立服务，与代码无关），漂移看**与代码是否一致**（声明 vs 扫描证据）。两者性质不同，故界面
    各自渲染、措辞独立；同一问题（如目标未登记）不在漂移区换一套措辞重复报。
  - **诚实降级（design D2/D4）**：`staleDeclared` 只说「未在代码中找到证据」并附**静态扫描局限**
    （动态拼接的 URL、配置驱动路径、非 Feign 的私有 RPC 都可能漏识别），绝不说该依赖已经消失，
    也不提供「一键删除陈旧声明」。声明文件缺失 → `no-declaration`：明确说明「该服务尚未声明依赖、
    以下 N 条代码证据均未经声明」并引导写回一份基线（用户当前的真实状态，必须是**有用的起点**而
    不是错误）；文件存在但解析失败 → `invalid-declaration`：报出问题且**不产出任何判定**
    （否则等于凭一个坏文件宣布「全部未声明」）。
- **orchestrator**：框架无关的 `OrchestratorCore`（单测覆盖），插件入口只做
  cordis 装配 + 4 个 agent 工具注册。任务状态机与 PRD §4.2 一致；
  限流(429)按 2s/8s/32s 指数退避重试（默认 3 次），认证失效不重试，
  连续 5 次失败触发 30s 断路器；`helmsman/task-updated` 事件经 `ctx.emit` 广播。
- **board（任务工作项）**：纯 Service 插件（`inject: []`，无 webServer、无工具），把
  「一次任务」提升为 orchestrator run **之上**的跨阶段聚合根：
  `WorkItem{ id, title, summary, repoScope, stage, runs[] }` 持有四阶段
  （需求分析 → 规格设计 → 开发实施 → 验收归档，仅允许 +1 推进，门数据/门探针校验）
  与关联集（docs / conversations / worktrees / runs / affectedServices / artifacts，
  全部存**引用 + label 快照**而非副本）。run 状态不复制：board 需要时经注入的只读
  `RunStatusReader` 查 orchestrator/change A 的落盘时间线，`taskId` 语义不变。
  存储 `~/.helmsman/board/items.json`（tmp+rename 原子写）+ `events.jsonl`（迁移/关联事件，
  供 change C 审计）；模型、四阶段 DoR/DoD、冲突域 WIP 与摘要契约见 `docs/TASK-MODEL.md`。
- **UI 插件**：host 半区经 `ctx.webServer.register({kind:'prefix'})` 挂载
  `/helmsman-dashboard`、`/helmsman-diff` 与 `/helmsman-workbench`，同源 REST API + 静态 SPA
  （esbuild 打包 React 18 为 IIFE，零运行时 npm 依赖）。这是社区插件
  `dsh-Visual-Workflow` 验证过的第三方 UI 模式，不依赖 `dsh.client`
  module roster（后者需要 web-app bundle 深度配合）。
  - `ui-workbench`：研究/PRD/执行/知识/交付物面板 + 草稿归档 + 自定义指令，并在 host 侧提供
    **「对话 → 任务卡片」建档通道**（`POST /api/task-from-conversation`、
    `GET /api/sessions`）：读会话最近消息 → 生成 2–4 行中文摘要（失败退化为最近消息前 ~200 字，
    标注 `generatedBy: fallback`，**摘要失败不丢卡**）→ `helmsman.board.create`。
  - `ui-board`：看板页 `/helmsman-board`，按四阶段列展示卡片、推进阶段、查看关联与摘要；
    与 ui-workbench 一样对 `helmsman.board` 做**惰性 `ctx.get`** 并降级。
    **第 ③ 列同时是"发起入口"**（change `enable-card-start-run`）：卡片带 `projectGroup` 且该群
    至少一个 agent 已装（`OrchestratorService.checkAgents()` 只读探测，按 TTL 缓存）时才渲染
    「▶ 发起执行」，否则只给「请先在执行看板发起」引导。提交经 `POST /api/item/:id/run` 复用
    **既有** `runParallelTask({prompt, agents, projectGroupId, cascade})`——不新增通路、不复制执行看板；
    卡片**原地不动**，run 经既有持久化挂回 `runs[]`，run 面板复用 change A 的 SSE 时间线。
    **run 的生命周期仍全部在执行看板**（`/helmsman-dashboard/`：取消 / 重试 / 审批 / 合并），
    看板只提供跳转链接。`agent` 的「按场景自适应」是**本地纯函数启发式**（0 token、0 网络，
    `ui-board/client/start-run.ts`），默认档可被用户一键改写，手动指定即原样提交。
    `POST api/item/:id/run` 是 ui-board **唯一的写路径**，且只写一个 orchestrator 任务：
    不写 board 存储、不改依赖图 / 声明文件 / 忽略清单。**WIP 规则不变**：只拦"进第 ③ 列"，
    不拦列内追加 run（已锁定）。

## 3. 数据流

两层「任务」：**WorkItem（跨阶段聚合根，board 拥有）** 在 orchestrator 的 run（`taskId`）**之上**，
只以引用挂接 run——run 的状态/时间线仍归 orchestrator（change A 落盘），卡片不复制。

```
WorkItem (board, ~/.helmsman/board/items.json)
  ├ conversation 关联 ← 建档时由 ui-workbench 写入(会话 id + 摘要, 摘要生成在宿主)
  ├ runs[]        ──▶ orchestrator taskId(只读引用; 门校验与 WIP 评估在 board 侧)
  ├ doc/worktree/service/artifact 关联(引用 + label 快照, 不复制内容)
  └ stage 迁移 ──▶ board/events.jsonl(供 change C 审计)
        ▲                              │
        │ 推进(仅 +1, 带门缺口清单)     │ 看板渲染
   ui-workbench /api/task-from-conversation   ui-board /helmsman-board
        │ 建档 = create + 会话关联       │ 第 ③ 列发起执行 = runParallelTask(既有通路)
        │ (唯一的卡片写入口)             │ 只注入一个 run,卡片不动;WIP 仍只拦"进列"
        ▼                              ▼
   board.create/associate          orchestrator.runParallelTask → taskId ──▶ runs[](既有持久化)
                                   取消/重试/审批/合并仍在执行看板 /helmsman-dashboard/
```

```
Dashboard (React, 单向数据流 useReducer)
  │ SSE：GET /api/task/:id/stream?after=<seq>   每个活动任务一条流
  │  ├ 先订阅→缓冲，再从持久化时间线重放 seq 之后的事件→合并→实时 tail（D4）
  │  ├ 每 15s 心跳（`: hb`）；任务到终态服务端关流
  │  └ 断线按最后 cursor 手动重连（不丢不重）；history-pruned 显示横幅
  │ 5s 兜底轮询 GET /api/state（发现新任务 + 整体刷新安全网）
  ▼
dashboard host (Router + REST/SSE façade) ──进程内──▶ orchestrator / topology
  ▼                                              │
orchestrator.runParallelTask()                    │ helmsman/task-updated 事件
  ├ notify()/touch() 汇聚点 ─▶ HistoryStore       │ 仍照常广播
  │   （upsert 任务摘要 + 追加 task-state 事件）    ▼
  ├ adapter.execute（onOutput → agent-log 事件）    UI 卡片状态机渲染
  │   └ JsonlHistoryStore：~/.helmsman/history/    （优先由流事件驱动）
  │       tasks/<taskId>.jsonl（追加式）+ tasks.json（原子快照）
  ├ worktree.getDiff → 冲突文件标注
  └ mergeTask → git apply patch → commit
```

## 4. 已知设计权衡

- **实时性：SSE + cursor，轮询仅兜底**：v1 用 1.5s/5s 自适应轮询；现在每个活动任务
  一条 `GET /api/task/:id/stream?after=<seq>` SSE。连接**先订阅**（此间事件进内存
  缓冲），再从事务持久化时间线**重放** cursor 之后的事件并合并，随后实时下发，
  从根上消除「重放终点 ↔ 实时起点」之间的竞态（D4）。服务端每 15s 发 `: hb`
  心跳行保活；任务进入终态即关流。客户端 EventSource 出错后**手动**以最后收到的
  seq 重连（cursor 续传，重连不丢不重）；`/api/state` 轮询降为 5s 粗粒度安全网，
  只负责发现新任务 id 与整体兜底刷新。引擎仍广播 `helmsman/task-updated`——持久化
  只是挂在该汇聚点上的副作用，不替换事件。
- **执行历史 = 追加式 JSONL + 原子快照**：每个任务的生命周期记录与事件时间线持久化
  到 `~/.helmsman/history/`（`HELMSMAN_HOME` 可覆盖）：事件逐行追加到
  `tasks/<taskId>.jsonl`（每行一个 `{v:1,seq,ts,taskId,kind,agent?,payload}`），
  任务摘要统一 upsert 到单文件 `tasks.json`（tmp+rename 原子写，崩溃不落半截）。
  JSONL 崩溃安全（读到撕裂的尾行直接忽略）；`seq` 即每任务单调 cursor，支持
  `?after=` 向前翻页与重同步。保留/清理（`retention`）只删除 Helmsman 自己的
  事件/摘要文件，绝不触碰 worktree 或基础仓库产物；被清理的历史对持有旧 cursor
  的客户端返回显式 `history-pruned` 信号（REST 字段 / SSE 命名事件），而不是静默
  返回残缺数据。存储与流式都是注入式接口：编排核心默认用内存实现，引擎单测
  从不触碰文件系统（换 JSONL 后端只需插件装配时注入 + 启动 prune）。
- **可选依赖竞态**：orchestrator 对 topology 是可选依赖，不能 `inject`（否则
  未装 topology 时永久 PENDING），而 `ctx.get` 在 apply 期立即解析会因服务
  未 ACTIVE 拿到 undefined——因此传入**惰性 getter**，运行时再解析。
  `helmsman.artifacts` / `helmsman.board` / `sessionQuery` / `sessionTitle` 同理：
  UI 宿主的 `inject` 里不出现它们，每个请求才 `ctx.get`，缺失即降级
  （board 缺失时建档接口返回「未安装 @helmsman/board 插件」的明确错误）。
- **拓扑提示注入（cascade）**：v1 把下游依赖图作为提示词上下文注入每个 agent
  （不改执行顺序）；服务级级联编排（按拓扑序逐服务执行）留作后续，
  `topology.cascadeOrder()` 已提供拓扑序计算。注入文本对无明细的边退化为
  `- A --▶ B`（不出现残缺的 `--*-->` 与尾随空格）。
- **依赖粒度 = 服务级 + 图体检（不变量而非兜底）**：真实消费者只用「谁指向谁」
  （图谱取 `{from,to,critical?}`、影响面看 `services[].localPath`、级联只用 `from`/`to`），
  所以端点明细降级为可选信息，没有新增 `serviceDependencies` 字段（避免双写与迁移）。
  环检测因此**升级为体检**：`packages/memory-topology/src/graph-health.ts` 的
  `checkGraph(topology) → { cyclic, cycles: string[][], dangling, isolated }` 报告环（**含环内成员**）、
  指向未登记服务的边与孤立服务，经只读 `topology.checkHealth(group)` 暴露
  （dashboard 只读路由 `GET api/topology/health?group=`），配置页在保存后拉取为告警条
  （仅提示、不阻断保存；干净图不显示）。`computeDownstream().cyclic` 与 `cascadeOrder` 的
  环降级行为**保持不变**：引擎不该被脏数据打崩，但人必须被告知（体检是新增视角，不是替换）。
- **依赖推导只提议、不落库（与合并语义的分工）**：`simplify-service-dependencies`
  解决「怎么**表达**」（服务级边 + 按对去重 + 图体检），`derive-dependencies-from-calls`
  解决「怎么**发现**」。职责边界刻意收紧：
  - **纯静态、离线**：只读本地服务树与已存拓扑，不探活、不抓流量、不连服务发现；
    名称/路径匹配本质是启发式，所以结果只经**只读**入口 `topology.deriveDependencies(group)`
    返回（带 `scannedAt`），**绝不写库**；
  - **scope 分层（config 优先）**：`'config'`（默认）只读配置文件——配置是「谁调谁」的事实源，
    名称档候选几乎不会错，且快；`'full'`（显式深扫）额外遍历源码，换取路径档候选与端点明细。
    推导结果回显 `scope` 与 `sources`（config/code 证据计数），漂移核对的陈旧措辞随范围如实降级
    （快扫写「未在配置扫描范围内找到证据」）。扫描器模块级默认保持 `'full'`（向后兼容），
    产品层的默认收敛在推导入口；
  - **只提议**：落库是独立的人工动作 `applyCandidates`，它复用与 `saveTopology`/导入
    **完全相同的持久化闸口**（`normalizeTopology` → `mergeDependencyEdge` → `dedupeDependencies`
    → `store.save`），所以「一对服务只有一条边」对第 4 条写入路径同样成立，
    「确认」永远不会造出重复行；「登记并确认」把服务条目创建放进同一个动作，
    避免确认未登记目标后立刻产生 `dangling` 体检告警；
  - **与体检一致**：`wouldCreateCycle` 用既有图的可达性判断（`to` 能否到达 `from`），
    与 `checkGraph` 加边后的结论一致（单测直接以 `checkGraph` 交叉验证）；
    成环候选**标注**并默认不勾选，而不是静默丢弃——环是架构不变量问题，人应当知道；
  - **粒度**：候选合并后的明细仍是「同一对服务那一行」的补充信息，不引入新的数据结构；
    端点明细只是证据快照，随代码漂移重跑推导即可刷新。
- **合并语义**：patch 式合并（`git apply`）而非分支 `git merge`，这样即使 agent
  未在 worktree 内提交也能合并；代价是冲突处理是「整批失败」（原子），
  冲突文件由 UI 选择采纳某个 Agent 后按 agent+file 维度重试。
- **用量统计**：估算 tokens = chars/4，仅用于看板展示，非计费口径。

## 5. 目录结构

```
packages/
  worktree/          git worktree 服务（diffparse / service / git）
  memory-topology/   拓扑存储 + 扫描器（scan-rest / scan-outbound）+ 推导（derive-dependencies）
                     + 导入导出 + 图体检（graph-health.ts）+ 3 个 agent 工具
  orchestrator/      core.ts（引擎）+ index.ts（cordis 装配 + 工具）
  artifacts/         内容寻址产物注册表（helmsman.artifacts 纯 Service）
  board/             任务工作项聚合根（helmsman.board 纯 Service：模型/四阶段/门/关联/事件）
  adapter-*/         每个适配器独立（spawn 循环 + 参数模板 + README）
  ui-dashboard/      src/*.ts(host) + src/client/*(React SPA + CSS 变量双主题)
  ui-diff/           同上 + 统一 diff 解析/冲突 UI/合并栏
  ui-workbench/      host(router.ts / generator.ts / intake.ts) + client 面板；对话→卡片建档
  ui-board/          看板页 /helmsman-board（四阶段列 + 卡片详情 + 推进）
  bundle/            cordis.patch.yml 聚合 insert 行
scripts/build-package.mjs   共享 esbuild 配置（packages:external）
```

## 6. 测试

- 单测：`packages/*/src/*.test.ts`，`pnpm test`（vitest，全量 477 用例，38 个文件）。
- 关键集成：真实 `git init` 的 worktree 创建→diff→合并→冲突→清理全链路。
- 真实 profile 冒烟：`--dump-config` 核对 9 行 insert；`dsh web` 启动后 curl
  `/helmsman-dashboard/api/state`；以假 agent 脚本走完 执行→聚合→合并→主仓库
  commit 的 E2E（记录见 git history 与 docs/USAGE.md §验证）。
