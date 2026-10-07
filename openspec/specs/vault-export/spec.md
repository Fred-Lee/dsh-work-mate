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

导出 SHALL 为每个项目生成 `views.md`，并在 vault 子目录根生成 `_views.md`；
视图笔记 SHALL 只查询导出器写入的 front-matter 字段，SHALL 在未安装 Dataview 时给出
可手读的替代说明。

#### Scenario: 视图可用且不臆造字段

- **WHEN** 导出完成
- **THEN** `views.md` 含按日期排序的迭代查询、按年分组、被触及最多的模块与模块清单，
  且不引用从未写入的字段

### Requirement: Vault 词法检索

实现 SHALL 提供在 vault 内按关键词检索的能力，返回**文件与行号**及片段，
支持结果上限与项目限定；无命中或 vault 缺失时 SHALL 返回说明而非报错；
实现 SHALL NOT 声称做过语义/向量检索。

#### Scenario: 返回可引用的位置

- **WHEN** 用关键词检索已导出的 vault
- **THEN** 每条命中含相对文件路径与 1 起始行号，按匹配度排序

#### Scenario: 诚实报告空结果

- **WHEN** 关键词无命中，或 vault 路径不存在
- **THEN** 返回空命中列表与说明文本

