## ADDED Requirements

### Requirement: 人工批准门

实现 SHALL 在目标状态出现在 `Config.approvalsRequired`（默认 `merging`、`archiving`）时
要求 `actor` 为 `human` 或 `system`；`actor` 为 `agent` 的调用 SHALL 被拒绝，
错误信息 SHALL 写明所需批准的状态、在哪里批准、以及如何配置；`force` SHALL NOT 绕过
本门；`Config.allowAgentApproval` 为 true 时 SHALL 允许 `agent` 通过。

#### Scenario: agent 不能自我批准合并

- **WHEN** agent 工具把提案从 implementing 推进到 merging（approvalsRequired 含 merging）
- **THEN** 调用被拒，错误信息含 `merging`、面板批准提示与配置名，且状态不变

#### Scenario: 人在面板上推进即批准

- **WHEN** REST/面板（actor=human）推进到 merging
- **THEN** 推进成功，并留下一条审批记录

#### Scenario: force 不影响审批门

- **WHEN** 归档编排带 `force: true` 但 actor 为 agent，且 `archiving` 在受控列表
- **THEN** 仍然被拒

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
