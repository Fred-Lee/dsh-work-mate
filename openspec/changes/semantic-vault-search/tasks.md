# Tasks — Semantic Vault Search

- [x] 1. `embedText()` 调 Ollama + `cosine()` + 哈希缓存（fail-open、上限）
- [x] 2. `chunkNote()` H2 分块（行号=块起始行）
- [x] 3. `searchVaultSmart()` 词法优先、语义兜底，回传 engine/indexed/cached
- [x] 4. 配置三项 + 工具 `semantic` 参数 + 命令直通
- [x] 5. 测试：请求体、降级、余弦、缓存命中与模型隔离、预算、分块行号
- [x] 6. 文档 + AGENTS 里程碑；真机演示同义不同词命中
