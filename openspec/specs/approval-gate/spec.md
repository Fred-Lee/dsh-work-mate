# approval-gate Specification

## Purpose
TBD - created by archiving change add-approval-records. Update Purpose after archive.
## Requirements
### Requirement: 人工批准门

实现 SHALL 在目标状态出现在 `Config.approvalsRequired` 时要求 `actor` 为 `human` 或
`system`；`actor` 为 `agent` 的调用 SHALL 被拒绝，错误信息 SHALL 写明所需批准的状态、
在哪里批准、以及如何配置；`force` SHALL NOT 绕过本门；`Config.allowAgentApproval` 为
true 时 SHALL 允许 `agent` 通过。

默认 `Config.approvalsRequired` SHALL 为 `['merging']`：`merging` 的一次人工批准 SHALL
覆盖「合并 + 归档」，`archiving` SHALL NOT 再单独要求人工批准。配置为
`['merging','archiving']` 时 SHALL 恢复原来的两道人工批准。无论一道还是两道，批准记录
SHALL 继续写入 `approvals[]` 与 `events`，`pendingApproval` SHALL 指向当前等待的人工门。

#### Scenario: agent 不能自我批准合并

- **WHEN** agent 工具把提案从 implementing 推进到 merging（`approvalsRequired` 含 merging）
- **THEN** 调用被拒，错误信息含 `merging`、面板批准提示与配置名，且状态不变

#### Scenario: 一次批准覆盖合并与归档

- **WHEN** 人在面板批准 merging，且 `approvalsRequired=['merging']`
- **THEN** 合并与随后的归档编排不再要求第二次人工批准，只留下一条 merging 批准记录

#### Scenario: 恢复两道门

- **WHEN** `approvalsRequired=['merging','archiving']`
- **THEN** archiving 仍要求第二次人工批准，行为与升级前一致

#### Scenario: force 不影响审批门

- **WHEN** 归档编排带 `force: true` 但 actor 为 agent，且目标状态在受控列表
- **THEN** 仍然被拒（`force` 只跳过审查门）

### Requirement: 审批记录与审计留痕

每次跨过受控状态的推进 SHALL 追加一条审批记录
`{gate, actor, decision, rationale?, at, commit?}`（`commit` 为取到的实现分支 HEAD，
取不到时省略）并 SHALL 向事件流写一条 `kind: "approval"` 事件；提案详情 SHALL 暴露
`approvals[]` 与 `pendingApproval`（当前状态是否等待人工批准）。

#### Scenario: 审批有记录也有事件

- **WHEN** 人以 rationale 批准 merging
- **THEN** 提案 `approvals` 多一条 `decision: approve` 且带该 rationale，
  `events.jsonl` 多一条 `kind: approval`

#### Scenario: 等待批准可被界面识别

- **WHEN** 提案处于 implementing 且 merging 在受控列表
- **THEN** 详情返回的 `pendingApproval` 指出目标状态 merging 与原因

### Requirement: 风险未判定不得通过高风险门

拒绝代理人推进时的错误信息 SHALL 说明两点：判断层停留在 `review` 档时实现不会写入风险
（设计 D2：只有 `act` 档结论成为事实），以及**该守卫只约束 agent，人类可在面板直接推进**。
实现 SHALL NOT 因该守卫把人类操作者也挡在门外。

#### Scenario: review 档时说明出路

- **WHEN** 代理人推进被该守卫拒绝
- **THEN** 错误信息同时包含 "review" 档说明与"人类可直接推进"的提示

#### Scenario: 人类不受限

- **WHEN** 人类操作者推进同一状态
- **THEN** 该守卫不介入（是否放行由配置的批准门决定）

