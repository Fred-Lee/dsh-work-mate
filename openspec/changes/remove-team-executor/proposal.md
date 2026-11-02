# 提案：移除团队执行器

## Why

团队执行器（`src/features/team/`，4192 行 + 17 个测试文件）是 Super-agent 接入前的
派发实现。接入完成后它被 `taskExecutor=superagent` 默认关闭，派发工具直接抛错、
面板团队视图只读，真机从未跑过。它重复了 Super-agent 已经做得更好的一层：并发上限
（3 vs 3）、重试语义（`retryTicket` 按 blocked/failed vs 团队按 `maxAttempts`）、
worker 会话管理、提问与回答（`person/answer` + Channel vs `team_inbox`）。

留着一个默认关闭、依赖宿主 subagent 服务、且与主路径语义重叠的执行器，代价是每次
改任务层都要同时维护两套派发逻辑与两套状态机。

## What Changes

- **BREAKING**：删除 `src/features/team/` 整个目录（含 runner、coordinator、tools、
  store、prepare、summary、roster、presets、models、tasks、evidence、completeness、
  inbox、artifacts、auto-plan、host-dispatcher、events、prompts）。
- **BREAKING**：删除 6 个 agent 工具：`workmate_team_prepare` / `workmate_team_plan` /
  `workmate_team_run` / `workmate_team_status` / `workmate_team_inbox` /
  `workmate_team_answer`。
- **BREAKING**：删除 REST `/api/team/runs`、`/api/team/runs/:id`、
  `/api/team/runs/:id/answer`、`/api/team/runs/:id/artifacts`。
- **BREAKING**：删除配置项 `taskExecutor`、`teamAutoPlan`、`teamReadonlyPreset`、
  `teamWorkspacePreset`、`teamRequireRolePresets`、`teamRoleModels`、`teamEvidenceGate`。
  `taskExecutor` 消失后 `workmate.superagent` 成为唯一执行器。
- 删除面板的「团队」视图与 `src/client/team-waves.ts`；`GET /api/config` 只保留
  `taskExecutor: 'superagent'` 常量以兼容旧客户端一次读取。
- **保留**：`team/managed` 的概念在归档侧仍有意义——`_plan_drift`、`TASKS.json`、
  `TEST.md`/`TEAM-REVIEW.md` 的机检不依赖 Runner，仅依赖工件本身。归档门的
  `teamEvidenceGate` 语义改为**只按工件存在性判断**，不再读 Run 状态。
- 事件流保留 `team-*` 三个 kind 的历史可读性（已写的事件不清洗），但不再产生新的
  `team-run` 事件；任务层写的事件改用 `kind: 'task-settled'`。
- 删除 `workmate-team-run` runtime skill 与 `docs/TEAM-SETUP.md`，接入手册改为
  指向 Super-agent 的单一执行路径。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `team-orchestration`：整体移除（Run/Task/Dispatch 模型、DAG 波次、门禁自主推进、
  收件箱、重试终态、预算、G2 启动、入口按工件、G5 回流、默认限额）。
- `team-console`：整体移除（团队看板、DAG 视图、收件箱、运行时间线、面板契约）。
- `agent-team-roles`：整体移除（角色名册、权限与写域、模板装配）。
- `team-evidence`：**部分移除**——保留「六份团队工件」中与执行无关的 TASKS/TEST/
  TEAM-REVIEW 段头机检，移除「独立审查与测试证据」中依赖 Dispatch `sessionId` 的
  独立性判定、以及「结算汇总与归档映射」。
- `lifecycle-state-machine`：「八态生命周期状态机」的 `implementing` 前置去掉
  「团队 run 已启动」；「证据派生与自动推进」的 `planHash` 纳入范围去掉
  `REQ.md/PLAN.md/TASKS.json` 之外的团队产物判断，团队 Run 状态不再参与。
- `workbench-panel`：「流水线视图与最小人工动作」的证据列表去掉团队 Task 状态，
  「执行中不再逐态点击」的场景改为按 Ticket 投影。

## Impact

- **代码**：`src/features/team/**`（删除）、`src/index.ts`（~90 行接线）、
  `src/api.ts`（4 条路由 + 依赖类型）、`src/api.test.ts`、`src/config.ts`（7 个配置项）、
  `src/features/archive/{service,orchestrate}.ts`（归档门与 manifest 的 team 段）、
  `src/features/archive/{multitarget,trunk,orchestrate,team-gate}.test.ts`、
  `src/features/proposal/{readiness,events}.ts`（`teamRun` 检查与 `team-*` 事件）、
  `src/features/task/service.ts`（事件 kind）、`src/features/guidance/*`（runtime skill）、
  `src/client/{App.tsx,api.ts,styles.ts,team-waves.ts,app.test.tsx}`。
- **数据**：`workmate/team-runs.json` 不再读写；已有文件保留在磁盘上不删除（回退证据），
  下次启动不再加载。
- **配置兼容**：旧 profile 里若写了 `taskExecutor: team` 或其他 `team*` 键，
  Schemastery 的 `.strict()` 会拒绝整个条目——这一点必须在本变更里处理：
  这些键从 `Config` 移除，旧值在装回时会被判为未知键。**升级说明必须写明先删这些键。**
- **文档**：`AGENTS.md`、`README.md`、`docs/TEAM-SETUP.md`（删除）、
  `docs/SUPERAGENT-INTEGRATION.md`（回滚章节从三件事变两件事）、
  `docs/SUPERAGENT-ACCEPTANCE.md`（去掉团队相关条目）。
- **规格**：4 份整体归档为 REMOVED，3 份做 MODIFIED 增量。
