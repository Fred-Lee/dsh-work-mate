# vault-export Specification

## Purpose
TBD - created by archiving change export-wiki-to-vault. Update Purpose after archive.
## Requirements
### Requirement: 项目 wiki 导出到 vault

实现 SHALL 把项目的 GitNexus wiki 导出为 Obsidian/Tolaria 兼容的 markdown 笔记：
每个模块一篇笔记、一篇 `index.md` 索引、迭代笔记、以及追加式 `changelog.md`；
笔记 SHALL 带 YAML front-matter，索引与迭代笔记 SHALL 使用 `[[wikilink]]` 形成可浏览的图谱。

迭代数据源 SHALL 包含两路：WorkMate 提案（声明式：`depends_on` 来自 `relatesTo`、
`supersedes` 来自决策链）与 **OpenSpec 归档变更**（历史式：目录名给日期与 id、`#` 标题、
`## Why` 首行作摘要、`## Impact` 中的代码路径作 `touches`、`[proposal:<id>]` 提交标记）。
按时间推导出的上一迭代 SHALL 记为 `sequence` 并在 front-matter 标记 `derived: true`；
实现 SHALL NOT 把推导关系写成 `depends_on`。

#### Scenario: 无提案但有归档

- **WHEN** 项目从未使用 WorkMate 提案，但 `openspec/changes/archive/` 有历史变更
- **THEN** 导出产生对应的迭代笔记（含日期与摘要），索引列出它们，且 `depends_on` 为空

#### Scenario: 派生的血缘被标注

- **WHEN** 多个迭代按日期排序
- **THEN** 除最早一个外，每个迭代的 front-matter 含 `sequence` 指向上一迭代且 `derived: true`

#### Scenario: 提案优先

- **WHEN** 同一 id 既有提案记录又有归档记录
- **THEN** 使用提案记录（声明式依赖保留）

### Requirement: Vault 视图笔记

导出 SHALL 为每个项目生成 `views.md` 与 vault 级 `_views.md`；`index.md` SHALL 额外包含
「模块热度」小节，按被迭代触及的次数排序并给出最近一次触及的迭代 id；
热度 SHALL 只统计确实连到模块的迭代，SHALL NOT 为未触及的模块编造行。

判断层归类的调用次数 SHALL 由 `Config.wikiVaultClassifyMax` 控制（默认 20），
且 SHALL 只采信 `act` 档结论。

#### Scenario: 热度可读

- **WHEN** 有迭代通过路径/token 或判断层连到模块
- **THEN** `index.md` 的模块热度表列出这些模块及触及迭代数，并按次数降序

#### Scenario: 预算生效

- **WHEN** `classifyMax` 为 2 且有 3 个待归类迭代
- **THEN** 最多调用 2 次判断层，结果中出现的模块链接只来自这 2 次的 `act` 结论

### Requirement: Vault 词法检索

实现 SHALL 提供在 vault 内按关键词检索的能力，返回文件与行号及片段，支持结果上限与项目限定；
无命中或 vault 缺失时 SHALL 返回说明而非报错。

在配置了本地嵌入模型（`Config.wikiVaultEmbeddingModel`）时，实现 SHALL 额外支持语义检索，
并 SHALL 采用**词法优先**策略：词法有命中时 SHALL 直接返回词法结果；
仅在词法无命中（或调用方显式要求语义）时才使用嵌入，结果 SHALL 说明所用引擎；
语义命中 SHALL 引用**分块起始行**，SHALL NOT 声称精确到句。
嵌入调用失败 SHALL 降级为说明并保留词法结果，SHALL NOT 抛错；
单次运行的**新嵌入数量** SHALL 有上限。

#### Scenario: 词法优先

- **WHEN** 词法检索有命中
- **THEN** 返回词法结果，`engine` 为 `lexical`，不调用嵌入模型

#### Scenario: 语义兜底

- **WHEN** 词法无命中且配置了嵌入模型、Ollama 可用
- **THEN** 返回语义命中（行号为分块起始行），`engine` 为 `semantic`

#### Scenario: Ollama 不可用

- **WHEN** 嵌入调用失败
- **THEN** 结果保留词法（空）结果并给出原因说明，不抛错

