# Tasks

## 1. 角色与工件契约（T1）

- [x] 1.1 定义 7 角色名册与 `RoleContract`：职责、产出、可写域、权限预设、禁止项；支持模板裁剪。<!-- writes: src/features/team/**, src/config.ts -->
- [x] 1.2 定义 `Run` / `Task` / `Dispatch` 数据模型与 `team-runs.json` 原子存储；损坏 fail-closed。<!-- writes: src/features/team/**, src/features/proposal/store.ts -->
- [x] 1.3 `TASKS.json` schema 与校验：每个 Task 必须有 `role/project/writes/depends_on/acceptance`；DAG 无环。<!-- writes: src/features/team/**, src/features/swarm/plan.ts -->
- [x] 1.4 六份工件模板：`REQ.md` / `PLAN.md` / `TASKS.json` / `TEST.md` / `REVIEW.md` / `SUMMARY.md`，随提案目录生成。<!-- writes: src/features/team/**, src/features/proposal/openspec.ts -->
- [ ] 1.5 入口判断：检查 OpenSpec 工件完整性与 validate，决定从 G2 还是 G0 开始；支持调用方覆盖并记录理由。<!-- writes: src/features/team/**, src/features/proposal/** -->
- [ ] 1.6 入口归一化：从 `proposal.md/design.md` 派生 `REQ.md/PLAN.md`（`derived: true`），从 `tasks.md` 生成 `TASKS.json`（role/project/writes/depends_on/acceptance），不改变方案范围。<!-- writes: src/features/team/**, src/features/proposal/openspec.ts -->

## 2. 编排核心（T2）

- [ ] 2.0 G2 启动链：批准 `planHash` 后自动创建 Run、派发第一波；不重复调用需求/方案评估；方案变更使 run 暂停并退回待确认。<!-- writes: src/features/team/**, src/features/proposal/** -->

- [x] 2.1 `workmate_team_plan`：从提案 targets 与模板生成 Run + DAG，校验写域冲突与依赖。<!-- writes: src/features/team/**, src/index.ts -->
- [x] 2.2 `workmate_team_dispatch`：为 Task 创建原生 Session/Subagent，cwd 绑定 target worktree，记录 dispatch 与 sessionId；幂等防重复。<!-- writes: src/features/team/**, src/features/worktree/** -->
- [x] 2.3 波次调度：拓扑分层、`maxParallel`、同 target 写域冲突串行；先起完整波次再等待。<!-- writes: src/features/team/** -->
- [ ] 2.4 收件箱与协调循环：`check/reply/ack`、`worker_done` 校验、`escalation/question` 升级、positive proof 才 stop/retry/release。<!-- writes: src/features/team/** -->
- [x] 2.8 宿主服务装配：reactive `ctx.inject(['subagents','sessionController'], scope)`；缺失时团队不可用并提示，不 park fiber。<!-- writes: src/index.ts, src/features/team/** -->
- [ ] 2.5 自主策略与预算：G2 后自动推进、每 Task 2 次重试、默认并发 3、Run 预算 2h/300k tokens/20 Dispatch、终态枚举；超限暂停并上报。<!-- writes: src/features/team/**, src/config.ts -->
- [ ] 2.6 G5 拒绝回流：方案问题退回 ready 重走 G1/G2；实现/测试/审查问题退回 implementing 生成修复 Task；写 approval 记录。<!-- writes: src/features/team/**, src/features/archive/** -->

## 3. 角色实现（T3）

- [x] 3.1 需求评估角色：提示词/工具边界，产出 `REQ.md`（目标/边界/禁止项/验收判据），只读代码。<!-- writes: src/features/team/prompts/**, assets/** -->
- [x] 3.2 技术方案评估角色：产出 `PLAN.md` + `TASKS.json`（目标矩阵/依赖/回滚），只读代码。<!-- writes: src/features/team/prompts/**, assets/** -->
- [x] 3.3 前端/后端角色：按 target 写域实现，产出提交与 Task 证据；不得越界改文件。<!-- writes: src/features/team/prompts/**, assets/** -->
- [x] 3.4 集成测试角色：跨仓契约/E2E/回归，产出 `TEST.md`；允许改测试脚本但不改业务代码。<!-- writes: src/features/team/prompts/**, assets/** -->
- [x] 3.5 独立审查角色：只读评审，产出 `REVIEW.md`；与实现者身份不同。<!-- writes: src/features/team/prompts/**, assets/** -->
- [ ] 3.6 权限预设：评估/审查只读，开发/测试/协调器 workspace 写；不默认 full access；启动时固定。<!-- writes: src/features/team/**, src/config.ts -->
- [ ] 3.7 模型配置：默认继承会话模型，支持角色级覆盖；本版本不要求逐角色配置。<!-- writes: src/features/team/**, src/config.ts -->

## 4. 证据与门禁（T4）

- [ ] 4.1 G0/G1/G2 门禁：REQ/PLAN/TASKS 完整性与可实现性检查；G2 硬门 + 人确认门（高风险/多仓强制）。<!-- writes: src/features/team/**, src/features/quality/** -->
- [x] 4.2 G3/G4 门禁：TEST/REVIEW 产物与证据机检；接入现有 `review-gate` 与 `reviewEvidenceGate`。<!-- writes: src/features/team/**, src/features/archive/** -->
- [ ] 4.3 `SUMMARY.md` 与 run 结算：逐 Task outcome + 证据 + 未解阻塞；映射到归档 manifest。<!-- writes: src/features/team/**, src/features/archive/manifest.ts -->
- [ ] 4.4 事件与审计：dispatch/done/gate/decision 写 `events.jsonl`；面板可回放。<!-- writes: src/features/team/**, src/features/proposal/events.ts -->
- [ ] 4.5 测试写域机检：`git diff --name-only` 对照测试允许清单；越界标记 violated；测试依赖变更单独 Task + 人批准。<!-- writes: src/features/team/**, src/features/quality/** -->

## 5. 团队控制台（T5）

- [ ] 5.1 团队视图：角色看板、Task 状态、当前 worker。<!-- writes: src/client/App.tsx, src/client/api.ts -->
- [ ] 5.2 DAG 视图：依赖边、波次、关键路径。<!-- writes: src/client/App.tsx, src/client/styles.ts -->
- [ ] 5.3 收件箱：question/escalation 列表与一键回答；阻塞 Task 高亮。<!-- writes: src/client/App.tsx, src/client/api.ts -->
- [ ] 5.4 运行时间线与证据面板：六份工件 Markdown 渲染、commit/文件链接。<!-- writes: src/client/App.tsx, src/client/styles.ts -->

## 6. 测试与验证

- [ ] 6.1 单测：角色契约、DAG 无环与波次、写域冲突、重试/预算/终态、inbox FIFO 与 ack、门禁缺失证据。<!-- writes: src/features/team/**/*.test.ts -->
- [ ] 6.2 宿主探针：原生 Session 派发 + cwd 绑定是否可行；不可行时 Subagent 降级路径可用。<!-- writes: src/features/team/** -->
- [ ] 6.3 客户端测试：团队视图/DAG/收件箱；沿用 UI 重构后的组件；`pnpm verify:client` 绿。<!-- writes: src/client/*.test.tsx -->
- [ ] 6.4 门禁：`pnpm typecheck && pnpm test && pnpm build && pnpm verify` 全绿。<!-- writes: package.json -->
- [ ] 6.5 真机验收：一个两仓提案走 requirement-full 模板，G2 人确认后自动跑前后端→集成测试→审查；截图团队看板与收件箱；失败注入一次验证升级。<!-- writes: docs/AGENT-TEAM-DESIGN.md -->

## 7. 文档与归档

- [ ] 7.1 更新 `AGENTS.md`：团队编排的工具面、数据落盘、与八态/门禁的关系。<!-- writes: AGENTS.md, CLAUDE.md -->
- [ ] 7.2 补齐 `openspec/specs/` 主规格并归档；归档前跑 `review.md`。<!-- writes: openspec/** -->
