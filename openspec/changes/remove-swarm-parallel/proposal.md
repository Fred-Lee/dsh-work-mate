# 提案：移除 swarm 任务级并行载体

## Why

`swarm`（773 行 + 2 个工具 + 4 条规格需求）是为"每个任务一个 worktree、独立分支、
装批合并"服务，前提是**任务由调用方的子代理并行执行**。

这个前提在 `adopt-superagent-openspec-source` 之后不成立了：Super-agent 本身就是
"一 Ticket 一 worker 一 worktree"，并发由 `executor.maxWorkers` 管，合并由它跟 PR
或由 WorkMate 的归档门查。`swarm` 现在做的是同一件事，但少了 Eval、准入、PR 绑定，
而且需要调用方自己记住"start → 改代码 → merge → verify"四步。

团队执行器已经按同一理由删除（`remove-team-executor`）。`swarm` 是同一类重复，
只是它比团队更早、更窄。

## What Changes

- **BREAKING**：删除 `src/features/swarm/`（manager / plan 与两个测试文件）。
- **BREAKING**：删除 2 个 agent 工具 `workmate_swarm_plan` / `workmate_swarm_task`。
- **BREAKING**：删除配置项 `maxConcurrent`（在此之前已标注 "reserved"，无消费者）与
  `swarmReviewRequired`。
- 删除归档编排的 `swarm` 步骤、`runSwarmTasks` 钩子、以及 `tasks` 门里"swarm 任务未合并
  即失败"的判断。
- 删除提案记录的 `swarmTasks` 字段（写入白名单与客户端类型同步移除）；面板详情不再展示
  swarm 任务列表。
- 删除 `workmate-team-run` 之外的另一段执行 guidance（`workmate-proposal-flow` 里的
  "并行执行（swarm）"一节）。
- **保留**：`scopesIntersect`（声明写域的子树重叠判断，10 行）迁到
  `src/features/proposal/writes.ts`——跨提案写域冲突检查仍然用它，只是不再经过 swarm 的
  `planSwarm`。
- **保留**：`src/features/worktree/` 的 `remove()` 与端口分配。前者仍被归档回收使用，
  后者仍被任务级端口规划使用；`create()` / `createTarget()` 在 swarm 删除后没有调用方，
  一并删除。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `swarm-parallel`：整体移除（任务装批、任务级 worktree、合并仲裁、归档验收）。
- `swarm-verification`：整体移除（核验记录、未合并不得核验、独立性派生、可选归档门）。
- `archive-gates`：「归档步骤的成败判据」不涉及 swarm，无需改动；`planDriftGate` 与
  `reviewEvidenceGate` 的行为不变。
- `proposal-middleware`：`swarmTasks` 字段移除（若该规格里没有提到它则不动）。
- `parallel-isolation`：该规格讲的是跨提案的 worktree 与端口隔离，不依赖 swarm；不改。

## Impact

- **代码**：`src/features/swarm/**`（删除）、`src/index.ts`（~120 行接线与 2 个工具）、
  `src/config.ts`（2 个配置项）、`src/features/archive/{orchestrate,service}.ts`、
  `src/features/proposal/{store,service,writes,isolation}.ts`、
  `src/features/worktree/manager.ts`（删 `create`/`createTarget` 及其依赖的
  `copyFiles`/`packageManager`）、`src/client/{types,App}.tsx`、
  `src/features/guidance/content.ts`。
- **数据**：提案记录里已有的 `swarmTasks` 不清洗（读取端忽略该字段），新代码不再写。
  归档 manifest 不受影响（它本来就没引用 swarm）。
- **配置兼容**：`maxConcurrent` / `swarmReviewRequired` 从 `Config` 移除；旧 profile 里
  保留这两个键不会报错（Schemastery 对未知键透传）。
- **文档**：`AGENTS.md` 的 swarm 段、`README.md` 的 5.7 节、`docs/DESIGN.md` 的 M14 行。
- **规格**：`swarm-parallel`、`swarm-verification` 两份整份删除。
