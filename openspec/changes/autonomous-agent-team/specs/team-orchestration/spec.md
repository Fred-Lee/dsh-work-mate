## ADDED Requirements

### Requirement: Run / Task / Dispatch 模型

插件 SHALL 以 `Run → Task → Dispatch` 组织团队执行：Run 是一次提案实现运行并持有协调器
收件箱与预算；Task 来自 `TASKS.json`，含 `role/project/writes/depends_on/acceptance`；
Dispatch 是一次 Task 尝试并绑定一个原生 DSH Session（或 Subagent）。状态 SHALL 明确为
`planned → dispatched → running → done | failed | blocked`，Run 终结为
`succeeded | partial | blocked | aborted`。

Dispatch SHALL 记录 sessionId、开始/结束时间、outcome 与产物路径；插件 SHALL NOT 复制
对话正文或宿主执行状态。

#### Scenario: 一次 Task 的完整生命周期

- **WHEN** 协调器派发一个 backend-dev Task
- **THEN** Run 中该 Task 从 planned 变为 dispatched/running，绑定一个 sessionId；worker 回执后结算为 done 或 failed

#### Scenario: 重复派发被拒绝

- **WHEN** 同一 Task 已有 active Dispatch 时再次 dispatch
- **THEN** 返回已存在的 Dispatch，不创建第二个 worker

### Requirement: 依赖 DAG 与波次

`TASKS.json` 的 `depends_on` SHALL 形成无环 DAG；协调器 SHALL 按拓扑层派发波次，先启动
完整独立波次再等待。同一 target 内 `writes` 相交的任务 SHALL NOT 同波次；跨 target 的
任务 MAY 并行。默认并发 SHALL 沿用 `Config.maxConcurrent`，可在 Run 配置中降低。

#### Scenario: 前后端并行

- **WHEN** 前端与后端 Task 互不依赖且写域不重叠
- **THEN** 它们在同一波次并行派发

#### Scenario: 集成测试等待实现

- **WHEN** integration-tester Task 依赖前后端两个 Task
- **THEN** 它只在前两者都 done 后进入下一波次

### Requirement: 门禁与自主推进

流程 SHALL 包含 G0 需求评估、G1 方案评估、G2 方案硬门 + 人确认门、G3 集成测试、
G4 独立审查、G5 合并/归档。G2 前 SHALL 要求 `REQ.md` 有边界/禁止项、`PLAN.md` 有目标
矩阵/回滚、`TASKS.json` 每项有 owner/writes/acceptance；缺失即阻断。

G2 前 SHALL 由 `solution-evaluator` 与 `reviewer` 自动机检 REQ/PLAN/TASKS 的完整性、
可实现性与一致性；CRITICAL 问题 SHALL 阻断并停在 reviewing，其余问题 SHALL 作为提示随
`planHash` 展示，不增加人工步骤。

G2 通过后，协调器 SHALL 自主派发实现 → 测试 → 审查波次，SHALL NOT 逐步请求人确认。
G5 SHALL 为一次人工批准，覆盖「合并 + 归档」；批准后协调器合并各 target 分支并跑归档
编排，SHALL NOT 再要求第二次人工确认。

#### Scenario: 机检 CRITICAL 阻断

- **WHEN** G2 前的自动机检发现 CRITICAL 问题
- **THEN** 不生成可确认的 `planHash`，提案停在 reviewing 并列出问题

#### Scenario: 方案缺边界不放行

- **WHEN** `REQ.md` 没有「边界与禁止项」或 `TASKS.json` 缺 acceptance
- **THEN** G2 失败，Run 停在方案门前并列出缺失项

#### Scenario: 确认后自主推进

- **WHEN** 人在 G2 确认方案
- **THEN** 协调器自动派发实现波次，直到 G3/G4 完成或出现阻塞/升级，不再逐 Task 询问

### Requirement: 收件箱与升级

协调器 SHALL 以 FIFO 方式读取 `worker_done` / `escalation` / `question`；每条消息处理后
才 ack。`question` SHALL 通过 `reply` 回答；`escalation` SHALL 交给人并暂停相关 Task；
`worker_done` SHALL 校验 active Dispatch 后结算。结算后 SHALL 三选一：复用同一 worker、
保留、释放。

#### Scenario: 阻塞提问

- **WHEN** worker 发出 `question` 且协调器无法自动回答
- **THEN** 该问题进入收件箱并标记需要人回答，相关 Task 保持 blocked，不继续派发后续波次

#### Scenario: 空等待不是失败

- **WHEN** 一次 check 超时且没有新消息
- **THEN** 记录 checkpoint，继续等待或枚举 worker 列表，不重试、不停止、不重复派发

### Requirement: 失败、重试与终态

每个 Task SHALL 最多重试 2 次；第二次失败 SHALL 升级给人并附失败证据与已尝试。只有
确证 worker 停止（明确退出/回执）才 SHALL stop/retry/release；联系中断 SHALL 视为
`unverifiable`，不得据此重发。

Run SHALL 以三种终态结束：全部成功、部分失败并上报、阻塞待答；SHALL NOT 静默结束。

