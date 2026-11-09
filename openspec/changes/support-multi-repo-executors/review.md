# Review — 多仓库执行器

> 交叉一致性审查报告。四节标题为机器可读约定，禁止改名或增删。
> `## CRITICAL 问题` 中的每个条目是 checkbox：`- [ ]` = 未解决（阻断归档），
> `- [x]` = 已解决。

## 确认项

- [x] 确认（代码级）：重复 kind 会被宿主拒绝。`registry.ts:21`
  `if (this.kinds.has(kind.kind)) throw`——参数化 kind 是唯一不复制包的做法。
- [x] 确认（代码级）：`KIND` 的派生点共 4 类 6 处（`kind.kind`、`health`、
  `STATE_PREFIX` 两键、Trigger `source`、`find` 的 thread key），design D2 已逐一列出，
  漏一处就会串台。
- [x] 确认（代码级）：`scanOnce` 当前不看 `repo`（`watch.ts:108-190`），
  `GateTask` 也无 `repo` 字段——按仓库过滤必须新增，不能复用现有流程。
- [x] 确认（代码级 + 真机）：`connectable()` 因 `index.ts` 未传 `executorRepo`
  而恒返回 true（`service.ts:350`）；实测面板对所有 repo 均显示可指派。
  本变更把"恒真"改为"按集合判定"，并把未配置视为不限（保持旧行为）。
- [x] 确认：归档门、合并校验、回收都已按 target 维度遍历（`service.ts` 的
  `mergeTargets` / `cleanupTargets`），多仓提案不需要跟着改。
- [x] 确认：`prepare` 的 `$PWD` 是 `dirname(ticket.directory)`（`executor/dsh.ts:255`），
  每个执行器有自己的 `executor.directory`，多仓时无需改模板；但
  `deployment.repository` 必须与该目录所属仓库一致（design D7）。
- [x] 确认：重启边界成立。kind 注册在插件 `apply` 阶段，配置变更需重新 apply；
  重启会终止 worker 自身，所以任务 12 标 `[需重启]` 且由人执行（design D6）。

## 疑问项

- 多端点聚合后，`/api/tasks` 的 `health` 字段从单值变列表是**破坏性变更**（面板与
  `/api/config` 消费者）。方案：保留 `health`（取首个端点，兼容旧客户端），
  新增 `endpoints` 数组。需要在任务 8/9 里落实，否则旧面板会读错。
- `skippedByRepo` 是否需要面板可见？倾向只进健康摘要与 `notes`，不占卡片位置——
  否则多仓部署时首屏会被"跳过 N 条"淹没。待实现时确认。

## 建议补充项

- 接入手册的「多仓库部署」一节应给出四处必须一致的检查清单
  （stateDir / executor.directory / deployment.repository / source.repos），
  这四处错一处就会出现"验的是 A 仓、建在 B 仓"的静默错位（design D7）。

## CRITICAL 问题

<!-- 每条一个 checkbox，未勾选即阻断归档。 -->

- [x] 无未解决 CRITICAL 问题（疑问项 1 已在任务 8/9 的要求里落实为兼容策略）。
