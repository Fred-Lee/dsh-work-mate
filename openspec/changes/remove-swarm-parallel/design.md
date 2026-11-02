# Design — 移除 swarm 任务级并行载体

## Context

`swarm` 由三个部分组成：

1. `plan.ts`（122 行）：`parseSwarmTasks` 从 `tasks.md` 的 `<!-- writes: ... -->` 注释派生
   任务，`planSwarm` 按写域冲突做贪心装批，`scopesIntersect` 判断声明范围是否重叠。
2. `manager.ts`（312 行）：`SwarmManager` 为每个任务建 worktree + 分支、`merge` 合回、
   `verify` 记录独立核验并把结果写进 `proposal.swarmTasks`。
3. 两个 agent 工具与归档编排里的 `swarm` 步骤。

它在 `adopt-superagent-openspec-source` 之后失去前提：那时任务由调用方的子代理并行执行，
WorkMate 需要替它们做 git 隔离与合并纪律；现在执行是 Super-agent 的 Ticket，每个 Ticket
自带 worktree 与分支，并发由 `executor.maxWorkers` 控制。

## Goals / Non-Goals

**Goals**

- 删除重复的并行载体与它的全部接线（2 个工具、1 个配置项组、1 个归档步骤、1 个数据字段、
  1 个面板区块、1 段 guidance）。
- 保留跨提案写域冲突检查（它只需要 10 行的 `scopesIntersect`）。

**Non-Goals**

- 不动 Super-agent 的执行模型。
- 不迁移历史 `swarmTasks` 数据（保留在记录里，读取端忽略）。
- 不重建"任务级并行"；需要并发时用多条待办 + Super-agent 的 `maxWorkers`。

## Decisions

### D1: `scopesIntersect` 迁到 `proposal/writes.ts`，其余整删

写域冲突检查（`writeConflictGate`）是提案治理的一部分：两个提案声明了重叠的写域时，
归档前要报出来。它唯一的依赖就是"两个 scope 字符串是否重叠"这个纯函数。

**备选**：保留整个 `plan.ts`（含 `parseSwarmTasks` / `planSwarm`）。否决：那两个函数没有
消费者——没有执行器就没有"装批"。

### D2: `worktree.create` / `createTarget` 一并删除

`create` 的调用方只有 `SwarmManager`；`createTarget` 的唯一调用方是已删除的团队执行器。
删除它们之后，`copyFiles` / `packageManager` 两个配置项也失去消费者。

**保留**：`worktree.remove()` 仍被归档回收（`archiving` 时清理遗留目录）使用；
`PortAllocator` 仍被任务级端口规划（`task/plan.ts`）与回收（`task/reclaim.ts`）使用。

**风险**：`remove()` 与 `reclaim.ts` 的回收逻辑有部分重叠（前者按 proposalId 推路径，
后者按 Ticket 目录）。这一期不动，因为前者服务的是"团队时代遗留的 `targets[].worktreePath`"，
后者服务 Super-agent 的 Ticket 目录，两种来源不同。

### D3: 归档的 `swarm` 步骤整段删除

`orchestrateArchive` 的步骤序列里，`swarm` 一直是"报告而非派发"（design D1 原文），
在 `runSwarmTasks` 未注入时输出一句"无 swarm 任务"。删掉它不会让任何真实检查消失：
- "任务未合并"的判断本来也已经由 `tasks` 门（`tasks.md` 完成度）和
  `merging→archiving` 的 git 合并校验覆盖；
- `swarmReviewRequired` 是可选门，默认关闭，且其数据源（`swarmTasks`）随字段一起消失。

**备选**：保留一个 `swarm` 步骤输出"本提案未使用任务级并行"。否决：那是一句永真的
占位文案，删掉后步骤列表更短、更容易读。

### D4: `swarmTasks` 字段从写入白名单移除，历史值不清洗

`proposals.json` 是用户数据，删除字段不需要迁移：读取端忽略未知键，写入端不再产生。
把它留在 `PATCHABLE` 白名单里会让外部还能写一个没有消费者的字段，所以删白名单项。

### D5: 面板详情删掉 swarm 任务区块

提案抽屉里那段"swarm 任务 + 分支 + 核验状态"在字段删除后没有数据来源；保留只会渲染空块。

## Risks / Trade-offs

- **失去"逐任务独立核验"的可选门**：`swarmReviewRequired` 删除后，归档只剩
  `reviewerIndependence` 与 `teamEvidenceGate`。→ 缓解：这两条都按工件判断，覆盖
  同样的"谁审的、有没有证据"问题；逐任务粒度不再有，因为不再有任务级分支。
- **`worktree.create` 删除后不能再从 WorkMate 侧创建 worktree**：被删的路径本来就只服务
  swarm。→ 缓解：归档回收仍能删；规划仍在（基线、分支名、端口）。
- **历史 `swarmTasks` 字段残留**：面板不再显示，数据仍在。→ 有意保留（回滚证据）。

## Migration

1. 删 `src/features/swarm/`、2 个工具、`maxConcurrent` / `swarmReviewRequired` 配置。
2. 旧 profile 里的这两个键建议删除（不删也能装载，值被忽略）。
3. `proposals.json` 里的 `swarmTasks` 不清洗，读取端忽略。
4. 回滚：单个提交，`git revert` 可完整还原。

## Open Questions

1. `worktree/manager.ts` 与 `task/reclaim.ts` 的回收逻辑重叠，是否下一期合并成一个？
   本期不动，理由见 D2。
2. `parallel-isolation` 规格里"跨提案 worktree 隔离"的表述是否需要跟着改？它描述的是
   目录与端口隔离，不依赖 swarm；本期不改。
