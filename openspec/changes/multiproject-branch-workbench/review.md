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

## 实现核验（2026-10-19，实现期自审）

<!-- reviewer: workmate-lead (implementation self-audit; independent reviewer still required before archive) -->

- 代码证据：`src/features/project/{registry,branches,workspace-candidates,status}.ts`、`src/features/proposal/{targets,plan,isolation,writes,readiness}.ts`、`src/features/worktree/manager.ts`、`src/features/archive/{service,orchestrate,manifest}.ts`、`src/client/{App,api,team-waves}.tsx`、`src/api.ts`、`src/index.ts`。
- 测试证据：`pnpm test` 75 文件 / 555 条通过；`pnpm verify` 五门禁全绿；`pnpm verify:built` 25 tools。
- 面板证据：默认列表、状态筛选、项目树（当前分支/脏文件/活跃 worktree）、详情抽屉（概览/目标矩阵/任务/审查/事件）、流水线看板、`?view=list` 截图已存 `docs/assets/ui/`。
- 仍未完成（不阻塞已实现能力）：`ui-primitives` 替换、`8.1` 之后的部分归档规格收尾、真机浏览器刷新后的最终截图。
- 归档前置：`review.md` 的独立 reviewer 仍待提供；当前标记为自审，不得当作独立审查通过。

## 独立审查（2026-10-19，subagent reviewer）

结论：**不通过（修复中）**。HEAD `c3139a4` 时发现 4 个 CRITICAL；本轮已修 C1/C3/C4 与 H2：

- C1 真实派发缺 reportPath：已加 `REPORT:` 标记 + 角色提示，tester/reviewer 可拿到 reportPath（需真实 worker 遵守）。
- C3 G2 失效：`ready→implementing` 现在对 target 提案重新校验 planHash；`reconcile` 在 ready 发现哈希变化会退回 reviewing；planHash 纳入 REQ/PLAN/TASKS 且忽略 tasks 勾选状态；plan 类 G5 拒绝仍走 implementing（待改为 ready）。
- C4 回滚：失败 target 释放端口；回滚成功 target 时删除本次创建的 feature 分支；remove 失败不再提前释放端口。
- H2 创建：客户端提交 targets/primaryProject；服务端拒绝“多 project 无 targets”的静默单目标化。

仍未修：C2 的 review-gate 接入（已改名 `TEAM-REVIEW.md` 避免大小写碰撞，但未接入 severity/未解决 CRITICAL 检查）、H1 无合并实现、H3 未用 git diff、H4 只读 preset 默认不生效、H5 团队证据默认 warn 且不查 Run 终态、H8 六份工件未生成。**不得归档。**

## 第二轮修复（2026-10-19）

- C3：G2 在 target 提案 implementing 前重校验 planHash；reconcile 支持 ready→reviewing；planHash 纳入 REQ/PLAN/TASKS 并忽略 checkbox。
- H2：创建提案提交 targets/primaryProject，服务端拒绝多 project 无 targets。
- C2/H4/H5 的团队侧修复见 `autonomous-agent-team/review.md`。
- 仍未修：H1 合并实现、H3 真实 git diff、H8 六工件生成等。**still not archivable.**

## 第三轮修复（2026-10-19）

- H3：`workmate_team_run` 现在把 target worktree 的 `git diff --name-only <baseCommit>` + untracked 文件作为 `filesModified` 送入 settle；`REPORT:` 路径在 verifyReportPath=true 时必须存在，否则按 failed 处理。
- H13（部分）：团队启动只允许提案处于 `implementing/merging`；target 提案的 G2 planHash 在进入 implementing 时已重校验。
- 仍未修：H1 合并实现、H7 token/挂死超时、H8 六工件归一化生成。**still not archivable.**

## 第五轮修复（2026-10-19）

- H1：`merging→archiving` 现在逐 target 执行真实 `git merge --no-ff feature → base`；项目不在基线分支/工作区脏/冲突时拒绝并 `merge --abort`，提案保持 merging；真实 git 测试覆盖成功与冲突。
- 工作台 task 8.4 恢复勾选：G5 一次批准覆盖合并与归档。
- 仍未修：H7 token/挂死超时、六工件自动生成默认行为、TEAM-REVIEW reviewer 身份校验。**still not archivable.**

## 第六轮修复（2026-10-19）

- H7（部分）：`TeamBudget.maxWaveMs`（默认 30 分钟），协调器对整波结果 `Promise.race` 超时；超时 abort Run 并返回 `单波超时`，补测试。token 仍只在宿主给 usage 时累计，缺失显示「未计量」（契约限制，不伪造）。
- 仍未修：六工件自动生成默认行为、TEAM-REVIEW reviewer 身份校验。**still not archivable.**

## 第七轮修复（2026-10-19）

- reviewer 独立性：`DispatchHandle.sessionId` → `SettleInput.sessionId` 落 Dispatch；协调器记录每个 session 的角色，reviewer 复用实现者 session 直接 failed（测试覆盖）。TEAM-REVIEW 文件内的 reviewer marker 仍只由人审，未做机检。
- 仍未修：六工件自动生成默认行为。**still not archivable.**

## 第二轮独立审查（2026-10-19，subagent）

- [x] C2 混排绕过（与团队侧共用 review 门）— 已修。
- [x] targets 已纳入 planHash；改 targets 会失效 G2。
- [ ] legacy 无 targets 提案的 G2 校验仍跳过（CRIT-8）。
- 仍不可归档：团队侧 CRIT-8/CRIT-9 未闭合。
