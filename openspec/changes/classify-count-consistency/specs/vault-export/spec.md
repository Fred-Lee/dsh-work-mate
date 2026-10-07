## MODIFIED Requirements

### Requirement: 项目 wiki 导出到 vault

`classify` 诊断中的 `pathMatched` SHALL 使用与迭代笔记渲染**完全相同**的路径判据
（模块 slug 包含或 slug token 重合），SHALL NOT 只统计 slug 包含——两处口径不一致会虚高
向量/判断层的贡献，使"补了几条边"无法核对。

#### Scenario: 口径一致

- **WHEN** 某迭代的 `touches` 里是代码路径（`.../HomeworkManagementService.java`）并由 token 命中模块
- **THEN** 该迭代计入 `pathMatched`，且不出现在 `vectorMatched` / `llmMatched` 里
