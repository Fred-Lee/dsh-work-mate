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
- **合并语义**：patch 式合并（`git apply`）而非分支 `git merge`，这样即使 agent
  未在 worktree 内提交也能合并；代价是冲突处理是「整批失败」（原子），
  冲突文件由 UI 选择采纳某个 Agent 后按 agent+file 维度重试。
- **用量统计**：估算 tokens = chars/4，仅用于看板展示，非计费口径。

## 5. 目录结构

```
packages/
  worktree/          git worktree 服务（diffparse / service / git）
  memory-topology/   拓扑存储 + 扫描器 + 导入导出 + 图体检（graph-health.ts）+ 3 个 agent 工具
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

- 单测：`packages/*/src/*.test.ts`，`pnpm test`（vitest，全量 424 用例）。
- 关键集成：真实 `git init` 的 worktree 创建→diff→合并→冲突→清理全链路。
- 真实 profile 冒烟：`--dump-config` 核对 9 行 insert；`dsh web` 启动后 curl
  `/helmsman-dashboard/api/state`；以假 agent 脚本走完 执行→聚合→合并→主仓库
  commit 的 E2E（记录见 git history 与 docs/USAGE.md §验证）。
