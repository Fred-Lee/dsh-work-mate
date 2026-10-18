# Design — 自主 Agent 团队：需求与方案评估 → 前后端并行实现 → 集成测试

## Context

WorkMate 已有：八态提案、`ProposalTarget` 多仓/分支矩阵、swarm 任务级 worktree + `writes` 装批、worktree 生命周期、review/approval/plan-drift 门禁、事件流与度量。缺的是**角色化的执行层**与**方案确认后的自主推进**：现在由人反复切换提示词、手工汇总审查意见，且没有「谁负责需求评估、谁负责方案、谁负责集成测试」的稳定契约。

## Goals / Non-Goals

**Goals:**

- 固定的 7 角色名册与产出契约，角色可裁剪。
- 方案确认后，协调器按依赖 DAG 自主派发前后端实现、集成测试与独立审查，不再逐步问人。
- 每个 worker 是原生 DSH Session，cwd 绑定 target worktree；WorkMate 只编排、记录、门禁。
- 全链路工件与证据可复核，接入现有归档门。
- 失败、重试、阻塞、停止都有明确终态与审计。

**Non-Goals:**

- 不自建 agent runtime、聊天、群聊、IM、Bot 市场。
- 不替代宿主 Conversation / Workspace / Session。
- 不改变 merging/archiving 的人工批准语义。
- 不在本期做跨机器调度；只在本机 DSH 进程内协调。

## Decisions

### D1 角色名册（可裁剪）

固定 7 个角色：`coordinator`、`requirement-evaluator`、`solution-evaluator`、`frontend-dev`、`backend-dev`、`integration-tester`、`reviewer`。每个角色有：职责、产出工件、可写域、权限预设、不可越界项。模板决定启用哪些角色（纯调研跳过前后端；bug 修复可跳过需求/方案，但独立审查保留）。

**权限预设**：`requirement-evaluator` / `reviewer` 只读；`frontend-dev` / `backend-dev` / `integration-tester` / `coordinator` 为 workspace 写；不默认 `danger-full-access`，需要时由人显式设置。

**模型**：先统一使用会话默认模型，配置保留角色级覆盖；后续再按角色调强/调快。

### D2 协调器 = 顶层 Session；worker = 可续跑 Subagent

协调器是一个原生顶层 DSH Session（cwd=主项目，用户可打开观察）；每个角色 worker 是协调器的直接 Subagent（in-process spawn，`cwd` 固定为对应 target 的 worktree）。宿主 `ctx.subagents.startActivation` 已支持 `cwd`、`sendMessage`、`interrupt`、`listChildren`、cold resume、`dispose`，权限在启动时固定；`maxDepth` 默认 1、`maxActiveSubagents` 默认 8，足够 7 角色按 3 并发运行。

WorkMate 不实现 loop、不发消息给模型、不存对话正文；只记录 Dispatch 的 childId、状态与回执。宿主服务经 reactive `ctx.inject(['subagents','sessionController'], scope)` 获取；缺失时团队不可用并提示，不 park fiber。不把每个 worker 建成顶层 Session：那会污染 Workspace 侧栏、增加归属与归档复杂度；需要用户独立打开或跨协调器重启保留时，再提升为顶层 Session 并记录 `promotedFrom`。降级路径：Subagent 服务不可用时，用 `sessionController` 为 worker 建顶层会话（cwd=worktree）。

### D3 Run / Task / Dispatch（借鉴 Orca）

- **Run**：一次提案实现运行，持久命名空间 + 协调器收件箱 + 预算。
- **Task**：来自 `TASKS.json` 的工作项，含 `role / project / writes / depends_on / acceptance`。
- **Dispatch**：一次 Task 尝试，绑定一个原生 Session；失败重试是新 Dispatch。
- 状态：`planned → dispatched → running → done | failed | blocked`；Run 终结为 `succeeded | partial | blocked | aborted`。

### D4 依赖 DAG 与波次

`TASKS.json` 的 `depends_on` 形成 DAG；协调器按拓扑层派发波次，先启动完整独立波次再等待。同一 target 内 `writes` 相交的任务不得同波次（复用 `scopesIntersect`）；跨 target 可并行。默认 `maxParallel=3`，可在 Run 配置。链路深度建议 ≤4，超过时提示拆分。

