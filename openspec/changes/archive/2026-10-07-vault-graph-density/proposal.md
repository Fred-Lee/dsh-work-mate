# Vault Graph Density: Module Heat, Classify Budget, Chinese Embeddings

## Why

用户看到 `views.md` 的表格后指出"这不是图"。实际边已存在（61 条时间血缘 + 13 模块挂索引），
但三个点让图不够有用：① 迭代→模块的边此前为 0（已在上一轮用 token 匹配补到 42 篇）；
② 判断层归类每次导出只允许 20 次，62 个迭代跑不完；③ `nomic-embed-text` 对短中文查询排序一般。

## What Changes

1. **模块热度**：`index.md` 新增「模块热度（被多少次迭代触及）」表（模块 / 触及迭代数 / 最近一次），
   把图上的中心度变成可读的一屏；只统计真能连到模块的迭代，未触及的模块不出现。
2. **归类预算可配**：`Config.wikiVaultClassifyMax`（默认 20；本机设为 80，一轮覆盖 62 个迭代），
   仍只采信判断层的 `act` 档。
3. **中文嵌入换 bge-m3**：`wikiVaultEmbeddingModel: bge-m3`（Ollama），语义检索排序更适配中文；
   缓存按 `sha256(model+text)` 隔离，换模型不会混用旧向量。

## Capabilities

### 修改的能力

- `vault-export`：索引页的模块热度小节；归类预算配置化。
- `vault-search`：默认本地嵌入模型由 `nomic-embed-text` 换为 `bge-m3`。

## Impact

- 改动：`vault.ts`（热度统计与渲染、classifyMax）、`config.ts`、`index.ts`、profile、README/AGENTS。
- 纯增量：未配置判断层/嵌入时行为不变。
