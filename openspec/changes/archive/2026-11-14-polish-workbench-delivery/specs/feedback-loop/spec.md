# feedback-loop 变更（delta）

## MODIFIED Requirements

### Requirement: 控制带评测

实现 SHALL 由度量样本评测控制带：每项指标取**每提案一个样本**，以除最近
`recentSamples` 之外的样本计算基线与标准差，与最近样本均值比较，按 `direction`
（大者差 / 小者差）落 1σ / 2σ / 3σ 分级；样本数不足 `minBaselineSamples` 时 SHALL
返回 `insufficient-data` 且 SHALL NOT 判为越界；标准差为 0 且当前值与基线不等时
SHALL 按 3σ 处理并保留 `sigma: 0`。`insufficient-data` 的 `note` SHALL 用中文
说明基线门槛与实际样本数（需多少、差多少），SHALL NOT 只给面向开发者的英文串
让面板无从展示。

#### Scenario: 样本不足不误报

- **WHEN** 历史样本少于 8 个
- **THEN** 该指标结论为 `insufficient-data`，不产生越界，note 说明「基线样本不足：至少 8 条，当前 N 条」

#### Scenario: 超标分级

- **WHEN** 最近 5 个样本均值高于基线 2.5 个标准差（大者差指标）
- **THEN** 该指标 tier 为 `diagnose`
