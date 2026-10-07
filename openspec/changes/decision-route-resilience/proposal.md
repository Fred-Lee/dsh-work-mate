# Decision Route Resilience

## Why

30 分钟的实测把判断层失败收敛到**路由解析**这一处，且暴露了最后一个静默出口：

- 配 `decisionLlmProvider: deepseek` 后，本轮导出的 18 次判断**一条诊断都没有**（08:18Z 之后为 0），
  也没有缓存、没有边 → 说明 `resolveRoute()` 返回 undefined，**调用根本没发出**，而这条退出路径
  **不留任何痕迹**（此前只给"调用失败"留痕，没给"没调用"留痕）。
- 更早的 64 条诊断显示：`deepseek-account` → `TRANSPORT`（54）、`deepseek-official` → `model not found`（4）、
  `deepseek` → 空流（6）。即：**默认取第一个 provider 会失败，而写错 provider 名会彻底不调用**。

## What Changes

1. **"没调用"也留痕**：`ask()` 在 `route === undefined` 时写入诊断，含 `wantedProvider` / `wantedModel` /
   `listed`（每个 provider 的 id、name、models 数量与首模型样例）→ 一次运行就能看到真实的 provider id。
2. **provider 匹配更宽容**：精确 id/name → 包含式匹配 → 都不中则**回退首个 provider**，
   并记录一条 `route` 诊断说明发生了回退（可见，不静默）。
3. **无模型也要说清**：provider 没有模型且未配置 model 时记录原因，而不是返回 undefined。

## Impact

- `src/features/decision/agent.ts` + 2 个用例；判断语义、阈值与 `act` 采信纪律均不变。
