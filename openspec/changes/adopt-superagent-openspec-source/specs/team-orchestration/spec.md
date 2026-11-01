# team-orchestration Delta

## MODIFIED Requirements

### Requirement: Run / Task / Dispatch 模型

插件 SHALL 以 `Run → Task → Dispatch` 组织团队执行：Run 是一次提案实现运行并持有协调器
收件箱与预算；Task 来自 `TASKS.json`，含 `role/project/writes/depends_on/acceptance`；
Dispatch 是一次 Task 尝试并绑定一个原生 DSH Session（或 Subagent）。状态 SHALL 明确为
`planned → dispatched → running → done | failed | blocked`，Run 终结为
`succeeded | partial | blocked | aborted`。

Dispatch SHALL 记录 sessionId、开始/结束时间、outcome 与产物路径；插件 SHALL NOT 复制
对话正文或宿主执行状态。

该模型 SHALL 只在 `taskExecutor = 'team'`（回退执行器）时生效。默认 `taskExecutor` SHALL
为 `'superagent'`，此时插件 SHALL NOT 创建 Run、SHALL NOT 派发 Dispatch；
执行事实 SHALL 由 Super-agent 的 Ticket / Assignment 提供。

#### Scenario: 一次 Task 的完整生命周期

- **WHEN** 回退执行器启用时协调器派发一个 backend-dev Task
- **THEN** Run 中该 Task 从 planned 变为 dispatched/running，绑定一个 sessionId；worker 回执后结算为 done 或 failed

#### Scenario: 重复派发被拒绝

- **WHEN** 同一 Task 已有 active Dispatch 时再次 dispatch
- **THEN** 返回已存在的 Dispatch，不创建第二个 worker

#### Scenario: 默认不创建 Run

- **WHEN** 提案进入 implementing 且 `taskExecutor` 为默认值 `superagent`
- **THEN** 插件不创建 Run，也不派发任何 Dispatch

### Requirement: 依赖 DAG 与波次

`TASKS.json` 的 `depends_on` SHALL 形成无环 DAG；协调器 SHALL 按拓扑层派发波次，先启动
完整独立波次再等待。同一 target 内 `writes` 相交的任务 SHALL NOT 同波次；跨 target 的
任务 MAY 并行。默认并发 SHALL 沿用 `Config.maxConcurrent`，可在 Run 配置中降低。

DAG 与 `writes` 装批 SHALL 同时作为**规划能力**对外提供：插件 SHALL 能用同一份 DAG
计算任务顺序与写域冲突，供任务面板在把一个提案拆成多条待办时使用，并写入待办的
`dependsOn`。该规划能力 SHALL NOT 被理解为 Super-agent 侧存在跨 Ticket 依赖。

#### Scenario: 前后端并行

- **WHEN** 前端与后端 Task 互不依赖且写域不重叠
- **THEN** 它们在同一波次并行派发

#### Scenario: 集成测试等待实现

- **WHEN** integration-tester Task 依赖前后端两个 Task
- **THEN** 它只在前两者都 done 后进入下一波次

#### Scenario: 规划能力独立于执行器

- **WHEN** `taskExecutor` 为 `superagent` 且提案存在 `TASKS.json`
- **THEN** 插件仍能返回波次与写域冲突结果，但不自行派发

### Requirement: 门禁与自主推进

流程 SHALL 包含 G0 需求评估、G1 方案评估、G2 方案硬门 + 人确认门、G3 集成测试、
G4 独立审查、G5 合并/归档。G2 前 SHALL 要求 `REQ.md` 有边界/禁止项、`PLAN.md` 有目标
矩阵/回滚、`TASKS.json` 每项有 owner/writes/acceptance；缺失即阻断。

G2 前 SHALL 由 `solution-evaluator` 与 `reviewer` 自动机检 REQ/PLAN/TASKS 的完整性、
可实现性与一致性；CRITICAL 问题 SHALL 阻断并停在 reviewing，其余问题 SHALL 作为提示随
`planHash` 展示，不增加人工步骤。

G2 通过后，**实现阶段的推进 SHALL 交给执行器**：`taskExecutor = 'superagent'` 时插件
SHALL 把实现工作写成待办并交给 Source，SHALL NOT 自行派发波次；`taskExecutor = 'team'`
时协调器 SHALL 自主派发实现 → 测试 → 审查波次。两种执行器下 SHALL NOT 逐步请求人确认。

G5 SHALL 为一次人工批准，覆盖「合并 + 归档」；批准后由执行器合并各 target 分支并跑归档
编排，SHALL NOT 再要求第二次人工确认。

#### Scenario: 机检 CRITICAL 阻断

- **WHEN** G2 前的自动机检发现 CRITICAL 问题
- **THEN** 不生成可确认的 `planHash`，提案停在 reviewing 并列出问题

#### Scenario: 方案缺边界不放行

- **WHEN** `REQ.md` 没有「边界与禁止项」或 `TASKS.json` 缺 acceptance
- **THEN** G2 失败，Run 停在方案门前并列出缺失项

#### Scenario: 确认后交给执行器

- **WHEN** 人在 G2 确认方案且 `taskExecutor` 为 `superagent`
- **THEN** 插件把实现工作写成待办并停止自行派发，执行进度由 Ticket 投影决定

#### Scenario: 回退执行器仍自主推进

- **WHEN** `taskExecutor` 为 `team` 且人在 G2 确认方案
- **THEN** 协调器自动派发实现波次，直到 G3/G4 完成或出现阻塞/升级，不再逐 Task 询问

### Requirement: G2 批准即启动，不重复评估

G2 通过 SHALL 是执行阶段的启动信号：`taskExecutor = 'team'` 时，协调器收到 `planHash` 的
批准后 SHALL 直接创建 Run、派发实现波次；`taskExecutor = 'superagent'` 时，插件 SHALL
把实现工作写成待办（`assigned=true`）并交给 Source，SHALL NOT 创建 Run 或派发 worker。
两种执行器下 SHALL NOT 重新阅读需求、重新做方案评估或重写 `PLAN.md/TASKS.json`。
G0/G1 的产物（`REQ.md`、`PLAN.md`、`TASKS.json`）SHALL 是执行的唯一方案输入；
若需修改方案，SHALL 回到 G1 重新生成并使 `planHash` 失效，重新走 G2。

团队事件（run 启动、Task 完成、审查/测试通过）或 Super-agent 的 Ticket 报告
SHALL 作为提案状态派生的证据输入，SHALL NOT 由人再逐态点击推进。

#### Scenario: 方案确认后立即执行

- **WHEN** 人 G2 确认 `planHash` 且 `taskExecutor` 为 `team`
- **THEN** 协调器创建 Run 并派发第一波实现 Task，不再要求「推进到 implementing」

#### Scenario: 方案确认后写成待办

- **WHEN** 人 G2 确认 `planHash` 且 `taskExecutor` 为 `superagent`
- **THEN** 插件为该提案的实现工作写入待办并置 `assigned=true`，不创建 Run

#### Scenario: 不重复评估

- **WHEN** 执行阶段已启动且 `PLAN.md/TASKS.json` 已存在
- **THEN** 不调用 requirement-evaluator / solution-evaluator 重新产出方案；若发现方案缺陷，升级给人或回 G1，而不是静默重写

#### Scenario: 方案变更需重批

- **WHEN** 执行阶段启动后 `PLAN.md` 或 `TASKS.json` 被修改
- **THEN** `planHash` 失效，执行暂停，提案退回待确认，需重新 G2
