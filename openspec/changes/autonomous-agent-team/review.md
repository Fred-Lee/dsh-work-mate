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

## 实现核验（2026-10-19，实现期自审）

<!-- reviewer: workmate-lead (implementation self-audit; independent reviewer still required before archive) -->

- 代码证据：`src/features/team/{types,roster,tasks,artifacts,store,runner,coordinator,host-dispatcher,inbox,prompts,presets,models,summary,events,tools,evidence,completeness,auto-plan}.ts`、`src/client/App.tsx`（团队视图/波次/角色/收件箱）、`src/api.ts`（`/api/team/runs*`）、`src/index.ts`（25 工具）。
- 测试证据：团队相关 20+ 文件；`pnpm test` 75 文件 / 555 条通过；`pnpm verify` 五门禁全绿；`verify:built` 确认团队 5 工具在构建产物中。
- 真实宿主：通过 plugin manager 禁用/启用 `include:workmate` 热重载成功，WorkMate 指令重新注入（无需重启 harness）；浏览器端需刷新。
- 仍未完成：无 agent 上下文的 G2 自动派发衔接（2.0 的 REST 侧限制）、`git diff` 结果与测试允许清单的自动闭环（已提供 `changedFilesSince`，当前主要依赖 worker `FILES:` 报告）、角色级 preset 的实际 profile 配置（代码与配置项已就绪）。
- 归档前置：`review.md` 的独立 reviewer 仍待提供；当前标记为自审，不得当作独立审查通过。

## 独立审查（2026-10-19，subagent reviewer）

结论：**不通过（修复中）**。独立审查发现 4 个 CRITICAL；本轮修复：

- C1：`HostSubagentDispatcher` 支持 `REPORT:` 并写入 `reportPath`；prompt 对工件角色要求输出 REPORT；测试覆盖。
- C2：团队审查工件从 `REVIEW.md` 改名为 `TEAM-REVIEW.md`，避免 macOS 大小写不敏感与规划期 `review.md` 冲突；**仍未接入 review-gate 的 severity/未解决 CRITICAL 检查**。
- C3：G2 在 implementing 前重新校验 target 提案的 planHash；reconcile 支持 ready→reviewing 回退；planHash 纳入团队工件并忽略 tasks 勾选。
- C4：多 target 失败释放端口、回滚删除本次 feature 分支；真实 git 测试覆盖。

仍未修：H3 未在 settle 用 `git diff --name-only`、H4 只读 preset 默认不生效、H5 团队证据不查 Run 终态、H7 token 预算宿主无 usage、H8 六份工件未生成、H13 启动未校验提案 G2 状态。**不得归档。**

## 第二轮修复（2026-10-19）

- C2：`TEAM-REVIEW.md` 接入 review-gate：未解决阻断级发现使归档失败；step 名 `team-review`；测试覆盖。
- H4：`teamRequireRolePresets` 默认改为 `true`，缺角色 preset 默认拒绝派发。
- H5：团队证据门默认 `block`；要求 `SUMMARY.md`；最近 Run 为 partial/blocked/aborted 时阻断归档；测试覆盖。
- 仍未修：H1 合并实现、H3 真实 git diff/reportPath 存在性、H7 token usage、H8 工件生成、H13 启动前 G2/状态校验。**still not archivable.**

## 第三轮修复（2026-10-19）

- H3：`workmate_team_run` 现在把 target worktree 的 `git diff --name-only <baseCommit>` + untracked 文件作为 `filesModified` 送入 settle；`REPORT:` 路径在 verifyReportPath=true 时必须存在，否则按 failed 处理。
- H13（部分）：团队启动只允许提案处于 `implementing/merging`；target 提案的 G2 planHash 在进入 implementing 时已重校验。
- 仍未修：H1 合并实现、H7 token/挂死超时、H8 六工件归一化生成。**still not archivable.**

## 第四轮修复（2026-10-19）

- H8（部分）：新增 `workmate_team_prepare`，从 proposal/design/tasks.md 派生 REQ/PLAN/TASKS.json（`derived: true`、不覆盖已有、缺 role/project 给出警告并按默认值派生）；证据工件仍不会自动生成。
- 仍未修：H1 合并实现、H7 token/挂死超时、六份工件“随提案自动生成”仍不是默认行为。**still not archivable.**

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

结论：**仍不通过**。上一轮 4 个 P0 已修复并有测试；本轮发现的新问题如下。

