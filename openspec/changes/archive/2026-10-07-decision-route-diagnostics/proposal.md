# Decision Route Diagnostics

## Why

实测定位到"判断层静默无作为"的根因：`llmReachable=true`、`llmAsked=18`、`llmMatched=0`，
且 `decision-cache.json` 始终不生成 → agent provider 拿到了 llm 句柄，但 `resolveRoute()`
要求**非空 model**；`decisionModel` 未配置时回退到 provider 的模型列表，本机为空 →
路由解析失败 → `ask()` 返回 undefined，**既不报错也不留痕**。

## What Changes

1. 聚合 `decision` 事件的 detail 增加 `listedProviders` / `listedModels` / `model`，
   路由失败现场可复查。
2. 导出返回在"问了但零命中"时给出可操作 note（先查 `decisionModel` 与 provider 模型列表）。
3. profile 补 `decisionModel: deepseek-flash`。

## Impact

- `src/index.ts`（诊断与 note）；配置在 `~/.dsh/profiles/web/cordis.patch.yml`。
- 不改判断语义：仍然只有 `act` 档结论才连边。
