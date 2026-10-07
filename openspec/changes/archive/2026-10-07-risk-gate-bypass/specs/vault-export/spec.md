## ADDED Requirements

### Requirement: 风险未判定不得通过高风险门

判断层开启时，代理人在风险尚未判定前 SHALL NOT 推进到受 `Config.highRiskExtraGates` 保护的状态；
被拒绝时 SHALL 给出可操作提示（先调用 `workmate_assess_risk`），并 SHALL 记录一条 `gate-failed`
事件（gate 名为 `risk-unassessed`）。人类操作者与判断层关闭的情形 SHALL 不受影响。

#### Scenario: 未判风险被挡

- **WHEN** 判断层开启、highRiskExtraGates 含 implementing、提案无 risk，且由 agent 推进
- **THEN** 抛出含"必须先判定风险"的错误，并记录 gate-failed 事件

#### Scenario: 判断层关闭时不变

- **WHEN** 判断层关闭
- **THEN** 该守卫不生效，行为与之前一致