### D5 门禁：两道人门 + 三道自动门

- **入口**：已有完整 OpenSpec 工件（proposal/design/tasks/specs 且 validate 通过）的提案 SHALL 先做**归一化**再直接进 G2，不重跑 G0/G1：从 `proposal.md` 派生 `REQ.md`、从 `design.md` + targets 派生 `PLAN.md`（两者标记 `derived: true`），从 `tasks.md` 解析生成 `TASKS.json`（补齐 role/project/writes/depends_on/acceptance，不改变范围）。只有一句话需求时才走 G0/G1。创建 Run 时可覆盖。
- **G0 需求评估**：`requirement-evaluator` 产出 `REQ.md`（目标/边界/禁止项/验收判据）。
- **G1 方案评估**：`solution-evaluator` 产出 `PLAN.md` + `TASKS.json`（目标矩阵/依赖 DAG/回滚）。
- **G2 方案硬门 + 人确认门**：G1 产出后自动机检（`solution-evaluator` + `reviewer` 检查 REQ/PLAN/TASKS 完整性、可实现性与一致性）；CRITICAL 阻断，其余提示。人只确认一次 `planHash`（方案工件规范化哈希：OpenSpec 工件 + 团队工件）与 targets 快照；方案改动即失效重开。多 target、数据迁移、公共 API/契约、权限、风险 high 强制人；单 target 低风险可配置自动放行（默认关闭）。

G2 批准即**启动信号**：协调器收到批准后直接启动 Run 并派发实现波次；团队 SHALL NOT 重新阅读需求、重新做一遍方案评估或重新生成 `PLAN.md/TASKS.json`——这些正是 G0/G1 的产物，重复评估既浪费 token 又制造第二份方案。方案若需修改，回到 G1 重新生成并让 `planHash` 失效。
- **G3 集成测试**：实现波次完成后 `integration-tester` 产出 `TEST.md`。
- **G4 独立审查**：`reviewer` 产出 `REVIEW.md`；与实现者身份不同。
- **G5 合并/归档**：一次人工批准覆盖「合并 + 归档」（默认）；批准后协调器合并 target 分支并跑归档编排，不再第二次确认。
- **G5 被拒回流**：方案方向被否 SHALL 退回 `ready` 重走 G1/G2；实现/测试/审查问题 SHALL 退回 `implementing` 生成修复 Task（引用 `REVIEW.md`/`TEST.md` 的具体发现），不重走方案；每次拒绝写 approval 记录与理由。

### D6 自主推进策略

G2 通过（批准 `planHash`）后，协调器直接启动 Run 并派发实现 → 测试 → 审查，不再逐步问人，也不重新评估需求/方案。默认限额（可配置）：并发 3、每 Task 最多 2 次尝试、Run 预算 2 小时 / 300k tokens / 20 个 Dispatch。约束：

- 每 Task 最多 2 次尝试；第二次失败升级给人（带失败证据与已尝试）。
- Run 级 token/时间/attempt 预算；超限暂停并上报，不静默继续。
- 明确终态：全部成功 / 部分失败并上报 / 阻塞待答；不得静默结束。
- 所有 dispatch/done/gate/decision 写 append-only events，可回放。
- 实施顺序：先完成 `multiproject-branch-workbench` 的 targets/worktree/生命周期/UI，再接团队 T2（T1 工件契约可并行准备）。

### D7 收件箱与协调循环（借鉴 Orca）

`check` 按 FIFO 取最早一批 delivery，逐条处理后再 `ack`；`question` 用 `reply`，`escalation` 交人，`worker_done` 校验 active Dispatch 后结算；连续空等待后枚举 worker 列表，只有**确证停止**才 stop/retry/release；联系中断不等于进程死亡。结算后三选一：复用同一 worker、保留、释放。

### D8 工件与证据

