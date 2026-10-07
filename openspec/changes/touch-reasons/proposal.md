# State Why Every Module Edge Exists

## Why

迭代→模块的边来自四条不同强度的证据（路径命中 / token 命中 / 本地向量相似 / 判断层归类），
但笔记里只显示一个 `[[模块]]` 链接——读者（和 AI）无法判断这条边**有多可靠**，
而 token 命中恰是我反复标注为"可能误连"的那一类。

## What Changes

1. `VaultIterationInput` 增加 `touchReasons`（`path` / `token` / `vector` / `llm`），
   向量与判断层命中在写入时记录理由；
2. 渲染时每条边标注来源：`[[模块]]（路径命中 | token 命中 | 向量相似 | 判断层归类）`；
3. 段落标题由「由 Impact 推导」改为「**含匹配理由**」——不再暗示全部来自 Impact；
4. front-matter 的 `touches` 保持为纯 slug/名称（便于 Dataview 查询），不掺入标注。

## Impact

- `src/features/wiki/vault.ts` + 1 个用例；`touchedUnique`/热度统计会剥掉标注后缀，指标不变。
