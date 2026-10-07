## MODIFIED Requirements

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
