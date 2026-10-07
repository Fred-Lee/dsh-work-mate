# vault-export Specification

## Purpose
TBD - created by archiving change export-wiki-to-vault. Update Purpose after archive.
## Requirements
### Requirement: 项目 wiki 导出到 vault

判断层向宿主发起模型调用时，用户消息的 `content` SHALL 使用内容块数组
（`[{ type: 'text', text }]`，宿主 `TextBlock` 形态），SHALL NOT 传裸字符串——
宿主请求装配与部分适配器会对内容调用 `.some()`。

#### Scenario: 调用形态正确

- **WHEN** 判断层发起一次带工具调用的请求
- **THEN** `messages[0].content` 是数组且首块 `type === 'text'`，适配器不再抛
  `content.some is not a function`

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

在启用 `Config.wikiVaultRerank` 且判断层可用时，语义检索 SHALL 允许用模型对**召回候选**做重排：
模型只在给定候选内选一个最相关者并置顶，SHALL NOT 改变候选集合；
重排结果 SHALL 在说明中标注"首选原第 N 位"。
当模型弃权、越界或调用失败时，实现 SHALL 保持召回顺序，SHALL NOT 丢弃任何命中。

#### Scenario: 模型选中候选

- **WHEN** 重排器返回候选序号 k（0<k<n）
- **THEN** 该候选移到首位，其余保持相对顺序，说明里注明原来位置

#### Scenario: 弃权或异常

- **WHEN** 重排器返回 undefined 或越界序号
- **THEN** 命中顺序与召回结果完全一致，说明中不出现重排字样

### Requirement: 注入判定在所有创建入口生效

创建提案的**任何**入口（工具与 REST）SHALL 在启用判断层时执行 `injection-risk` 判定，
SHALL 写入对应的 `decision` 事件，并 SHALL 在判定为 `risky`（或调用方声明 provenance）时
把 `provenance.untrusted` 落到提案记录上。入口之间 SHALL NOT 存在"有判定/无判定"的行为差异。

#### Scenario: 工具入口同样受保护

- **WHEN** 通过 `workmate_proposal_create` 创建带可疑外部文本的提案且判断层已启用
- **THEN** 产生 `injection-risk` 判定与 `decision` 事件；判定为 `risky` 时提案带 `untrusted` 标记