#### Scenario: 二次失败升级

- **WHEN** 同一 Task 连续两次 failed
- **THEN** Run 暂停该分支并向人上报，不再自动发起第三次

#### Scenario: 联系中断不误判

- **WHEN** 终端仍存活但暂时无输出
- **THEN** 状态为 unverifiable，继续等待或检查，不 stop/retry/release

### Requirement: 预算与停止

Run SHALL 支持 token/时间/attempt 预算；超限 SHALL 暂停派发并上报，不得继续消耗。
预算与停止条件 SHALL 由配置固定，SHALL NOT 由模型或角色自行修改。

#### Scenario: 预算耗尽

- **WHEN** Run 达到 token 或时间上限
- **THEN** 停止派发新 Task，保留已有 worker 会话，输出当前终态与未完成项


### Requirement: G2 批准即启动，不重复评估

G2 通过 SHALL 是 Run 的启动信号：协调器收到 `planHash` 的批准后 SHALL 直接创建 Run、派发实现
波次，SHALL NOT 重新阅读需求、重新做方案评估或重写 `PLAN.md/TASKS.json`。G0/G1 的产物
（`REQ.md`、`PLAN.md`、`TASKS.json`）SHALL 是执行的唯一方案输入；若需修改方案，SHALL 回到
G1 重新生成并使 `planHash` 失效，重新走 G2。

团队事件（run 启动、Task 完成、审查/测试通过）SHALL 作为提案状态派生的证据输入，
SHALL NOT 由人再逐态点击推进。

#### Scenario: 方案确认后立即执行

- **WHEN** 人 G2 确认 `planHash`
- **THEN** 协调器在同一操作链内创建 Run 并派发第一波实现 Task，不再要求「推进到 implementing」

#### Scenario: 不重复评估

- **WHEN** Run 已启动且 `PLAN.md/TASKS.json` 已存在
- **THEN** 不调用 requirement-evaluator / solution-evaluator 重新产出方案；若发现方案缺陷，升级给人或回 G1，而不是静默重写

#### Scenario: 方案变更需重批

- **WHEN** Run 启动后 `PLAN.md` 或 `TASKS.json` 被修改
- **THEN** `planHash` 失效，Run 暂停，提案退回待确认，需重新 G2


### Requirement: 团队入口按工件判断

Run 创建时 SHALL 检查提案是否已有完整 OpenSpec 工件（`proposal.md`、`design.md`、
`tasks.md`、`specs/**` 且 `openspec validate` 通过）：已完整时 SHALL 先执行**归一化**，
再直接从 G2 开始，SHALL NOT 运行 G0 需求评估或 G1 方案评估；只有不完整时才进入 G0/G1。
创建 Run 的调用方 SHALL 可显式覆盖该判断并记录理由。

归一化 SHALL 只做映射、不改变方案范围：从 `proposal.md` 派生 `REQ.md`、从 `design.md` 与
targets 派生 `PLAN.md`（两者 SHALL 标记 `derived: true`），从 `tasks.md` 解析生成
`TASKS.json` 并补齐 `role/project/writes/depends_on/acceptance`。G2 SHALL 要求
`TASKS.json` 存在且 DAG 无环；`REQ.md` / `PLAN.md` 可以是派生视图。

#### Scenario: 已有提案直接进 G2

- **WHEN** 对一个工件完整的提案创建 Run
- **THEN** Run 从 G2 开始，不调用 requirement-evaluator / solution-evaluator

#### Scenario: 一句话需求走全流程

- **WHEN** 对没有 OpenSpec 工件的需求创建 Run
- **THEN** Run 从 G0 开始，依次产出 REQ/PLAN/TASKS

### Requirement: G5 拒绝回流

G5 被拒时，插件 SHALL 按原因分流：方案方向被否 SHALL 退回 `ready` 并重走 G1/G2；
实现、测试或审查问题 SHALL 退回 `implementing` 并生成引用具体发现的修复 Task；
SHALL NOT 把方案问题当作实现问题继续打补丁，也 SHALL NOT 为测试失败重走方案。
每次拒绝 SHALL 写 approval 记录（actor、理由、被拒门、时间）。

#### Scenario: 测试失败被拒

- **WHEN** G5 因 `TEST.md` 的失败场景被拒绝
- **THEN** 提案回到 implementing，生成引用该失败的修复 Task，方案哈希不变

#### Scenario: 方案方向被拒

- **WHEN** G5 因方案方向问题被拒绝
- **THEN** 提案回到 ready，`planHash` 失效，需重走 G1/G2

### Requirement: 默认限额

Run SHALL 默认使用：并发 3、每 Task 最多 2 次重试、Run 预算 2 小时 / 300k tokens /
20 个 Dispatch；全部 SHALL 可配置。达到任一限额 SHALL 暂停派发新 Task 并上报，
SHALL NOT 继续消耗或静默结束。

#### Scenario: 达到 token 预算

- **WHEN** Run 累计 token 达到 300k
- **THEN** 停止派发新 Task，保留现有 worker，输出当前终态与未完成项
