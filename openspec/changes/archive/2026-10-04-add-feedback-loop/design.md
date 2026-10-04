# Design — Add Feedback Loop

## D1 来源是字段，不是注释

`source` / `sourceRef` / `relatesTo` 进 `Proposal` 记录（而不是只写在 proposal.md 里）：
这样控制台、度量与将来的 intake 都能按来源聚合（"多少提案来自事故"是流程质量的一等指标）。
合并语义：`upsert` 只在入参显式给出时覆盖（与现有 `projects` / `openspecChangeId` 一致），
避免一次重跑清掉已有溯源。

## D2 不可信输入要显式标注，且只作数据

`provenance.untrusted` 是**声明**，不是权限系统：它让审查者与 agent 一眼看出"这段文本来自
外部抓取，不能当指令"。与 [P2] 的 "draw the boundary around access and actions, not around
a model's instructions" 对应——真正的边界仍靠工具面与人工审批，标注只负责让它可见。

## D3 控制带用 JSON 而不是 YAML

[P1] 的示例是 `bands.yaml`。本插件运行时不带 YAML 解析器（`dependencies` 只有
schemastery），为一个配置文件引入解析依赖不划算。语义照搬、方言改 JSON：
`$DSH_HOME/<workmateHome>/bands.json`，缺失即用内建默认值；**文件存在但损坏则 fail-closed
报错**（与 `proposals.json` 同一纪律：能报错就不静默用默认值）。

## D4 基线怎么算（v1 口径，明确写死）

- **样本** = 每个提案一个值（不是每个事件），避免"提案越多事件越多"把分布拉偏。
- **baseline** = 除最近 `recentSamples`（默认 5）之外的样本的均值与总体标准差；
  样本数 < `minBaselineSamples`（默认 8）→ `insufficient-data`，**不判越界**。
  （早期数据不足时报越界是最容易让人不再信任度量的做法。）
- **current** = 最近 `recentSamples` 个样本的均值。
- **direction**：`cycleTime` / `rework` / `gateFailures` 是"大者差"，
  `firstPass` 是"小者差"。偏离量 = `(current - mean) / sigma`（按 direction 取号）。
- **tier**：|偏离| ≥ 3σ → `propose`；≥ 2σ → `diagnose`；≥ 1σ → `log`；否则 `normal`。
- σ = 0 时（样本完全一致）：偏离判为 0，除非 current 与均值不等，此时按 3σ 处理并标注
  `sigma: 0`——这条边界必须显式，否则会静默漏报。

明确不做：Western Electric 规则的连点/趋势检测（v1 只做单点分级）、按团队/仓库分层
（等提案量上来再加维度）。

## D5 3σ 的自动动作只到"开一个 draft 提案"

playbook 的 3σ 是 `routes: [pull_request, runbook:rollback-deploy]`。本插件只做**可回滚的
第一跳**：创建 draft 提案（`source: metric-regression`，provenance 带违约指标、当前值、
基线、σ、样本数），把后续判断留给人与既有八态流程。自动改代码或自动发布都不在范围内。
`apply` 必须显式传（工具参数或 REST 查询参数），默认只读——[P1] 的 2σ tier 是"只读诊断"，
默认只读与它一致。
