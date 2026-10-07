# Classify Diagnostics, Vector Fallback, Event Traces and REST Coverage

## Why

审计发现四个缺陷（P0/P1，均有实测证据）：

1. **判断层静默无作为**：`~/.dsh/workmate/decision-cache.json` 不存在、`events.jsonl` 里
   `decision` 事件为 0 → 62 个迭代的判断层归类一条边都没补上，而导出返回里**没有任何字段**
   说明归类做了什么。
2. **留痕有洞**：`decision.decide()` 有 5 个调用点，只有 3 个写 `decision` 事件——
   **归档编排的审查分级**与**导出归类**无留痕。
3. **入口覆盖不一致**：`/workmate search` 不支持 `--semantic`；REST 只有 `POST /api/wiki`，
   导出与检索没有端点。
4. **本地向量能力闲置**：bge-m3 索引已在缓存里，却没有用来补归类。

## What Changes

1. **向量兜底归类（零 token）**：迭代标题+摘要与 13 个模块名的本地嵌入做余弦，
   ≥0.55 才连边（低于阈值宁可留白）；**优先于判断层**，判断层只在向量无解时按预算调用。
2. **`classify` 诊断**：导出返回 `classify: {pathMatched, vectorMatched, llmAsked, llmMatched,
   unanswered, llm: 'ok'|'missing'}`，并把明细（含 `llmReachable`）写进一条聚合 `decision` 事件。
3. **补齐留痕**：归档编排的每次分级判断写 `decision` 事件（含 node/action/choice/certainty/
   provider/threshold/cached/degraded）。
4. **入口补齐**：`/workmate search --semantic`；REST 新增 `POST /api/wiki/export` 与
   `POST /api/wiki/search`。

## Capabilities

### 修改的能力

- `vault-export`：归类的向量优先策略 + `classify` 诊断 + 聚合判断留痕。
- `vault-search`：命令与 REST 都能请求语义引擎。
- 归档编排：分级判断留下 `decision` 事件。

## Impact

- 改动：`vault.ts`、`embeddings.ts`（复用）、`index.ts`、`api.ts`、`parse.ts`、`definition.ts`。
- 判断层不可用时行为更清晰（`llm: 'missing'` + 事件留痕），不再静默。
