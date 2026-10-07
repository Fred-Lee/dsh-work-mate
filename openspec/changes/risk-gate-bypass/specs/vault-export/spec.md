## ADDED Requirements

### Requirement: 风险未判定不得通过高风险门

当判断层开启时，若目标状态属于 `Config.highRiskExtraGates` 而提案的 `risk` 尚未判定，
**代理人**发起的推进 SHALL 被拒绝，并 SHALL 给出"先判定风险"的可操作提示与一条
`gate-failed` 事件（gate 名 `risk-unassessed`）。人类操作者与判断层关闭的情形 SHALL 不受影响。

#### Scenario: 未判风险被挡

- **WHEN** 判断层开启、`highRiskExtraGates: ['implementing']`、提案无 `risk`，agent 推进到 implementing
- **THEN** 抛出可读错误（含"必须先判定风险"）并记录 `gate-failed` 事件

#### Scenario: 判断层关闭时不变

- **WHEN** 判断层关闭
- **THEN** 该守卫不生效（行为与之前一致）
