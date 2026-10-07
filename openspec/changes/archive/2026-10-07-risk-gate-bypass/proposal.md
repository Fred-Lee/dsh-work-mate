# Close the Unassessed-Risk Gate Bypass

## Why

真机验收时发现一条**真实的门禁绕过路径**：

`LifecycleServiceImpl.gateReason()` 只在 `proposal.risk === 'high'` 时才要求人工批准。
而 `risk` 只有在**有人主动调用** `workmate_assess_risk` 之后才有值 →
**风险未判 = 高风险门形同不存在**。实测：一个从未判过风险的提案，**代理人径直推进到了
`implementing`**（配置里 `highRiskExtraGates: ['implementing']` 完全没生效）。

## What Changes

`assertApproval` 增加前置守卫：当**判断层开启**（`riskGateEnabled`）且目标状态在
`highRiskExtraGates` 内、而 `proposal.risk === undefined` 且**操作者是 agent** 时，
**拒绝推进**并给出可操作提示（先调用 `workmate_assess_risk`），同时写入 `gate-failed` 事件
（gate 名 `risk-unassessed`）。

- 人类操作者不受影响（仍可自行决定）；
- 判断层关闭时行为不变（没有风险概念，门禁无从谈起）；
- `allowAgentApproval=true` 仍是显式放弃该分离的开关。

## Impact

- `src/features/archive/service.ts`（守卫 + deps 字段）、`src/index.ts`（传 `riskGateEnabled`）+ 2 个用例。
