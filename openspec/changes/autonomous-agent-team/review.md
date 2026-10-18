# Review — 自主 Agent 团队：需求与方案评估 → 前后端并行实现 → 集成测试

<!-- reviewer: workmate-lead (planning self-audit; independent review required before archive) -->

## 确认项

- [x] 确认：7 角色职责/产出/权限边界与 `agent-team-roles` 规格一致；评估/审查只读、开发/测试/协调器 workspace 写（design D1，spec agent-team-roles）。
- [x] 确认：worker 形态与宿主契约一致——协调器顶层 Session、worker 可续跑 Subagent、`cwd` 绑定 target worktree（design D2，已核实 `ctx.subagents.startActivation` 支持 cwd/续跑/消息/中断）。
- [x] 确认：Run/Task/Dispatch、DAG 波次、收件箱、positive proof、release/retain 与 Orca 语义对应（design D3/D4/D7，spec team-orchestration）。
- [x] 确认：G2 批准即启动、不重复评估；已有 OpenSpec 工件走归一化后直接 G2（design D5，spec team-orchestration）。
- [x] 确认：默认限额（并发 3 / 2 次重试 / 2h / 300k / 20 Dispatch）已写入 D6 与规格。
- [x] 确认：G5 一次批准与 `multiproject-branch-workbench` 的 approval-gate 修订一致，团队不引入第二套人工门。
- [x] 确认：测试写域允许清单、依赖变更单独审批、`git diff --name-only` 机检已写入 team-evidence 规格。
- [x] 确认：G5 拒绝按方案/实现原因分流（design D5，spec team-orchestration）。

## 疑问项

- 疑问（INFO）：`TASKS.json` 由 `tasks.md` 归一化生成时，`role/project/depends_on` 的推断规则是否需要人工确认？— 建议：默认推断 + G2 展示映射表，允许人在确认前修正。
- 疑问（INFO）：`maxActiveSubagents` 默认 8，7 角色并发 3 时是否会被其他会话占用导致 `ACTIVATION_LIMIT_REACHED`？— 建议：容量不足时排队/上报，不静默降级。
- 疑问（INFO）：协调器 Session 的 cwd 用主项目还是独立 run 目录？— 建议主项目；worker 各自 worktree。

## 建议补充项

- 建议：`team-console` 的 DAG 视图需要定义大图降级（>50 Task 时折叠/只显示关键路径）。
- 建议：为 `worker_done` 的 `--files-modified` 与 `writes` 做交叉校验，越界即 violated。
- 建议：归档前由独立 reviewer 重写本 `review.md`（当前为规划期自审，不满足审查者独立性）。
- HIGH-1：宿主服务装配只列了 reactive inject，但未定义 `subagents`/`sessionController` 缺失时的用户可见降级路径。建议 tasks 2.8 补：团队入口置灰 + 原因，单提案模式仍可用。
- HIGH-2：归一化从 `tasks.md` 生成 `TASKS.json` 的保真度没有测试用例；建议 6.1 增加一个真实 OpenSpec change 的归一化快照测试。
- MED-1：角色模型先统一默认，未定义后续如何做 A/B 或角色覆盖的验收；建议留到调优阶段。

## CRITICAL 问题

- [x] CRIT-1 入口模式自相矛盾：直接进 G2 跳过 G0/G1，但 G2 原要求 `REQ.md/PLAN.md/TASKS.json`，已有 OpenSpec 提案没有这些文件 — 违反：团队入口按工件判断 — 修复：新增归一化（派生 REQ/PLAN，标记 derived；tasks.md 生成 TASKS.json），G2 要求 TASKS.json 与 DAG 无环（已修）。
- [x] CRIT-2 `planHash` 原定义 `REQ+PLAN+TASKS` 与 OpenSpec 工件不一致，跨提案无法对齐 — 违反：G2/G5 方案哈希 — 修复：改为方案工件规范化哈希（OpenSpec + 团队工件），与 `multiproject-branch-workbench` D12 对齐（已修）。
- [x] CRIT-3 G5 单次批准与 `approval-gate` 原默认两道门冲突 — 违反：现有 approval-gate — 修复：由 `multiproject-branch-workbench` 增加 approval-gate delta，默认 `['merging']`；本提案只引用（已修）。
