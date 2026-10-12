# swarm-verification Specification

## Purpose
TBD - created by archiving change wire-swarm-independent-review. Update Purpose after archive.
## Requirements
### Requirement: 核验记录挂在任务上且可追溯

每个 swarm 任务的核验记录 SHALL 包含 `reviewer`、`verdict`（`verified` | `issues`）、
派生出的 `independence`、说明 `note` 与时间 `at`，可选 `evidence`。
核验记录 SHALL 持久化在 `proposal.swarmTasks[].verification`；重新规划任务时
SHALL 保留既有核验记录。

#### Scenario: 记录可读回

- **WHEN** 对已合并任务执行 `workmate_swarm_task action=verify`（reviewer=auditor, verdict=verified, evidence=…）
- **THEN** 该任务记录出现 `verification`，含 reviewer / verdict / independence / at / evidence

#### Scenario: 重规划不抹掉核验

- **WHEN** 任务已核验后重新 `workmate_swarm_plan`
- **THEN** 该任务仍带原核验记录

### Requirement: 未合并的任务不得核验

核验 SHALL 只对 `status === "merged"` 的任务生效；其他状态 SHALL 被拒绝，
错误信息 SHALL 说明"先 merge 再 verify"。`reviewer` 为空白的调用 SHALL 被拒绝。

#### Scenario: 拒绝未合并

- **WHEN** 对 `running` 状态的任务执行 verify
- **THEN** 调用被拒且不写入任何记录

#### Scenario: 拒绝不署名

- **WHEN** verify 的 reviewer 为空白
- **THEN** 调用被拒绝，错误信息说明独立核验必须署名

### Requirement: 独立性由 git 事实派生，不由调用方声明

`verify` SHALL 读取仓库中任务的提交作者集合，并用与归档审查门相同的判定函数派生
`independent` / `same-as-author` / `undetermined`；SHALL NOT 接受调用方自报的独立性。
取不到仓库事实时判定 SHALL 为 `undetermined`，且工具返回体 SHALL 在
`same-as-author` 时带 warning。

#### Scenario: 自评被判出

- **WHEN** reviewer 与任务提交的作者同名
- **THEN** 记录 `independence: "same-as-author"`，工具返回带 warning

#### Scenario: 无仓库事实

- **WHEN** 未配置可用的仓库根
- **THEN** 记录 `independence: "undetermined"`，不假装核验通过

### Requirement: 可选归档门要求逐任务独立核验

`Config.swarmReviewRequired`（默认 `false`）为 true 时，归档编排 SHALL 要求每个
`merged` 任务都有核验记录，且其 `independence` SHALL NOT 为 `same-as-author`；
`undetermined` SHALL 视同未核验（阻断）。不满足时 swarm 步骤 SHALL `failed`
并逐个点名任务与原因，摘要 SHALL 给出"先 verify 或关闭该配置"的出路。
该配置为 false 时归档 SHALL NOT 因此新增失败。

#### Scenario: 未核验拦归档

- **WHEN** `swarmReviewRequired: true`，提案有一个已合并但无核验记录的任务
- **THEN** 归档失败，swarm 步骤点名该任务为"未核验"

#### Scenario: 自评不算核验

- **WHEN** `swarmReviewRequired: true`，某任务的核验记录 `independence` 为 `same-as-author`
- **THEN** 归档失败，摘要说明核验者与提交作者同一身份

#### Scenario: 默认关闭时不改变行为

- **WHEN** `swarmReviewRequired` 未开启，提案有已合并任务但没有核验记录
- **THEN** 归档不因核验缺失而失败

