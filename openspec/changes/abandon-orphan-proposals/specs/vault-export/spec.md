## ADDED Requirements

### Requirement: 孤儿提案的终止出口

实现 SHALL 提供「终止（abandon）」能力：不运行归档编排、不要求提案的项目根存在，
把提案置为终态并记录 `abandonedAt`、`abandonedReason`，同时 SHALL 追加一条
`transition` 事件（`actor: human`、`reason` 以 `abandoned:` 开头）。
终止 SHALL 要求非空原因；对已归档提案 SHALL 拒绝重复终止。

#### Scenario: 终止需要原因

- **WHEN** 调用终止但原因为空
- **THEN** 拒绝并提示必须给原因

#### Scenario: 终止后不再出现在待办

- **WHEN** 一个字段、无项目根的孤儿提案被终止
- **THEN** 其状态为 `archived`，带 `abandonedAt`/`abandonedReason`，事件流有对应记录

### Requirement: 面板动作不随详情失败消失

提案卡片上的归档动作 SHALL 仅在提案状态为 `archiving` 时渲染，SHALL NOT 依赖详情接口成功；
详情加载失败时 SHALL 在卡片上显示失败原因并提供「重新加载」。

#### Scenario: 详情失败仍有出路

- **WHEN** 提案的项目根已不存在导致详情加载失败且状态为 archiving
- **THEN** 卡片仍显示「完成归档 / 强制归档」，并显示失败原因
