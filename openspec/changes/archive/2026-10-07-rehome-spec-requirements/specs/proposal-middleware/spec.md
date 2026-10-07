## ADDED Requirements

### Requirement: 孤儿提案的终止出口

实现 SHALL 提供工具入口 `workmate_proposal_abandon`（`id` 与非空 `reason`），
该入口 SHALL 以 `actor: 'agent'` 写入 `transition` 事件；面板与 REST 入口 SHALL 以 `actor: 'human'` 记账。
实现 SHALL NOT 把 agent 的终止动作记为 human。

#### Scenario: 归属不造假

- **WHEN** agent 通过工具终止一个提案
- **THEN** 事件的 `actor` 为 `agent`；同理由面板终止时为 `human`
