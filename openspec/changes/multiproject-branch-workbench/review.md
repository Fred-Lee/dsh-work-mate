# Review — 多项目多分支工作台：项目/分支选择与并行需求隔离

<!-- reviewer: workmate-lead (planning self-audit; independent review required before archive) -->

## 确认项

- [x] 确认：ProposalTarget 覆盖项目/基线分支/特性分支/worktree/端口，`effectiveTargets` 兼容旧标量（design D1/D3，specs/multi-target-worktree）与 tasks 2.1/3.1 对应。
- [x] 确认：worktree 创建按 `(proposal, project)`，端口键 `${id}--${project}`，失败逆序回滚（design D5/D6/D7，tasks 3.1/3.2）。
- [x] 确认：占用/写域隔离从活跃提案与 worktree 派生，不新增 `leases.json`；写域复用 `scopesIntersect`（design D5，specs/parallel-isolation）。
- [x] 确认：Workspace 候选发现只读官方 `ctx.workspaceRegistry`，过滤 git/openspec，不自动导入，注册表仍是权威（design D13，specs/project-registry）。
- [x] 确认：流水线视图与两道人门、`planHash`、自动推进一致（design D10/D12，specs/workbench-panel / lifecycle-state-machine）。
- [x] 确认：与 `autonomous-agent-team` 分工不重叠——本提案改 project-registry / lifecycle-state-machine / workbench-panel / approval-gate，团队提案只新增 agent-team-roles / team-*，不改这些 capability。
- [x] 确认：`ui-primitives` 作为 peer + client inject 的规划与 `pnpm verify:client` 白名单任务已列出（tasks 5.1/7.2）。
- [x] 确认：G2 前自动机检、CRITICAL 阻断、其余提示已写入 D12 与 lifecycle spec。

## 疑问项

- 疑问（INFO）：`primaryProject` 关联项目被删除或根失效时，OpenSpec 主目录如何回退？— 影响 multi-target-worktree 的 `resolved/unresolved` 语义；建议保持 unresolved 并提示，不自动迁移。
- 疑问（INFO）：`planHash` 是否纳入 `review.md`？— 建议不纳入；review 是评审产物，不是方案本身，否则修复审查意见会反复使批准失效。
- 疑问（INFO）：旧提案升级后首次 `reconcile` 可能出现状态跳变（如从 implementing 直接推导为 merging），是否需要「只提示不自动跳」的首启策略？— 建议首启 dry-run，展示将发生的转移。

## 建议补充项

- 建议：为 `reconcile` 提供只读 dry-run 端点，面板刷新只读、不写；自动推进由事件或显式动作触发。
- 建议：归档后增加 `.workmates/<id>` 孤儿目录检测与清理提示。
- 建议：为多目标提案的 `SUMMARY`/归档 manifest 增加「每个 target 的证据汇总」，避免只看主仓。
- 建议：归档前由独立 reviewer 重写本 `review.md`（当前为规划期自审，不满足审查者独立性）。
- HIGH-1：自动机检的具体检查项清单尚未落到 tasks（完整性之外还查什么：需求↔任务映射、target 覆盖、回滚步骤）。建议在 8.1/8.2 补一份检查清单与测试用例。
- HIGH-2：`reconcile` 的触发点未完全列出（提案创建、G2/G5、团队事件、面板读取），建议在 tasks 8.2 明确事件订阅与幂等键。

## CRITICAL 问题

- [x] CRIT-1 `planHash` 定义跨提案不一致：本提案原写 `REQ+PLAN+TASKS`，但这是团队工件名，OpenSpec 提案只有 `proposal/design/tasks/specs` — 违反：lifecycle-state-machine 要求可机检的方案哈希 — 修复：D12 与 lifecycle spec 改为「OpenSpec 工件 + 团队工件（若存在）」的规范化哈希（已修）。
- [x] CRIT-2 G5 单次批准与 `approval-gate` 默认 `['merging','archiving']` 冲突 — 违反：approval-gate 人工批准门 — 修复：新增 `specs/approval-gate` MODIFIED，默认改为 `['merging']`，配置可恢复两道；tasks 8.6 补齐（已修）。
- [x] CRIT-3 `reviewing/ready` 仍隐含提案分支前置，自动推进无法跳过 — 违反：D12 证据派生与自动推进 — 修复：lifecycle spec 明确 `proposalBranch` 为可选追溯，tasks 8.7 移除存在/合并前置（已修）。
