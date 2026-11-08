# proposal-middleware Delta

## ADDED Requirements

### Requirement: 提案聚合的串行读改写

同一进程内对提案聚合（`proposals.json`）的并发读改写 SHALL 串行执行：
并发更新不同字段 SHALL 全部生效，SHALL NOT 因后写整份覆盖而丢失先写的
决策、审批、卡点或状态迁移。

#### Scenario: 并发决策与状态推进

- **WHEN** agent 追加一条决策的同时编排推进了一步状态
- **THEN** 决策与新状态在聚合中共存，二者都不丢失
