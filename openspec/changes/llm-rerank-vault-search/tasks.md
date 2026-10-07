# Tasks — LLM Rerank for Vault Search

- [x] 1. `applyRerank` 纯函数（越界/abstain 保持原序）
- [x] 2. `rerank` 钩子接入 `searchVaultSmart`
- [x] 3. 判断节点 `search-rerank` + 配置 `wikiVaultRerank`
- [x] 4. 工具/命令/REST 三入口统一接入
- [x] 5. 用例：选中移首位并注明；undefined/0/越界不动
- [x] 6. 重启后真机对比重排前后排序
