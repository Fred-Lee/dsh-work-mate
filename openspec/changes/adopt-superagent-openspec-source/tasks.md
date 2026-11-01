# Tasks — 把 WorkMate 的待办做成 Super-agent 的原生 Source

> 范围声明用行内 HTML 注释 `writes:`（swarm 装批 + `workmate_plan_drift` 都读它）。
> 同一文件出现在多行时**不得并行**（writes 相交）。
> 不新增对 `@deepseek-ai/dsh-superagent` 的依赖；子包唯一的运行期依赖是 `zod ^4`。
> 顺序有依赖：1–4 是子包地基，5–8 是它的行为，9–11 才让 WorkMate 面板与 API 接上；
> 12–14 的 worktree 与回收必须在 9 之后（它们要改任务记录与 API）；
> 15–18 的降级必须在 1–8 之后（否则面板没有新的读取路径可退）；
> 19–22 是审查补充，其中 19 依赖 9、20 依赖 9 与 14、21 依赖 1、22 依赖 12–14；
> 23–26 是安全与验收标准，23/24 依赖 3 与 7、25 依赖 1、26 无依赖；
> 27–28 是验收，必须最后执行。

## 阶段 0 — 子包地基

- [x] 1. 工作区骨架：新增 `pnpm-workspace.yaml`（`packages/*`）；新增
  `packages/superagent-source/{package.json,cordis.patch.yml,tsconfig.json}`：
  包名 `workmate-superagent-source`、`dsh.bundle.patch: './cordis.patch.yml'`、
  `exports['./source-watch']`、运行期 `dependencies: { zod: '^4.4.3' }`、
  `peerDependencies` 不含任何 dsh 包；`cordis.patch.yml` 只有一条
  `- id: workmate-superagent-source / name: workmate-superagent-source`
  <!-- writes: pnpm-workspace.yaml, packages/superagent-source/package.json, packages/superagent-source/cordis.patch.yml, packages/superagent-source/tsconfig.json -->

- [x] 2. 结构契约 `packages/superagent-source/src/contract.ts`：以结构类型描述
  `SourceKind` / `SourceContext` / `Trigger` / `Thread` / `Ticket` / `OutboundMessage`
  的最小字段（不 import 原型包）；附 `contract.test.ts` 用固定夹具断言字段存在，
  缺失时抛可读错误
  <!-- writes: packages/superagent-source/src/contract.ts, packages/superagent-source/src/contract.test.ts -->

- [x] 3. 任务文件 `packages/superagent-source/src/files.ts`：读 `tasks.json`（容忍不存在）、
  读 `inputs.jsonl` 按 `seq` 游标取未消费行（容忍撕裂尾行与非法行）、追加
  `tasks.jsonl`（`ack`/`result`/`notice`/`error`，按 `messageId` 去重）。
  附 `files.test.ts`：撕裂尾行、非法行、重复 messageId、并发追加
  <!-- writes: packages/superagent-source/src/files.ts, packages/superagent-source/src/files.test.ts -->

- [x] 4. 依赖门控 `packages/superagent-source/src/gate.ts`：纯函数
  `readyTasks(tasks, results) → { ready, waiting }`，只有全部 `dependsOn` 在结果集中
  且结果为已完成时才 ready；`abandoned` 与依赖自身的 `abandoned` 处理明确。
  附 `gate.test.ts` 覆盖链式依赖、环、缺失依赖、放弃节点
  <!-- writes: packages/superagent-source/src/gate.ts, packages/superagent-source/src/gate.test.ts -->

## 阶段 1 — SourceKind 行为

- [x] 5. kind 元数据与配置 `packages/superagent-source/src/kind.ts`：`kind: 'workmate'`、
  `title`/`description` 双语、`schema`（zod：`taskFile` / `pollSeconds` / `maxPerScan` / `interactive` /
  `repoRoot?` / `openspecRoot?`）、`fields`（含 `rows` 与 `fact` 字段）、`health: ['workmate']`、
  `facts(deployment)`（签名无 config 参数）、`copyFiles` 默认 `['.env','.env.local']`。
  附 `kind.test.ts`：默认值、非法配置使实例被禁用、`parse({})` 不抛、`taskFile` 必须是绝对路径
  <!-- writes: packages/superagent-source/src/kind.ts, packages/superagent-source/src/kind.test.ts -->

