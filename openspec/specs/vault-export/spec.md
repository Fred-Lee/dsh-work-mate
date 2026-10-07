# vault-export Specification

## Purpose
TBD - created by archiving change export-wiki-to-vault. Update Purpose after archive.
## Requirements
### Requirement: 项目 wiki 导出到 vault

判断层的诊断记录 SHALL 区分"适配器未产生任何流块"（`chunksSeen === 0`，记为
`empty stream (no chunk at all)`）与"产生了块但没有工具调用"（记为
`no tool-call emitted (model answered in text?)`），SHALL 记录 `chunksSeen` 字段。

#### Scenario: 空流可辨认

- **WHEN** 适配器返回的流里没有任何块
- **THEN** 诊断记录 `chunksSeen: 0` 且 failure 为 `empty stream (no chunk at all)`

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

使用模型重排时，实现 SHALL 为**每一次**重排尝试写入一条 `decision` 事件
（含 `node: 'search-rerank'`、`action`、`choice`、`certainty`、`provider`），
在模型弃权或调用失败时 SHALL 记录 `action: 'abstain'`。
实现 SHALL NOT 让"是否调用了重排、选中了第几位"只能靠输出顺序猜测。

#### Scenario: 重排被观测

- **WHEN** 启用重排并执行一次语义检索
- **THEN** 事件流出现 `search-rerank` 记录；选中首位时 `choice` 为 `"1"` 且命中顺序不变

### Requirement: 注入判定在所有创建入口生效

创建提案的**任何**入口（工具与 REST）SHALL 在启用判断层时执行 `injection-risk` 判定，
SHALL 写入对应的 `decision` 事件，并 SHALL 在判定为 `risky`（或调用方声明 provenance）时
把 `provenance.untrusted` 落到提案记录上。入口之间 SHALL NOT 存在"有判定/无判定"的行为差异。

#### Scenario: 工具入口同样受保护

- **WHEN** 通过 `workmate_proposal_create` 创建带可疑外部文本的提案且判断层已启用
- **THEN** 产生 `injection-risk` 判定与 `decision` 事件；判定为 `risky` 时提案带 `untrusted` 标记