已修复：
- [x] CRIT-4 TEAM-REVIEW/review.md 混排绕过（tagged HIGH + legacy CRITICAL 不计 blocking）— 统一混入 legacy，补混排测试。
- [x] CRIT-5 多 target 回滚误删已有分支/commit — `branchCreated` 仅在本次新建时删分支，真实 git 重入测试。
- [x] CRIT-6 maxDispatches 触发死循环 — 无可派发时暂停上报，补测试。
- [x] CRIT-7 targets 不进 planHash — targets(project/baseBranch) 纳入 hash，改 targets 使 G2 失效，补测试。
- [x] H-A 部分：targets 快照已进 hash；legacy 无 targets 仍跳过（未修）。
- [x] H-D 部分：prepare PLAN 目标矩阵从 targets 派生；空 writes 警告。
- [x] H-F：超时取消/dispose 在跑 worker，清除定时器。
- [x] H-G 部分：写角色有改动必须 commit 且分支 ahead-of-base；SUMMARY 未跟踪不再阻断 merge。

未修复（阻断归档）：
- [x] CRIT-8 legacy 提案无 targets 时 G2 静默跳过 — 已改为只要 plan 工件存在就校验 G2；补 legacy 测试。
- [x] CRIT-9 G5 plan 拒绝退回 ready — 已改为 merging→implementing→ready，并保留 G2 reject；再次 implementing 需要新 approvePlan；plan 测试更新。
- [x] HIGH reviewer 独立性：TEAM-REVIEW marker 必须对应 Run 中 reviewer dispatch，且不得等于实现者 session；补测试。
- [ ] HIGH 当前提案记录仍是 reviewing、无 targets/approvals，change 目录缺 6 工件，从未真机跑 Run。

## 第八轮修复（2026-10-19，中期审查）

- reviewer 身份：HostSubagentDispatcher handle 恢复 `sessionId/cancel`；reviewer prompt 注入 `<!-- reviewer: <dispatchId> -->`；证据门改为 marker 必须等于 Run 中 reviewer dispatch id（且不得等于实现者 dispatch id）。补测试。
- review 混排：新增 `withLegacyCriticals` 统一 review.md 与 TEAM-REVIEW.md；resolved tagged CRIT 不再吞掉同文本 unresolved legacy CRIT；TEAM-REVIEW 的 legacy CRIT 现在参与 tally。补两条测试。
- 仍不可归档：提案记录/工件/Run/G2/G5 均未就绪；最终独立审查报告未出。

## 第九轮修复（2026-10-19，第三轮审查报告）

- C-1 reviewer marker 不可满足：`buildTaskPrompt` 现在传 `dispatchId`，reviewer 规则要求 `TEAM-REVIEW.md` 首行写 `<!-- reviewer: <dispatchId> -->`；证据门比对 dispatch id。测试断言 prompt 含 Dispatch 与 marker。
- MEDIUM tally 双计：legacy 合并收进 `reviewTally`，按同文本+同 resolved 去重；当前 review.md 不再 0/18。
- H-1：团队证据门要求最近 Run 为 `succeeded`，`running/planned` 一律阻断；测试。
- H-2：存在团队 Run 时即使删掉 TASKS.json 也不能关闭团队证据门；测试。
- H-3：TEAM-REVIEW.md / TEST.md 的 `file:line` 引用纳入 reviewEvidenceGate（block 生效）。
- H-4：回滚只删除本次新建的 worktree，复用 worktree 不再 force 删除。
- H-5：`feat/workmate` 已快进到当前 HEAD（5ea681d），主干含变更目录与团队代码。
- H-6：协调器启动时从历史 dispatches 重载 session→role，跨 maxWaves 恢复也能发现 reviewer 复用；测试。
- H-D：多 target 且任务未声明 `project` 时 prepare 直接拒绝，不再生成必然失败的主项目矩阵；测试。
- **仍不可归档**：提案记录/工件/G2/G5/Run 未就绪，独立审查未最终放行。

## 第十轮修复（2026-10-19，第四轮审查 P1/P2）

- P1：`runArchive` 在真正归档前重查团队证据（最近 Run 必须 succeeded、TASKS.json 必须在），补 planned/running/缺 TASKS 的 runArchive 测试。
- P2(a)：归档门增加 reviewer/implementer **sessionId 不相交**校验。
- P2(b)：协调器把 `handle.sessionId` 合并进 settle；reviewer 复用命中时 cancel 并消费 handle.result，避免孤儿 child。
- P2(c)：空文本 tagged CRIT 不再吞掉 legacy。
- P2(d)：prepare 先派生/校验 TASKS 再写 REQ/PLAN，多 target 失败不再留半份产物。
- 主干 `feat/workmate` 同步。**仍不可归档**：提案工件/G2/G5/Run/独立审查放行未就绪。
