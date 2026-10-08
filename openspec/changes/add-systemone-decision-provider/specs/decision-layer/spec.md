## MODIFIED Requirements

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