- [x] 6. 扫描与投递 `packages/superagent-source/src/watch.ts`：按 `pollSeconds` 扫描；
  对 ready 且 `assigned` 且未产生当前 `attempt` 的待办调用 `ctx.receive(trigger)`，
  Trigger 字段严格按 spec（`id=workmate:<taskId>:<attempt>`、`threads=[{source:'workmate',
  id:taskId}]`、`actor={source:'workmate',id:'workmate:<createdBy>'}`、`human:true`、
  `addressed:'mention'`、`channel.address={taskId}`、`meta` 带 repo/分支/验收/优先级/ports/proposalId）；
  同时把 `inputs.jsonl` 未消费行转为 `id=workmate:<taskId>:in:<seq>` 的人消息并推进游标；
  `maxPerScan` 上限（默认 5，按 P0>P1>P2 → createdAt → id 排序）且回答优先；
  `interactive=false` 时只记录不投递。附 `watch.test.ts`：幂等、跳过未指派、跳过依赖未满足、
  只读模式不投递、inputs 不重放（游标持久化）、30 条积压只投 5 条、回答优先
  <!-- writes: packages/superagent-source/src/watch.ts, packages/superagent-source/src/watch.test.ts -->

- [x] 7. Channel 与上下文 `packages/superagent-source/src/channel.ts` +
  `src/context.ts`：`channel.send` 固定映射写 `tasks.jsonl`（`messageId` 幂等、
  待办已删除返回 `'gone'`）、`channel.allowed`、`channel.link`（深链
  `/workmate/?task=<id>`，不可达返回空 url）；`threadContext.read` 支持
  `thread`（分页 + `next` 游标）/`root`/`parent`，`root` 在 `proposalId` + `repoRoot`
  非空时返回带 `path`/`line` 的工件摘录（固定顺序、每文件上限、游标续读），
  机器行标 `bot: true`；`threadContext.messageId`；`repliesTo`；`find(query)`。
  附 `channel.test.ts` 与 `context.test.ts`（含"未关联提案不扫仓库"的反证）
  <!-- writes: packages/superagent-source/src/channel.ts, packages/superagent-source/src/context.ts, packages/superagent-source/src/channel.test.ts, packages/superagent-source/src/context.test.ts -->

- [x] 8. 入口与环境 `packages/superagent-source/src/index.ts`：导出
  `name = 'workmate-superagent-source'`、`inject = ['orchestrator']`、`apply`；
  在 `ctx.effect` 内注册 kind 与扫描器；`environment.variables` / `values` 注册
  `DSH_SUPERAGENT_WORKMATE_TASK|_ACCEPTANCE|_PRIORITY|_BASE_BRANCH|_PORTS|_COPY|_PROPOSAL`
  （`_PORTS` 取 `meta.ports`、`_COPY` 取实例配置 `copyFiles`，都不得依赖读盘）；
  `policy` 分片（`allowed` + `admission`）；`threads.describe`（在首个 Trigger 之后调用）；
  健康上报（配置问题、等待依赖数、投放失败数）。
  附 `index.test.ts`：假 context 下注册一次、dispose 不泄漏、无 orchestrator 时只等待、
  环境变量取值来自 meta 而非文件
  <!-- writes: packages/superagent-source/src/index.ts, packages/superagent-source/src/index.test.ts -->

## 阶段 2 — WorkMate 侧

