## 确认项

- 每条 swarm 需求都有对应处置：`swarm-parallel` 4 条、`swarm-verification` 4 条全部
  REMOVED；`scopesIntersect` 作为纯函数迁到 `proposal/writes.ts` 后，跨提案写域检查
  （`writeConflictGate`）继续有效，测试覆盖不变。
- 消费者枚举已核对：`src/index.ts`（SwarmManager 构造、2 个工具、归档钩子）、
  `src/config.ts`（2 项）、`src/features/archive/{orchestrate,service}.ts`（归档步骤与
  `tasks` 门）、`src/features/proposal/{store,service,writes,isolation}.ts`（字段与
  `scopesIntersect`）、`src/client/{types,App}.tsx`（详情区块）、
  `src/features/guidance/content.ts`（并行执行一节）——全部列在 proposal 的 Impact 里。
- `worktree.create` / `createTarget` 的唯一调用方分别是 `SwarmManager` 与已删除的团队
  执行器，删除后无悬空引用；`worktree.remove` 与 `PortAllocator` 的存活调用方（归档回收、
  任务端口规划与回收）在 design D2 里列明。
- 回滚计划完整：单个提交，`git revert` 可完整还原；`proposals.json` 里的历史
  `swarmTasks` 不删除，保留为回滚证据。
- 归档编排删掉 `swarm` 步骤后，`tasks` 门（tasks.md 完成度）与 `merging→archiving` 的
  git 合并校验仍在，没有引入"未合并也能归档"的空洞。

## 疑问项

- `worktree/manager.ts` 的 `remove()` 与 `task/reclaim.ts` 的回收逻辑重叠，是否下一期
  合并？本期不动，理由写在 design D2 与 Open Questions 第 1 条。
- `parallel-isolation` 规格是否需要跟着改述？它讲的是目录与端口隔离，不依赖 swarm；
  本期不改，待所有者确认。

## 建议补充项

- 建议在 `Config` 里为已删除的 2 个键各留一行 `// removed in remove-swarm-parallel`
  注释，说明它们曾经存在。
- 建议把"并发怎么来"写进任务面板的空态文案：多条待办 + Super-agent 的 `maxWorkers`，
  而不是让用户去找已经删掉的 swarm 工具。

## CRITICAL 问题

- [x] CRIT-1 删除 `src/features/swarm/` 后 `src/features/proposal/writes.ts` 仍 import
  `scopesIntersect`：必须把该函数迁入 `writes.ts`（或独立模块），否则整个插件编译失败。
- [x] CRIT-2 `src/features/archive/orchestrate.ts` 的 `tasks` 门读 `proposal.swarmTasks`
  并据此判失败，`swarmTasks` 字段删除后该判断必须一起删，否则类型不匹配且行为变成
  "永远为空 → 永远通过"。
- [x] CRIT-3 `src/client/types.ts` 的 `SwarmTaskRecord` 与 `proposal.swarmTasks` 被
  `App.tsx` 的详情区块使用：三处必须同步删除，否则客户端 typecheck 失败。
- [x] CRIT-4 `src/features/worktree/manager.ts` 删除 `create`/`createTarget` 后，
  `worktree.test.ts` 里针对它们的用例必须一起删（否则测试引用不存在的成员），
  同时保留 `remove` / `allocationFor` / 端口分配的用例。
