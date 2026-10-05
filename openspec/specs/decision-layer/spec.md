# decision-layer Specification

## Purpose
TBD - created by archiving change add-decision-layer. Update Purpose after archive.
## Requirements
### Requirement: 类型化判断题与 provider

实现 SHALL 提供判断层，接受 `{node, state, question, options}` 形式的题目并返回固定选项
之一；provider SHALL 可选 `agent`（宿主 LLM，约束为一次强制工具调用）、`rules`
（确定性兜底）与 `jev`（接口占位，未配置即不可用）；`agent` provider SHALL 支持多采样
并把一致率作为 certainty 代理，SHALL 记录采样次数。

#### Scenario: 强制工具调用给出选项

- **WHEN** 用 `agent` provider 问一个两项选择的节点
- **THEN** 返回的选项落在给定枚举内，`certainty` 为多数票占比

#### Scenario: 答不出不算答对

- **WHEN** 模型没有给出可解析的工具调用
- **THEN** 该 provider 判定为无结论（继续降级），SHALL NOT 用默认选项充数

### Requirement: 阈值动作与降级

实现 SHALL 由配置阈值计算动作：`certainty ≥ act → act`、`≥ review → review`、
否则 `abstain`；provider 不可用/超时/无结论时 SHALL 继续下一个 provider，
全部失败 SHALL 返回 `abstain` 并给出理由；动作 SHALL NOT 由 provider 决定。

#### Scenario: 降级到 rules

- **WHEN** `agent` provider 不可用而 `rules` 有结论
- **THEN** 返回 rules 的结论，并标记 `degraded` 与 `provider: rules`

#### Scenario: 全链失败即弃权

- **WHEN** 所有 provider 都无结论
- **THEN** 动作为 `abstain`，`choice` 为空

### Requirement: 判断只收紧不放松

判断层 SHALL NOT 用于放行任何确定性门禁原本会拒绝的操作；在
`workmate_proposal_decide` 上，当判断为"与既有决策矛盾"且动作为 `act` 且调用方未提供
`supersedes` 时，实现 SHALL 拒绝该次追加并提示补 `supersedes`；判断层未启用或结论为
`abstain`/`review` 时，原有机械校验行为 SHALL 保持不变。

#### Scenario: 静默推翻被拒

- **WHEN** 判断层启用且新决策被判为矛盾、未带 supersedes
- **THEN** 追加被拒，错误信息要求补 supersedes

#### Scenario: 未启用时行为不变

- **WHEN** `Config.decision.enabled` 为 false
- **THEN** decide 的行为与未引入判断层时一致

### Requirement: 判断留痕

每次判断 SHALL 向提案事件流追加一条 `kind: "decision"` 事件，含节点、选项、动作、
certainty、provider、采样数、阈值、耗时与降级理由。

#### Scenario: 事件可见

- **WHEN** 一次判断完成
- **THEN** `events.jsonl` 中出现对应 `decision` 事件，字段可读

