---
paths:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.py"
  - "**/*.go"
  - "**/*.java"
---

# 知识桥接纪律（GitNexus / WeKnora）

> 适用于任何编码会话。WorkMate 的知识工具：`workmate_knowledge_query`（GitNexus）、
> `workmate_knowledge_search`（WeKnora）。

1. **先查后写**：修改一个你不确定影响面的模块前，先用
   `workmate_knowledge_query(action="impact", target="<符号>")` 做影响面分析；
   新任务开始前用 `action="context"` 建立符号 360 度视图。
2. **超时与降级**：GitNexus CLI 默认 30s 超时、WeKnora 10s。工具返回
   `note` 字段时视为「本次知识不可用」，**继续按保守方案执行并说明**，
   不要反复重试同一个查询。
3. **索引前置检查**：如果 `note` 提示未索引（gitnexus analyze 从未在该仓库
   运行），先提示用户运行索引，再继续知识查询；不要把空结果当作「无关联」。
4. **归档等待**：归档编排（openspec archive → gitnexus analyze）由 WorkMate
   host 半执行；Agent 不要手动跑 `gitnexus analyze`，等归档编排完成后再做
   依赖新索引的查询。
5. **结果可溯源**：向用户转述知识查询结论时必须带出处（符号名 / 流程名 / 片段），
   禁止无出处断言。
