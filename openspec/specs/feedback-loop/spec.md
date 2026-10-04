# feedback-loop Specification

## Purpose
TBD - created by archiving change add-feedback-loop. Update Purpose after archive.
## Requirements
### Requirement: 提案来源与关联

提案记录 SHALL 支持 `source`（`spec` | `incident` | `review-finding` |
`metric-regression` | `maintenance`）、`sourceRef`（外部引用）与 `relatesTo`（关联提案
id 列表）；创建入口 SHALL 接受这些字段，且更新已有提案时 SHALL 只在入参显式给出时覆盖
既有值。

#### Scenario: 从事故开提案

- **WHEN** 以 `source: incident`、`sourceRef: INC-42`、`relatesTo: p-old` 创建提案
- **THEN** 提案记录带上三个字段，且 `workmate_proposal_status` 能看到它们

#### Scenario: 重跑创建不清空溯源

- **WHEN** 对已有提案再次调用创建（入参不含 `source`）
- **THEN** 既有 `source` / `sourceRef` / `relatesTo` 保持不变

### Requirement: Provenance 与不可信标注

提案 SHALL 能记录 `provenance: { capturedAt, contentHash?, untrusted? }`；当
`untrusted: true` 时，生成的 `proposal.md` SHALL 显式标注该来源为外部不可信输入，
且该标注 SHALL 只作可见性声明，不改变任何权限或门禁判定。

#### Scenario: 外部文本派生的提案被标注

- **WHEN** 以 `untrusted: true` 创建提案并生成 OpenSpec 目录
- **THEN** `proposal.md` 的「来源 / Provenance」段写明"外部不可信输入"与抓取时间

### Requirement: 控制带评测

实现 SHALL 由度量样本评测控制带：每项指标取**每提案一个样本**，以除最近
`recentSamples` 之外的样本计算基线与标准差，与最近样本均值比较，按 `direction`
（大者差 / 小者差）落 1σ / 2σ / 3σ 分级；样本数不足 `minBaselineSamples` 时 SHALL
返回 `insufficient-data` 且 SHALL NOT 判为越界；标准差为 0 且当前值与基线不等时
SHALL 按 3σ 处理并保留 `sigma: 0`。

#### Scenario: 样本不足不误报

- **WHEN** 历史样本少于 8 个
- **THEN** 该指标结论为 `insufficient-data`，不产生越界

#### Scenario: 超标分级

- **WHEN** 最近 5 个样本均值高于基线 2.5 个标准差（大者差指标）
- **THEN** 该指标 tier 为 `diagnose`

### Requirement: 越界留痕与回流

评测结果 SHALL 以 `band-breach` 事件写入提案事件流；当且仅当调用方显式要求 `apply`
且某指标落到 `propose` 档时，实现 SHALL 自动创建一个 draft 提案（`source:
metric-regression`，provenance 记越界事实）；默认调用 SHALL 只读、SHALL NOT 创建任何提案。

#### Scenario: 默认只读

- **WHEN** 不带 `apply` 调用 `workmate_bands`
- **THEN** 返回评测结果与事件留痕，不创建提案

#### Scenario: 3σ 且 apply 时回流

- **WHEN** 某指标为 `propose` 档且调用方传 `apply: true`
- **THEN** 新建一个 draft 提案，其 `source` 为 `metric-regression`，
  provenance 含指标名、当前值、基线与标准差

