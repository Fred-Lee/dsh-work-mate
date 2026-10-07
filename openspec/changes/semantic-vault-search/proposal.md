# Semantic Vault Search with Local Ollama Embeddings

## Why

`workmate_wiki_search` 目前是词法检索：**同义不同词**（"阅卷并发" vs "批改锁竞争"）命中不到。
用户明确同意在本地启用 Ollama 承担向量模型。本机已装 Ollama 与 `nomic-embed-text`（768 维，
`POST /api/embeddings` 实测可用）。

## What Changes

1. **本地嵌入**（`embeddings.ts`）：调用 Ollama `/api/embeddings`；**按 `sha256(model+text)` 缓存**
   （`<workmateHome>/wiki-embeddings.json`，原子写、fail-open、上限淘汰），零新依赖。
2. **分块**：按 H2 边界切块（上限 60 行，过短丢弃），语义命中引用**分块起始行**——
   不假装精确到句。
3. **策略：词法优先、语义兜底**（`searchVaultSmart`）：词法有命中就直接返回（可解释）；
   词法 0 命中且配置了模型时才走向量；结果里回传 `engine` 说明本次用了哪个引擎。
4. **配置**：`wikiVaultEmbeddingModel`（空=关闭）/ `wikiVaultOllamaUrl` /
   `wikiVaultEmbeddingCache`；工具加 `semantic: true` 参数（显式走语义）。
5. 预算与降级：单次最多 400 条新嵌入；Ollama 不可用 → 返回说明并保留词法结果，绝不抛错。

## Capabilities

### 修改的能力

- `vault-search`：加入本地嵌入语义检索与"词法优先"策略，并明确标注引擎。

## Impact

- 新增 `embeddings.ts` / `semantic.ts` 与测试；`config.ts` 三项；`index.ts`（工具/命令）。
- 无 Ollama 或未配置模型时行为与之前一致（纯词法）。
