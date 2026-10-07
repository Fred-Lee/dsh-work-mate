# vault-export Specification

## Purpose
TBD - created by archiving change export-wiki-to-vault. Update Purpose after archive.
## Requirements
### Requirement: 项目 wiki 导出到 vault

导出 SHALL 在结果中报告归类的实际情况（`classify`：路径命中 / 向量命中 / 判断层询问与命中 /
未归类 / 判断层是否可用），SHALL NOT 在归类无作为时静默返回成功。
迭代到模块的匹配 SHALL 优先使用**本地嵌入**（零 token、可复现），仅在向量无解时才按
`Config.wikiVaultClassifyMax` 调用判断层；低于相似度阈值 SHALL 留空。
每次导出 SHALL 至少写入一条聚合 `decision` 事件记录归类结果。

#### Scenario: 向量优先

- **WHEN** 提供了向量匹配能力且有未归类迭代
- **THEN** 命中即连边，`classify.vectorMatched` 增加，且不调用判断层

#### Scenario: 判断层不可用要说明

- **WHEN** 未提供判断层
- **THEN** `classify.llm` 为 `missing`，未归类数量如实上报

#### Scenario: 归档分级留痕

- **WHEN** 归档编排调用判断层给出结论
- **THEN** `events.jsonl` 追加一条含该提案 id 的 `decision` 事件

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

