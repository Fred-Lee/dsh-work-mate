## MODIFIED Requirements

### Requirement: 项目 wiki 导出到 vault

导出 SHALL 在无法从判断层得到任何 `act` 档结论时，于返回中说明最可能的原因（至少包含
当前 `decisionModel` 与"provider 模型列表为空则路由失败"这一判据）；
聚合 `decision` 事件 SHALL 记录 provider 与模型列表规模等路由诊断字段，使"判断层未生效"
可从事件流复查，SHALL NOT 仅以静默成功返回。

#### Scenario: 问了但零命中要说原因

- **WHEN** `classify.llmAsked > 0` 且 `classify.llmMatched === 0`
- **THEN** 返回内容包含可操作的原因说明，且事件流里该次导出的事件含 `listedModels` 字段
