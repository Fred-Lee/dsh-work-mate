## ADDED Requirements

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
