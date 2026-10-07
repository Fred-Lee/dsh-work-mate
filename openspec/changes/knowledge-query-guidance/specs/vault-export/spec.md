## MODIFIED Requirements

### Requirement: Vault 词法检索

`workmate_knowledge_query` 返回结果 SHALL 把 GitNexus 的索引级告警（如 CJK 分词未开启）**提升到顶层字段**
`warning`；工具描述 SHALL 说明：符号名查询（`context` / `impact`）精确且不受语言影响，
中文模糊检索应使用 `workmate_wiki_search`，且出现 CJK 告警不代表工具失效。

#### Scenario: 中文告警可见

- **WHEN** 以中文概念执行 `query` 且索引未开启 bigram 分词
- **THEN** 返回对象顶层含 `warning`，其内容说明需要 GITNEXUS_FTS_CJK_SEGMENTATION=bigram