- [x] 9. 任务文件与 API `src/features/task/{files,service}.ts` + `src/api.ts`：
  面板独占的两个写者（`tasks.json` 原子写、`inputs.jsonl` 追加）；
  `GET /api/tasks`（合并三份文件 + 代理读取的 Ticket 阶段）、
  `POST /api/tasks`、`POST /api/tasks/:id/{assign,reply,retry,stop,abandon,reopen}`；
  `GET /api/superagent/health`（服务端代理，带 `x-orchestrator-request: 1`、loopback-only、
  超时）；动作写 `events.jsonl`。附 `files.test.ts` 与 `api.test.ts`
  <!-- writes: src/features/task/files.ts, src/features/task/service.ts, src/features/task/*.test.ts, src/api.ts, src/api.test.ts -->

- [ ] 10. 面板 `src/client/App.tsx` + `src/client/api.ts` + `src/client/types.ts`：
  「任务」主视图（四列 + 侧栏徽标）、新建待办表单（三种执行方式）、任务抽屉
  （阶段/治理状态/对话/证据/动作条）、把 `window.prompt` 换成抽屉内结构化输入；
  提案视图降为并列页签；`taskExecutor=team` 时显示「回退执行器」徽标。
  附 `app.test.tsx`：四列计数、表单校验、抽屉、回答后列变化、离线空态、setup 提示的四种触发与自动消失
  <!-- writes: src/client/App.tsx, src/client/app.test.tsx, src/client/api.ts, src/client/types.ts -->

- [x] 11. 配置与门禁 `src/config.ts` + `scripts/*`：新增 `taskExecutor`（默认
  `superagent`）、`taskFile`、`superagentEndpoint`、`superagentTimeoutMs`、
  `superagentPollSeconds`（与子包 schema 的默认值一致）；Schemastery 与 interface 同步；
  `scripts/build.mjs` 增加子包构建；新增 `scripts/check-source-bundle.mjs`
  （加载子包产物、断言 kind 六必填字段与导出、在无 orchestrator 的假 ctx 下 0 注册 0 throw），
  在 `package.json` 增加 `"verify:source"` 脚本并**接进 `verify` 链**。附 `config.test.ts`
  <!-- writes: src/config.ts, src/config.test.ts, scripts/build.mjs, scripts/check-source-bundle.mjs, package.json -->

## 阶段 2b — worktree 规划与回收

- [x] 12. 规划落盘 `src/features/task/plan.ts` + `src/features/worktree/port-allocator.ts`：
  端口键改为 `${proposalId}--${project}--${taskId}`（无提案 `${repo}--${taskId}`），
  `attempt` 复用同段；规划结果（`baseBranch`、`branchHint`、`ports`）写入任务记录。
  `ready→implementing` 在 `taskExecutor=superagent` 时 SHALL NOT 调用 `worktree.createTarget`；
  旧键在回收时按 target 兜底。附 `plan.test.ts` 与 `port-allocator` 兼容用例
  <!-- writes: src/features/task/plan.ts, src/features/task/plan.test.ts, src/features/worktree/port-allocator.ts, src/features/worktree/worktree.test.ts, src/features/archive/service.ts, src/features/archive/service.test.ts -->

- [x] 13. prepare 契约 `packages/superagent-source/src/environment.ts` + 文档：
  注册 `_BASE_BRANCH`/`_PORTS`/`_COPY`；`docs/SUPERAGENT-INTEGRATION.md` 给出可直接粘贴的
  `executor.prepare` 片段（`git worktree add -b "workmate/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "$DSH_SUPERAGENT_WORKMATE_BASE"`、`.env` 追加、copyFiles、install），
  并说明 `executor.directory` 应设为 `<repo>/.workmates`。附 `environment.test.ts`
  <!-- writes: packages/superagent-source/src/environment.ts, packages/superagent-source/src/environment.test.ts, docs/SUPERAGENT-INTEGRATION.md -->

- [x] 14. 回收与遗留 `src/features/worktree/reclaim.ts` + `src/api.ts`：归档时逐 target 读
  Ticket 投影的 `execution.directory`，前置要求「Ticket 已结束 + 分支已合并」，满足才
  `git worktree remove --force` 并释放端口；不满足则拒绝并给原因；`GET /api/worktrees/leftover`
  列出已结束但目录仍在的项；`POST /api/worktrees/reclaim` 手动回收（二次确认在面板）。
  附 `reclaim.test.ts`：活跃 Ticket 拒绝、未合并拒绝、成功释放、遗留列表
  <!-- writes: src/features/worktree/reclaim.ts, src/features/worktree/reclaim.test.ts, src/api.ts, src/api.test.ts -->

## 阶段 3 — 降级与文档

- [x] 15. 团队工具降级 `src/features/team/tools.ts`：`workmate_team_run` /
  `workmate_team_plan(start=true)` 在 `taskExecutor !== 'team'` 时返回 `disabled` 与
  "改用任务视图或显式设 taskExecutor=team"；工具签名不变。附 `tools.test.ts`
  <!-- writes: src/features/team/tools.ts, src/features/team/tools.test.ts -->

- [ ] 16. 团队视图只读 `src/client/App.tsx`：`TeamView` 在 superagent 模式下隐藏派发/回答/
  重试并链接任务视图；运行态读 Ticket 投影；fallback 时显示「回退执行器」。附 `app.test.tsx`
  <!-- writes: src/client/App.tsx, src/client/app.test.tsx -->

- [x] 17. 启动恢复边界 `src/index.ts`：`taskExecutor=superagent` 时不创建 Run、不装定时器；
  `team` 模式下扫描遗留 `running`/`dispatched` 标 `abandoned` 并写恢复事件。附 `index.test.ts`
  <!-- writes: src/index.ts, src/index.test.ts -->

- [ ] 18. 文档 `docs/SUPERAGENT-INTEGRATION.md`（安装子包 bundle、allowed 列表、
  explicit 准入的两步（把 `workmate:<createdBy>` 加入 allowed；无需写规则）、
  `repoRoot`/`openspecRoot`、`taskFile` 必须两侧同一绝对路径、轮询、
  `interactive=false` 的首跑建议、
  "指派不等于开工"）+ `AGENTS.md`（定位、`taskExecutor`、三份文件三写者）+
  `README.md`（任务视图）
  <!-- writes: docs/SUPERAGENT-INTEGRATION.md, AGENTS.md, README.md, docs/TEAM-SETUP.md -->

## 阶段 3b — 审查补充

- [x] 19. G2 交接 `src/features/archive/service.ts` + `src/features/task/service.ts`：
  `reviewing→ready` 的 G2 批准与 `ready→implementing` 在 `taskExecutor=superagent` 时
  SHALL 写入实现待办（`assigned=true`，一条 target 一条），SHALL NOT 创建 Run；
  `team` 模式下保持原行为。附用例：批准后 tasks.json 出现待办、无 Run、无 dispatch
  <!-- writes: src/features/archive/service.ts, src/features/archive/service.test.ts, src/features/task/service.ts, src/features/task/service.test.ts -->

- [x] 20. target 分支回写 `src/features/task/project-targets.ts`：观察到 Ticket 后把
  `workmate/<短名>` 与 `baseCommit` 回写对应 target（`git rev-parse <baseBranch>`），
  幂等且冲突时报错不覆盖；归档前置与 G5 合并据此可读。附用例：回写、幂等、冲突
  <!-- writes: src/features/task/project-targets.ts, src/features/task/project-targets.test.ts -->

- [ ] 21. 测试与类型范围 `vitest.config.ts` + `tsconfig.json` + `scripts/check-test-integrity.mjs`：
  `include` 扩到 `packages/**/*.test.ts`；typecheck 覆盖子包（新增
  `tsconfig.packages.json` 或把 `rootDir` 去掉）；确认 `pnpm verify:test` 能发现并执行
  子包测试。附 `test:toolchain` 用例
  <!-- writes: vitest.config.ts, tsconfig.json, tsconfig.packages.json, scripts/check-test-integrity.mjs, package.json -->

- [ ] 22. 回滚脚本 `scripts/rollback-superagent.mjs`：**不依赖 Super-agent 在线**，按
  三级定位（任务记录缓存的 `directory` → 命名推导 `<repo>/.workmates/workmate-*` →
  扫描目录）清理 worktree 与分支，释放 `${proposalId}--${project}--${taskId}` 端口键，
  找不到端口时输出"可能泄漏"清单；输出逐项结果。演练一次，并在
  `docs/SUPERAGENT-INTEGRATION.md` 写明"回滚三件事，缺一泄漏"
  <!-- writes: scripts/rollback-superagent.mjs, scripts/rollback-superagent.test.mjs, docs/SUPERAGENT-INTEGRATION.md -->

## 阶段 3c — 安全与验收标准

- [x] 23. 输入校验 `packages/superagent-source/src/validate.ts`：`proposalId` 白名单
  （`^[a-z0-9][a-z0-9-]*$`）+ `path.resolve` 前缀校验（工件读取不越界）；
  `messageId` 格式校验（32 位小写十六进制，参照 `src/core/ids.ts:3-5`）；不合法时
  `report` 健康错误且不写行。附 `validate.test.ts`：`../` 穿越、绝对路径、超长 ID、
  合法 ID 各一例
  <!-- writes: packages/superagent-source/src/validate.ts, packages/superagent-source/src/validate.test.ts -->

- [ ] 24. 增长上限 `packages/superagent-source/src/compact.ts`：单待办超过
  `maxRowsPerTask`（默认 200）时压缩为最近 N 行（保留至少一条 `ack` 与最后一条
  `result`/`error`），tmp+rename 原子重写，只动该待办的行。附 `compact.test.ts`：
  超限压缩、保留规则、并发扫描不丢行
  <!-- writes: packages/superagent-source/src/compact.ts, packages/superagent-source/src/compact.test.ts -->

- [ ] 25. 跨仓交付验证 `docs/SUPERAGENT-INTEGRATION.md` + `scripts/verify-source-install.mjs`：
  写一个可执行检查——给定 Super-agent profile 目录，断言 ① 包已安装且版本可读、
  ② `dsh.profile.bundles` 含 `workmate-superagent-source`、③ 该 bundle 的 patch 只有一条
  entry、④ `workmate` 来源出现在 `--dump-config` 且 `status: schema`。附安装步骤与
  失败排查表
  <!-- writes: scripts/verify-source-install.mjs, scripts/verify-source-install.test.mjs, docs/SUPERAGENT-INTEGRATION.md -->

- [ ] 26. 验收清单 `docs/SUPERAGENT-ACCEPTANCE.md`：把只能真机验证的项写成勾选表——
  装即启用、`prepare` 建出 `<repo>/.workmates/workmate-*`、`DSH_SUPERAGENT_WORKMATE_*`
  在 worker 可见、Channel 端到端回写、stop/retry、面板与 Execution 页阶段逐项对照
  （列出六个阶段各自的期望文案）、面板 320/760/1180/1440 四档截图。任务 28 按此表执行
  <!-- writes: docs/SUPERAGENT-ACCEPTANCE.md -->

## 阶段 4 — 验收

- [ ] 27. 门禁：`pnpm typecheck && pnpm test && pnpm build && pnpm verify` 全绿；
  `pnpm verify:source`（任务 11 新增）通过；`node scripts/verify-source-install.mjs`
  （任务 25 新增）在"正常安装 / 已装未启用 / 未安装"三种夹具下分别给出正确结论；
  `taskExecutor=superagent` 下确认 `workmate_team_run` 返回 disabled 且无 dispatch
  <!-- writes: （无源码写域；仅运行命令与记录） -->

- [ ] 28. 真机验收：以 `interactive=false` 装子包 → 面板建待办 → 打开 Super-agent 的
  Trigger 页确认 Thread 与事实可见 → 打开 `interactive=true` → 确认产生 Ticket →
  worker 结果经 Channel 写回 `tasks.jsonl` → 面板四列与抽屉正确 → 证据（截图路径、
  关键命令输出、与 Super-agent Execution 页的阶段对照）写入
  `openspec/changes/adopt-superagent-openspec-source/evidence.md`（**不写进 review.md**：
  该文件的四节是机器可读约定，不能增删）
  <!-- writes: openspec/changes/adopt-superagent-openspec-source/evidence.md -->

## 支撑与验收任务

以下任务不直接实现某条 requirement，属于工程使能或验收，单独列出以免被当成"孤儿任务"：

| 任务 | 性质 | 为什么必须有 |
| --- | --- | --- |
| 21 测试与类型范围 | 使能 | 子包测试不在 `vitest` include、`tsconfig` `rootDir` 不覆盖 `packages/**`；不做则 `verify:test` 必红 |
| 25 跨仓交付验证 | 使能 | 子包能否被 Super-agent 自动启用只能实测；没有这个检查，切片验收只能靠肉眼 |
| 26 验收清单 | 使能 | 把只能真机验证的项固定成勾选表，避免"看过就算过" |
| 27 门禁 | 验收 | 全部门禁与三条安装状态的收口 |
| 28 真机验收 | 验收 | 按 26 的表逐项执行并留证据 |

任务 17（启动恢复边界）映射到 `team-orchestration / Run / Task / Dispatch 模型`：
`superagent` 模式下不创建 Run 正是该 requirement 的边界。

## 覆盖矩阵（requirement → task）

| Capability / Requirement | Task |
| --- | --- |
| superagent-source / 作为独立 Source bundle 安装 | 1, 11, 15 |
| superagent-source / 完整的 SourceKind 契约 | 2, 5, 8, 11 |
| superagent-source / 三份文件与三个单写者 | 3, 9, 24 |
| superagent-source / 待办到一个 Thread 的映射与幂等 Trigger | 6 |
| superagent-source / 依赖门控属于 Source | 4, 6 |
| superagent-source / 单轮投递有上限且顺序确定 | 5, 6 |
| superagent-source / Channel 把执行事实写回任务文件 | 3, 7, 23 |
| superagent-source / 有界上下文读取 | 7, 23 |
| superagent-source / 执行环境变量与策略 | 8 |
| superagent-source / 健康、事实与查找 | 5, 7, 8 |
| superagent-source / Thread 描述与回复关联 | 7, 8 |
| task-intake / 面板四列与状态唯一来源 | 9, 10 |
| task-intake / 新建待办与三种写入方式 | 9, 10 |
| task-intake / 指派、回答、停止的动作映射 | 9, 10 |
| task-intake / 任务详情与治理证据 | 9, 10 |
| task-intake / 离线、未知与空态 | 9, 10 |
| task-intake / 面板契约与窄屏 | 10, 16 |
| task-intake / 键盘与无障碍 | 10 |
| task-intake / 首次使用与配置可见性 | 10, 18 |
| task-intake / 治理门与执行等待同列 | 10, 19 |
| task-intake / 执行器与仓库一对一 | 9, 10 |
| lifecycle-state-machine / 八态生命周期状态机 | 11, 19 |
| lifecycle-state-machine / worktree 生命周期自动管理 | 12, 19 |
| multi-target-worktree / 按目标原子创建 worktree | 12, 19 |
| multi-target-worktree / 按目标清理与回收 | 14, 20 |
| team-orchestration / Run / Task / Dispatch 模型 | 15, 17, 18 |
| team-orchestration / 依赖 DAG 与波次 | 15 |
| team-orchestration / 门禁与自主推进 | 15, 19, 23 |
| team-orchestration / G2 批准即启动，不重复评估 | 15, 19, 23 |
| team-console / 团队看板 | 16 |
| team-console / 收件箱 | 16 |
| workbench-panel / 工作台信息架构与共享控件 | 10 |
| workbench-panel / 主视图为任务 | 10 |
| worktree-plan / 规划与创建的所有权分离 | 12, 13, 20 |
| worktree-plan / 分支命名与 PR 归属 | 13 |
| worktree-plan / 端口按 Ticket 分配与注入 | 12, 13 |
| worktree-plan / prepare 模板与失败语义 | 13 |
| worktree-plan / 回收前置条件与执行 | 14, 22 |
| worktree-plan / 遗留目录可见与手动回收 | 14, 22 |
| worktree-plan / 回滚不依赖执行器在线 | 22 |
