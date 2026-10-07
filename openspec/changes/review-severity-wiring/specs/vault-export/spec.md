## MODIFIED Requirements

### Requirement: 项目 wiki 导出到 vault

归档编排的审查归级 SHALL 对每条未标注严重度的发现逐条询问判断层，使用节点 `review-severity`
与选项 `CRIT/HIGH/MED/LOW`，SHALL 仅采信 `act` 档结论；判断层弃权或选项越界时 SHALL NOT
产出分级（不得编造严重度）；归级数量 SHALL 受上限约束。

#### Scenario: 逐条归级

- **WHEN** review.md 有 2 条未标注问题/建议且判断层均给出 act 档
- **THEN** 产出 2 条分级，节点名与选项符合约定

#### Scenario: 弃权不编造

- **WHEN** 判断层对某条发现弃权
- **THEN** 该条不出现在分级结果中
