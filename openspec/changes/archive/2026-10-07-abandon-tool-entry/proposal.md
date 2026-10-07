# Give Agents the Abandon Entry (with Honest Attribution)

## Why

「终止」目前只有**面板**与 **REST** 两个入口，都是人类身份。孤儿提案的清理本该可以由 agent
在获得授权后完成，但缺工具入口；而且 `abandon` 的事件里 **actor 被硬编码成 `human`**——
agent 调用时会**伪造归属**，破坏审计可信度。

## What Changes

1. `ProposalService.abandon(id, reason, actor = 'human')`：actor 可传，事件如实记录；
2. 新增工具 **`workmate_proposal_abandon`**（`id` + 必填 `reason`），调用时以 **`actor: 'agent'`** 记账；
3. 用例：agent 终止记 `agent`、默认仍记 `human`；工具计数 19 → 20。

## Impact

- `src/features/proposal/service.ts`、`src/index.ts`（新工具）、`src/index.test.ts`（计数）、
  `src/features/proposal/service.test.ts`（归属用例）。
- 语义不变：仍不跑归档编排、仍必填原因、仍拒绝重复终止。
