# 讲清 knowledge_query 的语言边界（不做 CJK 全量改造）

## Why

真机冒烟暴露：`workmate_knowledge_query` 的 **`context` / `impact`（符号名）完全正常**（实测
`YueJuanConsumerService` 返回 `status: found` / `epistemic: exact` + 方法与属性），但 **`query` 用中文概念
命中为空**——GitNexus 全文索引需要 `GITNEXUS_FTS_CJK_SEGMENTATION=bigram`。

评估后**不做全量改造**，理由：① 中文模糊检索已被 `workmate_wiki_search`（bge-m3 + 重排）覆盖且更贴合
Obsidian 知识面；② 全量改造要付 `analyze --force` 重建 + analyze/查询两处环境一致性成本；
③ 风险面（全局 FTS 设置变更）。改为**把边界讲清**，避免使用者误判"功能坏了"。

## What Changes

1. 工具描述写明：优先用**符号名**（context/impact 精确且不受语言影响）；中文模糊检索改用
   `workmate_wiki_search`；看到 CJK warning ≠ 功能失效；
2. 工具返回把 GitNexus 的 `warning` **提到顶层**（原本埋在 `output` JSON 字符串里，容易被忽略）；
3. README 补「graph 查询 vs vault 检索」分工表。

## Impact

- `src/index.ts`（描述 + warning 提顶层）、`README.md`。行为不变（只是可发现性）。
