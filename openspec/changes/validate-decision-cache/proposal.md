# 决策缓存命中必须过形状校验

## Why

`DecisionService` 的缓存命中路径把 `CachedDecision` 直接交给 `toOutcome`：
只验 `typeof choice === 'string'`（cache.get），不验 `choice ∈ question.options`、
不验 certainty 是 [0,1] 内的有限数值。`decision-cache.json` 是 fail-open 可写文件
（`~/.dsh/workmate/decision-cache.json`），一条手改/损坏的条目即可让
injection-risk 判 benign、risk-tier 判 low、review-severity 判 LOW——判断层
"只收紧不放松"的前提被缓存旁路。

活的 provider 路径没有这个问题：`parseAnswer` 会把枚举外选择判为无结论。

## What Changes

- 缓存命中 SHALL 过与活路径同级的形状校验：`choice ∈ question.options` 且
  `certainty` 为 [0,1] 内有限数值；不满足 SHALL 按未命中处理（重新判定），
  并 SHALL 在返回的 outcome 外留一条诊断（缓存键 + 原因）。
- 缓存文件类 `get` 保持宽容（形状判定是服务层职责，它才知道 options）。

## Capabilities

### Modified Capabilities

- `decision-layer`：缓存命中补形状校验要求与反证场景。

## Impact

- `src/features/decision/service.ts`（命中路径校验 + 诊断）、
  `src/features/decision/service.test.ts`（篡改缓存用例）。
