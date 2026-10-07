# Multi-Route Fallback for the Judgement Layer

## Why

真机诊断给出了重排失败的**确切原因**（`chunksSeen=1`，`finishKind=error`）：

```json
{"provider":"deepseek-account","model":"deepseek-v4-pro",
 "finishFailure":{"message":"Sign in to DeepSeek to use the account provider.",
                  "code":"ACCOUNT_SIGN_IN_REQUIRED"}}
```

即：路由解析到了**需要账号登录的 provider**（`deepseek-account`），本部署用不了；
而此前实现只解析**一条**路由 → 该 provider 不可用时整个判断直接失败。

同时暴露上一版"宽容匹配"的缺陷：`'deepseek'` 与 `deepseek-account` 互相 `includes`，
于是被贪心匹配到**恰好不可用**的那条路由。

## What Changes

1. `resolveRoute` → **`resolveRoutes`**：返回**有序候选**（精确 id/name 优先，其余按注册顺序），
   每个 provider 单独解析模型（无模型者跳过并记录）；
2. `ask()` 改为**逐路由尝试**：某条路由零答案（登录要求 / 传输失败 / 空流）就自动换下一条，
   第一条给出答案的路由胜出；全部失败仍返回无结论（不抛错、仍写诊断）；
3. 弃权时由 `decision` 服务按阈值判 `review`/`abstain`，语义不变。

## Impact

- `src/features/decision/agent.ts` + 2 个用例（首条不可用→次条作答；精确匹配仍优先）。
- 判断节点（含 `search-rerank`）从此不再被单条坏路由拖死。
