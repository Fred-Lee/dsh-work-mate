## ADDED Requirements

### Requirement: 风险未判定不得通过高风险门

拒绝代理人推进时的错误信息 SHALL 说明两点：判断层停留在 `review` 档时实现不会写入风险
（设计 D2：只有 `act` 档结论成为事实），以及**该守卫只约束 agent，人类可在面板直接推进**。
实现 SHALL NOT 因该守卫把人类操作者也挡在门外。

#### Scenario: review 档时说明出路

- **WHEN** 代理人推进被该守卫拒绝
- **THEN** 错误信息同时包含 "review" 档说明与"人类可直接推进"的提示

#### Scenario: 人类不受限

- **WHEN** 人类操作者推进同一状态
- **THEN** 该守卫不介入（是否放行由配置的批准门决定）
