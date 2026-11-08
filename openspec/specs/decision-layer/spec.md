# decision-layer Specification

## Purpose
TBD - created by archiving change add-decision-layer. Update Purpose after archive.
## Requirements
### Requirement: 类型化判断题与 provider

实现 SHALL 提供判断层，接受 `{node, state, question, options}` 形式的题目并返回固定选项
之一；provider SHALL 可选 `agent`（宿主 LLM，约束为一次强制工具调用）、`rules`
（确定性兜底）与 `jev`（TypeSafe System One 客户端，baseUrl 可配：云 Jev 或本机 Ollama）；
`agent` provider SHALL 支持多采样并把一致率作为 certainty 代理，SHALL 记录采样次数。
`jev` provider SHALL 在未配置 baseUrl 或模型名时报告自身不可用，SHALL NOT 阻塞插件装配。

`jev` provider 的 certainty SHALL 取所选选项的概率：`choice` 题型取
`max(probabilities)`，`noul` 题型取 `max(noul, 1 - noul)`；SHALL NOT 使用响应中的
`confidence` 字段作为 certainty（该字段是分布的集中度，不是答案正确的概率）。

`jev` provider SHALL 只返回落在题目 `options` 内的选项；题面 `state` 超出该模型上下文
预算时 SHALL 判定为无结论（继续降级），SHALL NOT 静默截断后作答。

#### Scenario: 强制工具调用给出选项

- **WHEN** 用 `agent` provider 问一个两项选择的节点
- **THEN** 返回的选项落在给定枚举内，`certainty` 为多数票占比

#### Scenario: 答不出不算答对

- **WHEN** 模型没有给出可解析的工具调用
- **THEN** 该 provider 判定为无结论（继续降级），SHALL NOT 用默认选项充数

#### Scenario: System One 的选项概率成为 certainty

- **WHEN** `jev` provider 用一个 `choice` 题目调用 System One，响应给出
  `probabilities: {"high": 0.71, "low": 0.29}` 与 `confidence: 0.42`
- **THEN** 返回 `choice: 'high'`、`certainty: 0.71`，SHALL NOT 返回 `0.42`

#### Scenario: 枚举外的选项视为无结论

- **WHEN** System One 返回的选项不在题目 `options` 内（或响应缺少该题目的字段、不是合法
  JSON、HTTP 非 2xx）
- **THEN** `jev` provider 返回无结论，判断链继续降级，SHALL NOT 回落到 `options[0]`

#### Scenario: 未配置即不可用

- **WHEN** `decisionSystemoneModel` 为空
- **THEN** `jev` provider 的 `available()` 返回 false，插件照常装配并走 `agent` → `rules`

#### Scenario: 题面超限即弃权

- **WHEN** 题面 `state` 超出该模型的上下文预算
- **THEN** `jev` provider 返回无结论并留下诊断，SHALL NOT 截断题面后作答

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

### Requirement: 缓存命中的形状校验

判断缓存命中 SHALL 过形状校验后方可作为结论使用：`choice` SHALL 属于当前题目的
`options`，`certainty` SHALL 为 [0,1] 内的有限数值；不满足 SHALL 按未命中处理
（走 provider 链重算并覆盖写回），SHALL 留一条诊断记录失效原因，
SHALL NOT 把越界或枚举外的缓存值升格为结论。

#### Scenario: 篡改的缓存条目被重算

- **WHEN** `decision-cache.json` 中一条注入判定被手改为 `choice: "benign"、certainty: 1`，
  但当前题目的 options 不含该值或 certainty 越界
- **THEN** 服务按未命中处理，走 provider 链重新判定，缓存被新结论覆盖，诊断留痕

#### Scenario: 合法命中不受影响

- **WHEN** 缓存条目的 choice 与 certainty 均在合法范围
- **THEN** 命中返回，`cached: true`，行为与引入校验前一致

