## ADDED Requirements

### Requirement: 分级审查 tally

`review.md` 解析器 SHALL 识别带严重度标签的勾选项
（`- [ ] <CRIT|HIGH|MED|LOW>-<n> <描述>`）与审查者头
（`<!-- reviewer: <name>@<version> [shadow] -->`），并 SHALL 提供 tally 派生：
各严重度的总数与未解决数、总未解决数、按配置应阻断的条数、审查者版本与是否影子态；
既有 `CRITICAL 问题` 段与无标签行 SHALL 继续按 CRIT 处理。

#### Scenario: 标签与头被识别

- **WHEN** `review.md` 含 `<!-- reviewer: auditor@1.2 shadow -->` 与 `- [ ] HIGH-1 缺少回滚`
- **THEN** tally 的 `shadow` 为 true、`reviewer` 为 `auditor@1.2`，HIGH 计 1 条未解决

#### Scenario: 旧格式兼容

- **WHEN** `CRITICAL 问题` 段里是 `- [ ] CRIT-1 未修复`
- **THEN** 它仍计入 CRIT 的未解决数

### Requirement: 按严重度阻断与影子期

归档审查门 SHALL 阻断 `Config.reviewBlockingSeverities`（默认 `['CRIT']`）中仍有未解决项
的报告；当审查报告标记为影子态时，门禁 SHALL NOT 阻断，但 SHALL 在步骤摘要中标注
`shadow` 并保留 tally；步骤摘要 SHALL 含各严重度的计数。

#### Scenario: 影子报告不阻断

- **WHEN** review.md 有未解决 CRIT 但头里标了 `shadow`
- **THEN** 审查门通过，摘要含 `shadow` 与计数

#### Scenario: 配置后可拦 HIGH

- **WHEN** `reviewBlockingSeverities` 为 `['CRIT','HIGH']` 且存在未解决 HIGH
- **THEN** 审查门失败，摘要列出该条
