# decision-nodes Specification

## Purpose
TBD - created by archiving change add-decision-nodes. Update Purpose after archive.
## Requirements
### Requirement: 风险分级与人工批准门叠加

实现 SHALL 支持把提案的风险等级（`low` | `medium` | `high`）记为领域事实，并 SHALL 在
判定动作达到 `act` 时才写入；当风险为 `high` 时，进入 `Config.highRiskExtraGates`
（默认 `['implementing']`）列出的状态 SHALL 与 `approvalsRequired` **并集**要求人工批准，
SHALL NOT 因此放松任何既有门。

#### Scenario: 高风险追加人工批准

- **WHEN** 提案风险为 high 且 agent 尝试推进到 implementing
- **THEN** 推进被拒并提示需要人工批准（即便 implementing 不在 approvalsRequired 里）

#### Scenario: 中低风险不受影响

- **WHEN** 提案风险为 low
- **THEN** 人工批准要求与未引入风险门时一致

### Requirement: 审查发现分级

当判断层可用时，归档审查门 SHALL 对 `review.md` 中未打严重度标签的发现逐条询问严重度，
条数上限由 `Config.reviewGradeMax`（默认 5）约束；仅当判断动作为 `act` 时 SHALL 把该结论
合成为分级发现并纳入 tally，其余情况 SHALL 忽略；判断层不可用时行为 SHALL 与现在一致。

#### Scenario: 判为 CRIT 的疑问会挡住归档

- **WHEN** review.md 的疑问项被判为 CRIT 且存在未解决阻断
- **THEN** 审查门失败并在摘要里给出该发现

#### Scenario: 弃权即不采信

- **WHEN** 判断动作为 abstain/review
- **THEN** 该发现不进入 tally，归档结论与本变更前一致

### Requirement: 外部文本判定

创建提案时若存在 `notes` 或 provenance，判断层 SHALL 询问该文本是否夹带指向 agent 的
指令；当动作为 `act` 且结论为 risky 时，实现 SHALL 自动置 `provenance.untrusted = true`
并记录 `decision` 事件，SHALL NOT 因结论为 benign 而移除调用方已声明的 untrusted。

#### Scenario: 自动置位

- **WHEN** 调用方未声明 untrusted 而判断为 risky（act）
- **THEN** 提案的 provenance.untrusted 为 true

#### Scenario: 不因判断放宽

- **WHEN** 调用方声明了 untrusted 而判断为 benign
- **THEN** provenance.untrusted 仍为 true

### Requirement: 任务完成判定

归档时实现 SHALL 对已勾选任务（上限 3 条）询问"diff 是否满足该任务"，并把结论写入
manifest 的 `taskJudgements`；当 `Config.taskJudgementGate` 为 true 且存在被判为未满足
（`act`）的任务时，归档 SHALL 失败并列出它们，`force` SHALL 可跳过。

#### Scenario: 默认只记录

- **WHEN** taskJudgementGate 为 false 且某任务被判未满足
- **THEN** 归档继续，manifest 里能看到该判定

#### Scenario: 开启后阻断

- **WHEN** taskJudgementGate 为 true 且某任务被判未满足（act）
- **THEN** 归档失败且摘要含该任务

