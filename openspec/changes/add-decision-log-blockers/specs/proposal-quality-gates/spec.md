## ADDED Requirements

### Requirement: 决策日志

提案 SHALL 支持追加决策条目（`decisions: [{id, decision, rationale, supersedes?, at}]`）：
Agent 经 `workmate_proposal_decide` 或 REST `POST /:id/decisions` 写入；`supersedes`
SHALL 指向同一提案内存在的旧条目 id（显式推翻），指向不存在的条目 SHALL 被拒绝。
详情 SHALL 返回完整决策日志；面板 SHALL 以时间线渲染并在 supersedes 时标注被推翻
条目。任何提案状态 SHALL 允许追加决策。

#### Scenario: 决策显式推翻

- **WHEN** Agent 对同一提案先落决策 D1 再落 D2 并声明 supersedes=D1
- **THEN** 日志含两条，D2 标注推翻 D1，时间序正确

#### Scenario: 悬空 supersedes 被拒

- **WHEN** supersedes 指向不存在的条目 id
- **THEN** 返回可读错误，日志不变

### Requirement: 卡点上报与解除

提案 SHALL 支持卡点上报（`blockers: [{id, question, tried?, answer?, status, at, answeredAt?}]`）：
Agent 经 `workmate_proposal_block` 上报（问题 + 已尝试），条目状态 `open`；
经 `workmate_proposal_unblock` 携带答复解除为 `resolved` 并记录 `answer` 与
`answeredAt`。面板 SHALL 将 open 卡点红色置顶、resolved 灰色带答案展示。
目标项目默认配置 SHALL 注入纪律：「同一方向卡两轮必须上报，禁止第三轮盲试」。

#### Scenario: 卡点往返

- **WHEN** Agent 上报卡点后用户经面板或 Agent 携带答复解除
- **THEN** 卡点状态 open→resolved，答案随条目持久化，面板红色转灰

#### Scenario: 旧提案读取兼容

- **WHEN** 读取不含新字段的旧 proposals.json
- **THEN** decisions/blockers 读作空数组，一切读写正常
