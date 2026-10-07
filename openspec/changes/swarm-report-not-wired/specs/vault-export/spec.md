## MODIFIED Requirements

### Requirement: 项目 wiki 导出到 vault

归档编排的 `swarm` 步骤 SHALL 如实报告本提案的任务级并行使用情况：
无 swarm 任务时 SHALL 说明"未使用任务级并行"并指出派发执行由调用方负责（设计 D1）；
全部已合并时 SHALL 报告数量与分支；存在未合并任务（force 放行）时 SHALL 列出任务、状态与分支。
该步骤 SHALL NOT 用"未接线"之类措辞掩盖事实，且 SHALL NOT 因此步骤自行派发任务执行。

#### Scenario: 未使用并行时说清楚

- **WHEN** 提案没有 swarm 任务
- **THEN** 该步骤状态为 ok，摘要说明未使用任务级并行与 D1

#### Scenario: 已合并则列出分支

- **WHEN** 提案的 swarm 任务全部 merged
- **THEN** 摘要给出数量与各任务分支
