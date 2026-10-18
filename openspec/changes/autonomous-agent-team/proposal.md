# 自主 Agent 团队：需求与方案评估 → 前后端并行实现 → 集成测试

## Why

当前 WorkMate 只有「提案 + 门禁 + 任务级 worktree」，缺一支能真正把需求推进到可验收的团队：谁做需求评估、谁做技术方案、谁写前后端、谁做集成测试、谁独立审查，以及方案确认后**不再逐步问人**的自主推进机制。现实工作里这些角色由人反复切换提示词、手工汇总审查意见（见 `docs/USAGE-ANALYSIS-2026-10-18.md`：一周 29 条审查指令、30 个子代理、同一提案连审三次）。

参考已有的四个系统：
- **DeepSeekBot / DS Bot**：长期角色 Bot、群聊轮流发言、任务委派、context steward、记忆、收件箱；借「角色身份 + 长期会话 + 问与答」语义。
- **`@yangdcm/dsh-expert-team`**：12 角色、9 阶段门控、依赖 DAG 并行、`SPEC/PLAN/TASKS/REVIEW/TEST/SUMMARY` 工件、硬门 + 确认门；借角色表、工件命名与门禁语义。
- **Orca orchestration**：Run / Task / Dispatch、task spec、DAG 波次、`worker_done/escalation/question`、`check/ack`、positive proof、`release/retain`；借编排原语与协调循环。
- **WorkDSH**：项目不可变配置修订、任务=原生会话、workbench 有界内容区、数据只存引用/投影；借模型与 UI 契约，不依赖其包。

## What Changes

- **角色团队**：协调器 + 需求评估 + 技术方案评估 + 前端开发 + 后端开发 + 集成测试 + 独立审查，共 7 个角色；每个角色有明确的产出、写域边界和权限预设。
- **执行单元**：每个 worker 是一个原生 DSH Session，cwd 绑定到对应 `ProposalTarget` 的 worktree；WorkMate 不自建 agent loop、聊天或 IM。
- **编排模型**：`Run → Task → Dispatch`，任务来自 `TASKS.json` 的依赖 DAG；按波次并行派发，`check/reply/ack` 收件箱，`worker_done` 结算，`escalation/question` 回到人。
- **门禁**：G2 方案硬门 + 人确认门；通过后自主执行实现波次 → 集成测试 → 独立审查；`merging/archiving` 仍由人批准（沿用现有 approval-gate）。
- **提案即输入**：G2 确认 `planHash` 后协调器直接启动团队 run；团队 SHALL NOT 重读/重评需求；`PLAN.md + TASKS.json` 即执行依据。状态由证据派生并自动推进（见 `multiproject-branch-workbench` D12），不再逐态点击。
- **工件与证据**：提案目录新增 `REQ.md`、`PLAN.md`、`TASKS.json`、`TEST.md`、`TEAM-REVIEW.md`、`SUMMARY.md`；审查/测试证据接入现有 `review-gate` 与归档门。
- **面板**：新增「团队」视图——角色看板、DAG、收件箱、运行时间线、证据面板。
- **模板**：需求全流程 / bug 修复 / 调研 / 交付四类模板，决定启用哪些角色与门禁强度。
- **入口与默认档**：已有完整 OpenSpec 工件的提案直接从 G2 开始，不重复评估；角色权限按职责分级（评估/审查只读，开发/测试/协调器 workspace）；模型先统一默认、保留角色覆盖；默认并发 3、每 Task 2 次重试、Run 预算 2h/300k tokens/20 Dispatch；G5 被拒按方案/实现原因分流。

## Capabilities

### New Capabilities

- `agent-team-roles`: 角色名册、职责、产出、写域边界与权限预设；角色可裁剪。
- `team-orchestration`: Run/Task/Dispatch、依赖 DAG、波次派发、收件箱、门禁与自主推进策略、失败与重试。
- `team-evidence`: 每个角色的工件、独立审查与测试证据，以及到现有归档门的映射。
- `team-console`: 团队看板、DAG、收件箱、运行时间线与证据展示。

### Modified Capabilities

（无。团队编排不改现有八态语义，只在其前面增加「团队运行」这一层；合并/归档仍走现有门禁。）

## Impact

- Host：新增 `src/features/team/**`（roster、run、task、dispatch、coordinator、inbox、gates、artifacts），扩展 `src/features/proposal/**`（teamRun 引用、工件路径）与 `src/index.ts`（工具注册）。
- 依赖：`multiproject-branch-workbench` 的 `ProposalTarget` 与 worktree（T2 起）；swarm 的 `scopesIntersect` 与任务 worktree（复用）。
- 数据：`$DSH_HOME/workmate/team-runs.json`（Run/Task/Dispatch 聚合，原子写）；事件写现有 `events.jsonl`；不改 `proposals.json` 语义。
- Client：`src/client/App.tsx` 新增团队视图；沿用 UI 重构后的上下文栏/项目树/抽屉。
- 文档：`docs/AGENT-TEAM-DESIGN.md`、`docs/WORKDSH-TEAM-REVIEW.md`。
- 测试：新增 team 单测（DAG、调度、重试、门禁、inbox）；真机验收需原生 Session 与 worktree。

## 来源 / Provenance

- source: `spec`
- relatesTo: `multiproject-branch-workbench`
- 设计依据：`docs/AGENT-TEAM-DESIGN.md`、`docs/WORKDSH-TEAM-REVIEW.md`
- 不做：自建 LLM runtime、自建群聊/IM、Bot 市场、替代宿主 Conversation。