提案目录新增 `REQ.md`、`PLAN.md`、`TASKS.json`、`TEST.md`、`REVIEW.md`、`SUMMARY.md`。`REVIEW.md` 的 severity/file/line/status 直接接入现有 `review-gate` 与 `reviewEvidenceGate`；`TEST.md` 的命令与结果作为归档证据；`TASKS.json` 的 `writes` 复用 swarm 冲突检测。证据缺失或与 commit 不符时门禁失败，不以「回执成功」代替产物。

### D9 模板

四类模板：`requirement-full`（需求→方案→前后端→集成测试→审查）、`bug-fix`（方案→实现→测试→审查）、`research`（需求→调研报告）、`delivery`（方案→实现→测试→文档）。模板决定角色集合、门禁强度、默认并发与预算。

### D10 团队控制台

新增团队视图：角色看板（每个 Task 的状态与当前 worker）、DAG（依赖边/波次/关键路径）、收件箱（question/escalation，一键回答）、运行时间线（dispatch/done/gate 事件）、证据面板（六份工件的 Markdown 渲染）。沿用 `multiproject-branch-workbench` 的上下文栏/项目树/详情抽屉；不新建第二套导航。

### D11 数据与审计

`$DSH_HOME/workmate/team-runs.json` 保存 Run/Task/Dispatch 聚合（原子写，损坏 fail-closed）；运行事实写现有 `events.jsonl`（append-only）；不复制对话正文与宿主执行状态。占用/租约仍从提案与 worktree 派生，不新增第二份真相。

### D12 WorkDSH 借什么、不借什么

借：项目配置修订快照（每个 Run 固定引用一版 targets/writes/角色）、任务=原生会话、有界内容区与工作台契约、数据只存引用/投影。不借：其包/仓库依赖、桌面/企业/Office 范围、自有工作台 runtime。多仓分支/worktree/隔离仍由 WorkMate 自己实现。

## Risks / Trade-offs

- **宿主会话 API 能力**：派发原生 Session 并绑定 cwd 需要宿主公开契约；若不可用，退化为 Subagent（同一进程、无独立会话）。需在 T2 前做真机探针。
- **自主失控**：默认只到 G2 前要人；预算/重试/停止条件必须硬编码，不可由模型改。
- **token 成本**：7 角色 × 多仓 × 多轮，成本可能高于人工；模板默认只启用必要角色，Run 显示预估与已用。
- **角色交接质量**：依赖 `REQ/PLAN/TASKS` 的完整性；G2 硬门必须真的拦住缺边界/缺验收的输入。
- **重复派发/幽灵 worker**：严格沿用 Orca 的 active Dispatch 校验与 positive proof；不存在「看到进程就重发」。
- **证据造假**：`TEST.md`/`REVIEW.md` 必须引用真实命令/文件；沿用 `reviewEvidenceGate` 机检，行号越界只 warn 但文件必须存在。
- **跨仓依赖**：前后端并行时契约先行的任务必须显式进 DAG；否则集成测试会晚于实现。

## Open questions（推荐默认，待确认）

1. **协调器形态**：推荐「顶层 Session + 无状态编排服务」。Session 负责与用户交互和展示进度；Run/Task/Dispatch 状态与收件箱由 WorkMate 服务持久化，不依赖协调器会话活着。
2. **worker 形态**：推荐「Subagent 为默认，顶层 Session 为提升」。依据是宿主 `ctx.subagents` 的 `cwd`/续跑/消息/中断/容量契约；详见 `docs/AGENT-TEAM-DESIGN.md` 的 Q2。
3. **G2 强度**：推荐「按风险分级」——多 target、数据迁移、公共 API/契约、权限、风险 high 强制人；单 target 低风险默认人一键确认，可配置自动放行；G2 批准绑定 `planHash`，方案改动即失效重开。
4. **前后端拆分**：推荐「按 target 拆分 worker」——每个仓库/项目一个实现 worker，同一 target 内按写域串行；默认并发 3，沿用 `Config.maxConcurrent`。
5. **集成测试边界**：推荐「写域允许清单 + 升级」——允许测试/夹具/`scripts/verify/**`/运行期临时目录；禁止生产源码、迁移、运行时配置与借测试改行为；测试依赖变更单独 Task + 人批准；越界由结算机检拦截。
