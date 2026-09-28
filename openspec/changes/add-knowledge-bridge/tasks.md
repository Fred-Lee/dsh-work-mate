# Tasks — Add Knowledge Bridge

- [x] 1. `src/features/knowledge-bridge/gitnexus.ts`：execFile 封装（argv 数组、
      cwd=projectRoot、超时）+ query/context/impact/analyze 四个动作
- [x] 2. `src/features/knowledge-bridge/weknora.ts`：fetch 检索（AbortSignal 超时、
      非 2xx 降级、Top-K 片段提取）
- [x] 3. `src/index.ts`：注册 `workmate_knowledge_query` / `workmate_knowledge_search`
- [x] 4. 单测：CLI 封装（假 gitnexus 脚本）、WeKnora 客户端（mock fetch）、降级路径
- [ ] 5. 真机冒烟：对已索引仓库跑 `workmate_knowledge_query`
