# decision-layer Delta

## ADDED Requirements

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
