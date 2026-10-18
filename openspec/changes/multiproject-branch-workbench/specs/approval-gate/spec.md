## MODIFIED Requirements

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
